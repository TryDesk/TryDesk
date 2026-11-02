// trydesk-service.exe — the TryDesk Windows service (runs as LocalSystem).
//
// Keeps one unattended TryDesk host running in the session that owns the screen, as SYSTEM, so the PC stays
// reachable after a restart, when nobody is logged in, and when a Remote Desktop session is disconnected:
//   · picks the session to serve: an Active session (console first, then RDP), else the console session
//     (login screen);
//   · starts "<TryDesk.exe> --service-host" there with the service's own SYSTEM token moved into that
//     session, inside a job object, so the whole Electron process tree goes when it is stopped;
//   · restarts it when it exits (with a growing pause) and moves it when the session to serve changes.
// The host it starts lets in a viewer with the access password, otherwise it shows the Accept dialog on the user's
// desktop (see main.js --service-host); it uses the ID the user's TryDesk had (identity.json, --user-profile=).
//
// Usage (administrator):
//   trydesk-service.exe install "<path to TryDesk.exe>" [passwordHash]
//       copies that TryDesk folder to %ProgramFiles%\TryDesk Service, stores the access password hash, creates +
//       starts the service (auto start). The service runs only that copy: a folder the user can write to would
//       let any program swap TryDesk.exe and get SYSTEM.
//   trydesk-service.exe set-password <hash|none>   store (or remove) the access password, restart the service
//   trydesk-service.exe uninstall          stop + delete it, remove the copy and the stored password
//   trydesk-service.exe run                what the Service Control Manager starts
// Data: %ProgramData%\TryDesk, writable by SYSTEM and Administrators only (users may read service-id.txt).
// Log: %ProgramData%\TryDesk\service.log
#define NOMINMAX
#include <windows.h>
#include <wtsapi32.h>
#include <userenv.h>
#include <aclapi.h>
#include <sddl.h>
#include <string>
#include <cstdio>
#include <cwchar>
#include <filesystem>
#pragma comment(lib, "advapi32.lib")
#pragma comment(lib, "wtsapi32.lib")
#pragma comment(lib, "userenv.lib")

static const wchar_t* kName = L"TryDeskService";
static const wchar_t* kDisplay = L"TryDesk Service";
static SERVICE_STATUS_HANDLE g_status = nullptr;
static SERVICE_STATUS g_ss = {};
static HANDLE g_stop = nullptr;      // set when the service must stop
static HANDLE g_wake = nullptr;      // set on a session change: re-check at once

static std::wstring dataDir() {
  wchar_t buf[MAX_PATH]; DWORD n = GetEnvironmentVariableW(L"ProgramData", buf, MAX_PATH);
  std::wstring d = (n && n < MAX_PATH) ? buf : L"C:\\ProgramData";
  d += L"\\TryDesk"; CreateDirectoryW(d.c_str(), nullptr); return d;
}
static void logLine(const wchar_t* fmt, ...) {
  std::wstring p = dataDir() + L"\\service.log";
  // Keep the log small: past 512 KB start over.
  WIN32_FILE_ATTRIBUTE_DATA a; if (GetFileAttributesExW(p.c_str(), GetFileExInfoStandard, &a) && a.nFileSizeLow > 512 * 1024) DeleteFileW(p.c_str());
  FILE* f = nullptr; if (_wfopen_s(&f, p.c_str(), L"a, ccs=UTF-8") || !f) return;
  SYSTEMTIME t; GetSystemTime(&t);
  fwprintf(f, L"[%04d-%02d-%02dT%02d:%02d:%02dZ] ", t.wYear, t.wMonth, t.wDay, t.wHour, t.wMinute, t.wSecond);
  va_list ap; va_start(ap, fmt); vfwprintf(f, fmt, ap); va_end(ap);
  fputwc(L'\n', f); fclose(f);
}

