@echo off
rem Builds src\native\trydesk-capture.exe (TryDesk's fast capture helper for Windows) with the MSVC compiler.
rem Needs Visual Studio (Community or Build Tools) with "Desktop development with C++". The C runtime is linked in
rem statically (/MT), so users don't need a Visual C++ redistributable. Run by buat-rilis.ps1 before the app build;
rem without the exe TryDesk still works, just without the fast path (it falls back to WebRTC capture).
setlocal
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" (echo Visual Studio Installer not found & exit /b 1)
for /f "usebackq delims=" %%i in (`"%VSWHERE%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR (echo Visual Studio C++ tools not found & exit /b 1)
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul || exit /b 1
set "SRC=%~dp0..\src\native"
pushd "%SRC%" || exit /b 1
cl /nologo /EHsc /O2 /MT /std:c++20 /W3 /DUNICODE /D_UNICODE trydesk-capture.cpp /Fe:trydesk-capture.exe /link /SUBSYSTEM:CONSOLE || (popd & exit /b 1)
del /q trydesk-capture.obj 2>nul
rem The TryDesk Windows service (unattended access: lock screen, login screen, after a restart).
cl /nologo /EHsc /O2 /MT /std:c++20 /W3 /DUNICODE /D_UNICODE trydesk-service.cpp /Fe:trydesk-service.exe /link /SUBSYSTEM:CONSOLE || (popd & exit /b 1)
del /q trydesk-service.obj 2>nul
popd
echo built src\native\trydesk-capture.exe and trydesk-service.exe