// The TryDesk.exe to start: stored in the service's registry key at install time.
static std::wstring appPath() {
  HKEY k; std::wstring r;
  if (RegOpenKeyExW(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Services\\TryDeskService\\Parameters", 0, KEY_READ, &k) == ERROR_SUCCESS) {
    wchar_t buf[1024]; DWORD sz = sizeof buf, type = 0;
    if (RegQueryValueExW(k, L"App", nullptr, &type, (LPBYTE)buf, &sz) == ERROR_SUCCESS && type == REG_SZ) r = buf;
    RegCloseKey(k);
  }
  return r;
}

// The session to serve: an Active one (console preferred), else the console session (login screen / locked), else
// a disconnected user session (a VM or RDP-only machine can have no console session at all: Windows Sandbox
// after its window was disconnected — the host then ran nowhere).
static DWORD targetSession() {
  DWORD console = WTSGetActiveConsoleSessionId();
  PWTS_SESSION_INFOW list = nullptr; DWORD n = 0, active = 0xFFFFFFFF, disc = 0xFFFFFFFF;
  if (WTSEnumerateSessionsW(WTS_CURRENT_SERVER_HANDLE, 0, 1, &list, &n)) {
    for (DWORD i = 0; i < n; i++) {
      if (list[i].SessionId == 0) continue;
      if (list[i].State == WTSDisconnected && disc == 0xFFFFFFFF) disc = list[i].SessionId;
      if (list[i].State != WTSActive) continue;
      if (list[i].SessionId == console) { active = console; break; }
      if (active == 0xFFFFFFFF) active = list[i].SessionId;
    }
    WTSFreeMemory(list);
  }
  if (active != 0xFFFFFFFF) return active;
  if (console != 0xFFFFFFFF) return console;
  return disc;
}

struct Child { HANDLE proc = nullptr, job = nullptr; DWORD session = 0xFFFFFFFF; };

static void stopChild(Child& c) {
  if (c.job) { TerminateJobObject(c.job, 0); CloseHandle(c.job); c.job = nullptr; }
  if (c.proc) { WaitForSingleObject(c.proc, 5000); CloseHandle(c.proc); c.proc = nullptr; }
  c.session = 0xFFFFFFFF;
}

static bool startChild(Child& c, DWORD session, const std::wstring& app) {
  HANDLE self = nullptr, tok = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_DUPLICATE | TOKEN_QUERY | TOKEN_ASSIGN_PRIMARY | TOKEN_ADJUST_DEFAULT | TOKEN_ADJUST_SESSIONID, &self)) { logLine(L"OpenProcessToken failed %lu", GetLastError()); return false; }
  BOOL ok = DuplicateTokenEx(self, MAXIMUM_ALLOWED, nullptr, SecurityImpersonation, TokenPrimary, &tok);
  CloseHandle(self);
  if (!ok) { logLine(L"DuplicateTokenEx failed %lu", GetLastError()); return false; }
  if (!SetTokenInformation(tok, TokenSessionId, &session, sizeof session)) { logLine(L"SetTokenInformation(session %lu) failed %lu", session, GetLastError()); CloseHandle(tok); return false; }
  void* env = nullptr; CreateEnvironmentBlock(&env, tok, FALSE);
  // Job: the Electron tree (main, GPU, renderer, helper) ends with the job when we stop or move it.
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION li = {}; li.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (job) SetInformationJobObject(job, JobObjectExtendedLimitInformation, &li, sizeof li);
  // The profile of the user in that session: the host takes over the ID that user's TryDesk has been using
  // (identity.json there), so installing the service doesn't change the PC's ID.
  std::wstring profile;
  HANDLE ut = nullptr;
  if (WTSQueryUserToken(session, &ut)) {
    wchar_t p[MAX_PATH]; DWORD n = MAX_PATH;
    if (GetUserProfileDirectoryW(ut, p, &n)) profile = p;
    CloseHandle(ut);
  }
  std::wstring cmd = L"\"" + app + L"\" --service-host";
  if (!profile.empty()) cmd += L" \"--user-profile=" + profile + L"\"";
  std::wstring dir = app.substr(0, app.find_last_of(L"\\/"));
  STARTUPINFOW si = { sizeof si }; si.lpDesktop = const_cast<LPWSTR>(L"winsta0\\default");
  PROCESS_INFORMATION pi = {};
  ok = CreateProcessAsUserW(tok, nullptr, &cmd[0], nullptr, nullptr, FALSE,
                            CREATE_UNICODE_ENVIRONMENT | CREATE_SUSPENDED | CREATE_NO_WINDOW, env, dir.c_str(), &si, &pi);
  DWORD err = GetLastError();
  if (env) DestroyEnvironmentBlock(env);
  CloseHandle(tok);
  if (!ok) { logLine(L"CreateProcessAsUser(session %lu) failed %lu", session, err); if (job) CloseHandle(job); return false; }
  if (job) AssignProcessToJobObject(job, pi.hProcess);
  ResumeThread(pi.hThread); CloseHandle(pi.hThread);
  c.proc = pi.hProcess; c.job = job; c.session = session;
  logLine(L"host started in session %lu (pid %lu)", session, pi.dwProcessId);
  return true;
}

static void worker() {
  Child c; DWORD pause = 2000; std::wstring app = appPath();
  if (app.empty() || GetFileAttributesW(app.c_str()) == INVALID_FILE_ATTRIBUTES) logLine(L"TryDesk.exe not found: '%s'", app.c_str());
  for (;;) {
    DWORD want = targetSession();
    if (c.proc && c.session != want) { logLine(L"session %lu -> %lu: moving the host", c.session, want); stopChild(c); pause = 2000; }
    if (c.proc && WaitForSingleObject(c.proc, 0) == WAIT_OBJECT_0) {
      DWORD code = 0; GetExitCodeProcess(c.proc, &code); logLine(L"host exited (code %lu)", code); stopChild(c);
    }
    if (!c.proc && want != 0xFFFFFFFF && !app.empty()) {
      if (startChild(c, want, app)) pause = 2000; else pause = std::min<DWORD>(pause * 2, 60000);
    }
    HANDLE w[2] = { g_stop, g_wake };
    DWORD r = WaitForMultipleObjects(2, w, FALSE, c.proc ? 2000 : pause);
    if (r == WAIT_OBJECT_0) break;
  }
  stopChild(c);
  logLine(L"service stopping");
}

static void setState(DWORD s) { g_ss.dwCurrentState = s; SetServiceStatus(g_status, &g_ss); }

static DWORD WINAPI handler(DWORD ctrl, DWORD, LPVOID, LPVOID) {
  switch (ctrl) {
    case SERVICE_CONTROL_STOP: case SERVICE_CONTROL_SHUTDOWN: setState(SERVICE_STOP_PENDING); SetEvent(g_stop); return NO_ERROR;
    case SERVICE_CONTROL_SESSIONCHANGE: SetEvent(g_wake); return NO_ERROR;
    case SERVICE_CONTROL_INTERROGATE: return NO_ERROR;
  }
  return ERROR_CALL_NOT_IMPLEMENTED;
}

static void WINAPI serviceMain(DWORD, LPWSTR*) {
  g_status = RegisterServiceCtrlHandlerExW(kName, handler, nullptr);
  if (!g_status) return;
  g_ss.dwServiceType = SERVICE_WIN32_OWN_PROCESS;
  g_ss.dwControlsAccepted = SERVICE_ACCEPT_STOP | SERVICE_ACCEPT_SHUTDOWN | SERVICE_ACCEPT_SESSIONCHANGE;
  g_stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  g_wake = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  setState(SERVICE_RUNNING);
  logLine(L"service running");
  worker();
  setState(SERVICE_STOPPED);
}

// Owner Administrators, protected DACL, reset on everything below: a folder a normal user made beforehand (with
// their own service.json or files) keeps nothing of theirs. host = the service host's own data (its ID keys):
// SYSTEM + Administrators only; the top folder is readable by users (service-id.txt, service.log).
static bool trustedOwner(const std::wstring& dir) {
  PSID owner = nullptr; PSECURITY_DESCRIPTOR sd = nullptr;
  if (GetNamedSecurityInfoW(dir.c_str(), SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, nullptr, nullptr, nullptr, &sd) != ERROR_SUCCESS) return false;
  bool ok = IsWellKnownSid(owner, WinLocalSystemSid) || IsWellKnownSid(owner, WinBuiltinAdministratorsSid);
  LocalFree(sd); return ok;
}
static bool lockDown(const std::wstring& dir, bool usersRead) {
  // A folder (or link) planted there by a normal user is moved aside unread, never trusted or followed.
  DWORD attr = GetFileAttributesW(dir.c_str());
  if (attr != INVALID_FILE_ATTRIBUTES && ((attr & FILE_ATTRIBUTE_REPARSE_POINT) || !(attr & FILE_ATTRIBUTE_DIRECTORY) || !trustedOwner(dir))) {
    if (attr & FILE_ATTRIBUTE_REPARSE_POINT) RemoveDirectoryW(dir.c_str());
    else MoveFileExW(dir.c_str(), (dir + L".untrusted-" + std::to_wstring(GetTickCount64())).c_str(), 0);
    if (GetFileAttributesW(dir.c_str()) != INVALID_FILE_ATTRIBUTES) return false;
  }
  CreateDirectoryW(dir.c_str(), nullptr);
  PSECURITY_DESCRIPTOR sd = nullptr;
  const wchar_t* sddl = usersRead ? L"O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FRFX;;;BU)" : L"O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)";
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &sd, nullptr)) return false;
  BOOL present = FALSE, def = FALSE; PACL dacl = nullptr; PSID owner = nullptr;
  GetSecurityDescriptorDacl(sd, &present, &dacl, &def); GetSecurityDescriptorOwner(sd, &owner, &def);
  DWORD r = TreeSetNamedSecurityInfoW(const_cast<LPWSTR>(dir.c_str()), SE_FILE_OBJECT,
                                      OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION,
                                      owner, nullptr, dacl, nullptr, TREE_SEC_INFO_RESET, nullptr, ProgressInvokeNever, nullptr);
  LocalFree(sd);
  return r == ERROR_SUCCESS;
}

static std::wstring copyDir() {
  wchar_t buf[MAX_PATH]; DWORD n = GetEnvironmentVariableW(L"ProgramFiles", buf, MAX_PATH);
  return std::wstring((n && n < MAX_PATH) ? buf : L"C:\\Program Files") + L"\\TryDesk Service";
}

static bool validHash(const wchar_t* h) {
  if (wcslen(h) != 97 || h[32] != L':') return false;
  for (int i = 0; i < 97; i++) if (i != 32 && !iswxdigit(h[i])) return false;
  return true;
}

// Stops the service (if any) so its copy of TryDesk is not in use.
static void stopService(SC_HANDLE scm) {
  SC_HANDLE s = OpenServiceW(scm, kName, SERVICE_STOP | SERVICE_QUERY_STATUS);
  if (!s) return;
  SERVICE_STATUS st; ControlService(s, SERVICE_CONTROL_STOP, &st);
  for (int i = 0; i < 60 && QueryServiceStatus(s, &st) && st.dwCurrentState != SERVICE_STOPPED; i++) Sleep(250);
  CloseServiceHandle(s);
}

static int install(const wchar_t* srcExe, const wchar_t* hash) {
  namespace fs = std::filesystem;
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CREATE_SERVICE);
  if (!scm) { fwprintf(stderr, L"OpenSCManager failed %lu (run as administrator)\n", GetLastError()); return 1; }
  if (hash && !validHash(hash)) { fwprintf(stderr, L"bad password hash\n"); CloseServiceHandle(scm); return 2; }
  std::wstring data = dataDir();
  if (!lockDown(data, true) || !lockDown(data + L"\\service-host", false)) { fwprintf(stderr, L"could not secure %s\n", data.c_str()); CloseServiceHandle(scm); return 1; }
  stopService(scm);
  // Fresh copy of the TryDesk folder in Program Files (writable by administrators only).
  fs::path src = fs::path(srcExe).parent_path(), dst = copyDir();
  std::error_code ec;
  if (fs::equivalent(src, dst, ec)) { fwprintf(stderr, L"run install from TryDesk's own folder, not the service copy\n"); CloseServiceHandle(scm); return 2; }
  ec.clear();
  fs::remove_all(dst, ec);
  fs::copy(src, dst, fs::copy_options::recursive | fs::copy_options::overwrite_existing, ec);
  // The Setup version's uninstaller belongs to that install, not to this copy.
  std::error_code ec2; fs::remove(dst / L"Uninstall TryDesk.exe", ec2); fs::remove(dst / L"uninstallerIcon.ico", ec2);
  fs::path app = dst / fs::path(srcExe).filename();
  fs::path self = dst / L"resources" / L"app.asar.unpacked" / L"src" / L"native" / L"trydesk-service.exe";
  if (ec || !fs::exists(app) || !fs::exists(self)) { fwprintf(stderr, L"copy to %s failed (%hs)\n", dst.c_str(), ec.message().c_str()); CloseServiceHandle(scm); return 1; }
  // service.json lives in service-host (SYSTEM + Administrators only): the hash in it is what a viewer must prove,
  // so a normal user on this PC must not be able to read it.
  if (hash) {
    FILE* f = nullptr;
    if (_wfopen_s(&f, (data + L"\\service-host\\service.json").c_str(), L"w") || !f) { fwprintf(stderr, L"could not write service.json\n"); CloseServiceHandle(scm); return 1; }
    fwprintf(f, L"{\"passwordHash\":\"%s\"}\n", hash); fclose(f);
  }
  DeleteFileW((data + L"\\service.json").c_str());   // where versions before 1.3.3 kept it (readable by users)
  std::wstring bin = L"\"" + self.wstring() + L"\" run";
  SC_HANDLE s = CreateServiceW(scm, kName, kDisplay, SERVICE_ALL_ACCESS, SERVICE_WIN32_OWN_PROCESS, SERVICE_AUTO_START,
                               SERVICE_ERROR_NORMAL, bin.c_str(), nullptr, nullptr, nullptr, nullptr, nullptr);
  if (!s && GetLastError() == ERROR_SERVICE_EXISTS) {
    s = OpenServiceW(scm, kName, SERVICE_ALL_ACCESS);
    if (s) ChangeServiceConfigW(s, SERVICE_NO_CHANGE, SERVICE_AUTO_START, SERVICE_NO_CHANGE, bin.c_str(), nullptr, nullptr, nullptr, nullptr, nullptr, nullptr);
  }
  if (!s) { fwprintf(stderr, L"CreateService failed %lu\n", GetLastError()); CloseServiceHandle(scm); return 1; }
  SERVICE_DESCRIPTIONW d = { const_cast<LPWSTR>(L"Keeps this PC reachable with TryDesk (lock screen, login screen, after a restart). Connections need the access password.") };
  ChangeServiceConfig2W(s, SERVICE_CONFIG_DESCRIPTION, &d);
  // Restart it if it ever crashes.
  SC_ACTION acts[3] = { { SC_ACTION_RESTART, 5000 }, { SC_ACTION_RESTART, 5000 }, { SC_ACTION_RESTART, 30000 } };
  SERVICE_FAILURE_ACTIONSW fa = {}; fa.dwResetPeriod = 86400; fa.cActions = 3; fa.lpsaActions = acts;
  ChangeServiceConfig2W(s, SERVICE_CONFIG_FAILURE_ACTIONS, &fa);
  HKEY k;
  if (RegCreateKeyExW(HKEY_LOCAL_MACHINE, L"SYSTEM\\CurrentControlSet\\Services\\TryDeskService\\Parameters", 0, nullptr, 0, KEY_WRITE, nullptr, &k, nullptr) == ERROR_SUCCESS) {
    std::wstring a = app.wstring();
    RegSetValueExW(k, L"App", 0, REG_SZ, (const BYTE*)a.c_str(), (DWORD)((a.size() + 1) * sizeof(wchar_t)));
    RegCloseKey(k);
  }
  BOOL started = StartServiceW(s, 0, nullptr);
  DWORD err = started ? 0 : GetLastError();
  CloseServiceHandle(s); CloseServiceHandle(scm);
  if (!started && err != ERROR_SERVICE_ALREADY_RUNNING) { fwprintf(stderr, L"StartService failed %lu\n", err); return 1; }
  wprintf(L"installed and started\n"); return 0;
}

// The access password set in the app ("none" removes it), then a restart so the host reads it.
static int setPassword(const wchar_t* hash) {
  bool none = !wcscmp(hash, L"none");
  if (!none && !validHash(hash)) { fwprintf(stderr, L"bad password hash\n"); return 2; }
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  if (!scm) { fwprintf(stderr, L"OpenSCManager failed %lu (run as administrator)\n", GetLastError()); return 1; }
  std::wstring data = dataDir();
  if (!lockDown(data, true) || !lockDown(data + L"\\service-host", false)) { fwprintf(stderr, L"could not secure %s\n", data.c_str()); CloseServiceHandle(scm); return 1; }
  std::wstring file = data + L"\\service-host\\service.json";
  DeleteFileW((data + L"\\service.json").c_str());   // pre-1.3.3 location, readable by users
  if (none) DeleteFileW(file.c_str());
  else {
    FILE* f = nullptr;
    if (_wfopen_s(&f, file.c_str(), L"w") || !f) { fwprintf(stderr, L"could not write service.json\n"); CloseServiceHandle(scm); return 1; }
    fwprintf(f, L"{\"passwordHash\":\"%s\"}\n", hash); fclose(f);
  }
  stopService(scm);
  SC_HANDLE s = OpenServiceW(scm, kName, SERVICE_START);
  BOOL ok = s && StartServiceW(s, 0, nullptr);
  if (s) CloseServiceHandle(s);
  CloseServiceHandle(scm);
  wprintf(ok ? L"password %s\n" : L"password saved, service not restarted\n", none ? L"removed" : L"set");
  return 0;
}

static int uninstall() {
  SC_HANDLE scm = OpenSCManagerW(nullptr, nullptr, SC_MANAGER_CONNECT);
  if (!scm) { fwprintf(stderr, L"OpenSCManager failed %lu (run as administrator)\n", GetLastError()); return 1; }
  stopService(scm);
  SC_HANDLE s = OpenServiceW(scm, kName, DELETE);
  BOOL ok = TRUE;
  if (s) { ok = DeleteService(s); CloseServiceHandle(s); }
  CloseServiceHandle(scm);
  // The copy and the stored password go; the host's data (its TryDesk ID) stays for a later reinstall.
  std::error_code ec; std::filesystem::remove_all(copyDir(), ec);
  std::wstring data = dataDir();
  DeleteFileW((data + L"\\service.json").c_str()); DeleteFileW((data + L"\\service-id.txt").c_str());
  wprintf(ok ? L"removed\n" : L"remove failed %lu\n", GetLastError()); return ok ? 0 : 1;
}

int wmain(int argc, wchar_t** argv) {
  if (argc >= 2 && !wcscmp(argv[1], L"run")) {
    SERVICE_TABLE_ENTRYW t[] = { { const_cast<LPWSTR>(kName), serviceMain }, { nullptr, nullptr } };
    return StartServiceCtrlDispatcherW(t) ? 0 : 1;
  }
  if (argc >= 3 && !wcscmp(argv[1], L"install")) return install(argv[2], argc >= 4 ? argv[3] : nullptr);
  if (argc >= 2 && !wcscmp(argv[1], L"uninstall")) return uninstall();
  if (argc >= 3 && !wcscmp(argv[1], L"set-password")) return setPassword(argv[2]);
  fwprintf(stderr, L"usage: trydesk-service.exe install \"<TryDesk.exe>\" [passwordHash] | set-password <hash|none> | uninstall\n");
  return 2;
}
