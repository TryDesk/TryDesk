// trydesk-capture.exe — TryDesk's fast capture path on Windows (host side).
//
// Chromium's screen capture (Windows Graphics Capture with Windows' default pacing) delivers about 60 new frames a
// second and adds ~35 ms before the picture even reaches the encoder (measured 2026-11-02). This helper skips it:
//   DXGI Desktop Duplication (frames as fast as the monitor refreshes, kept on the GPU)
//   -> cursor drawn in (as Chromium does, so the viewer sees the remote pointer)
//   -> D3D11 video processor BGRA -> NV12 (GPU)
//   -> hardware H.264 encoder (Media Foundation MFT: NVIDIA / AMD / Intel), low-latency mode
//   -> stdout, one packet per encoded frame.
// A frame is sent only when the screen or the cursor changed (an idle desktop costs ~0 bandwidth), paced to --fps.
// It is a separate process on purpose: a driver crash here never takes TryDesk down, and TryDesk falls back to the
// normal WebRTC capture whenever this exits.
//
// Usage: trydesk-capture.exe --rect X,Y,W,H [--fps 240] [--mbps 50]
//   --rect: the monitor in physical desktop pixels (the output whose desktop rectangle matches is captured)
// stdout packets (little-endian): u32 payloadLength, u8 type, u8 flags, u16 reserved, f64 captureEpochMs, payload
//   type 1 = H.264 access unit (Annex-B), flags bit0 = keyframe
//   type 2 = info text (UTF-8 JSON: {"w":..,"h":..,"encoder":".."} once at start)
// stdin: one JSON-ish command per line: {"cmd":"key"} | {"cmd":"rate","mbps":N,"fps":N} | {"cmd":"stop"}
//   with --udp (see trydesk-udp.h): {"cmd":"udpkey","hex":"<64 hex>"} | {"cmd":"peer","ip":"a.b.c.d","port":N} |
//   {"cmd":"udp","on":0|1}. The info packet at start then carries "udpPort"; frames go out on UDP instead of
//   stdout as soon as the viewer's receiver answers, and come back to stdout if it goes quiet.
// --recv --port N: the viewer end. No capture; receives frames on UDP and writes them to stdout as type 1 packets
//   (flags bit1 = a frame before this one was lost). Same stdin commands (udpkey, peer, stop).
// Exit codes: 0 stopped, 2 monitor not found, 3 capture lost (display change / secure desktop), 4 no hardware
// encoder, 5 setup failed.
#define NOMINMAX
#define _WIN32_WINNT 0x0A00   // Windows 10 (MFTEnum2: pick the encoder on the monitor's GPU)
#include "trydesk-udp.h"      // winsock2.h must come before windows.h
#include <windows.h>
#include <d3d11_4.h>
#include <dxgi1_2.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mftransform.h>
#include <mferror.h>
#include <codecapi.h>
#include <icodecapi.h>
#include <wrl/client.h>
#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#include <algorithm>
#include <io.h>
#include <fcntl.h>
#pragma comment(lib, "d3d11.lib")
#pragma comment(lib, "dxgi.lib")
#pragma comment(lib, "mfplat.lib")
#pragma comment(lib, "mfuuid.lib")
#pragma comment(lib, "strmiids.lib")
#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "oleaut32.lib")
#pragma comment(lib, "winmm.lib")

using Microsoft::WRL::ComPtr;
using clk = std::chrono::steady_clock;

static std::mutex g_outLock;
static double epochMs() { FILETIME ft; GetSystemTimePreciseAsFileTime(&ft); ULARGE_INTEGER u; u.LowPart = ft.dwLowDateTime; u.HighPart = ft.dwHighDateTime; return (double)(u.QuadPart - 116444736000000000ULL) / 10000.0; }
static void writePacket(uint8_t type, uint8_t flags, double t, const void* data, uint32_t len) {
  uint8_t hdr[16]; memcpy(hdr, &len, 4); hdr[4] = type; hdr[5] = flags; hdr[6] = hdr[7] = 0; memcpy(hdr + 8, &t, 8);
  std::lock_guard<std::mutex> g(g_outLock);
  if (fwrite(hdr, 1, 16, stdout) != 16 || (len && fwrite(data, 1, len, stdout) != len)) ExitProcess(0);   // TryDesk went away
  fflush(stdout);
}
static void info(const std::string& json) { writePacket(2, 0, epochMs(), json.data(), (uint32_t)json.size()); }
[[noreturn]] static void quit(int code, const char* why) { info(std::string("{\"exit\":") + std::to_string(code) + ",\"why\":\"" + why + "\"}"); fflush(stdout); ExitProcess(code); }

// Commands from TryDesk (stdin), read on their own thread.
static std::atomic<bool> g_stop{ false }, g_wantKey{ false }, g_rateChanged{ false };
static std::atomic<int> g_fps{ 240 }, g_mbps{ 50 };
static int numberAfter(const std::string& s, const char* key) { auto p = s.find(key); if (p == std::string::npos) return -1; p = s.find(':', p); if (p == std::string::npos) return -1; return atoi(s.c_str() + p + 1); }
static std::string stringAfter(const std::string& s, const char* key) { auto p = s.find(key); if (p == std::string::npos) return ""; p = s.find('"', s.find(':', p) + 1); if (p == std::string::npos) return ""; auto e = s.find('"', p + 1); return e == std::string::npos ? "" : s.substr(p + 1, e - p - 1); }
// The UDP link (with --udp on the host, always on the viewer's --recv end); see trydesk-udp.h.
static tdudp::Link g_link; static tdudp::Sender* g_sender = nullptr;
static void readCommands() {
  char line[512];
  while (fgets(line, sizeof line, stdin)) {
    std::string s(line);
    if (s.find("\"stop\"") != std::string::npos) { g_stop = true; break; }
    else if (s.find("\"udpkey\"") != std::string::npos) {
      const std::string hex = stringAfter(s, "\"hex\""); std::vector<uint8_t> key;
      for (size_t i = 0; i + 1 < hex.size() && key.size() < 32; i += 2) key.push_back((uint8_t)strtoul(hex.substr(i, 2).c_str(), nullptr, 16));
      if (!g_link.setKey(key)) info("{\"udp\":\"bad key\"}");
    }
    else if (s.find("\"peer\"") != std::string::npos) { const int port = numberAfter(s, "\"port\""); if (port > 0 && port < 65536) g_link.addCandidate(stringAfter(s, "\"ip\""), (uint16_t)port); }
    else if (s.find("\"udp\"") != std::string::npos) { if (g_sender) g_sender->enabled = numberAfter(s, "\"on\"") != 0; }
    else if (s.find("\"key\"") != std::string::npos) g_wantKey = true;
    else if (s.find("\"rate\"") != std::string::npos) {
      int m = numberAfter(s, "\"mbps\""), f = numberAfter(s, "\"fps\"");
      if (m > 0) g_mbps = std::min(1000, m);
      if (f > 0) g_fps = std::max(1, std::min(240, f));
      g_rateChanged = true;
    }
  }
  g_stop = true;   // stdin closed: TryDesk is gone
}
// --recv: the viewer end of the UDP link. Whole frames go to stdout exactly like captured ones.
static int runRecv(uint16_t port) {
  if (!g_link.open(port, 1)) quit(5, "udp socket");
  info("{\"udpPort\":" + std::to_string(g_link.port()) + "}");
  std::thread(readCommands).detach();
  std::thread([] { while (!g_stop) Sleep(50); ExitProcess(0); }).detach();
  tdudp::Receiver rx(g_link);
  rx.run([](uint8_t flags, double t, const uint8_t* d, uint32_t n) { writePacket(1, flags, t, d, n); }, [](const std::string& j) { info(j); });
  return 0;
}

// --- Cursor: DXGI hands the pointer shape and position separately; it is blended into the frame on the CPU
// (only the pointer's few hundred pixels), the way Chromium's capture shows it.
struct Cursor { std::vector<uint8_t> shape; DXGI_OUTDUPL_POINTER_SHAPE_INFO si{}; POINT pos{}; bool visible = false; };
static void blendCursor(const Cursor& c, uint8_t* px, UINT pitch, int x0, int y0, int w, int h) {
  // px is the w x h region of the desktop (BGRA) whose top-left is (x0,y0) on screen; the pointer's top-left is c.pos.
  const auto& si = c.si;
  for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
    int cx = x0 + x - c.pos.x, cy = y0 + y - c.pos.y;
    uint8_t* d = px + y * pitch + x * 4;
    if (si.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_COLOR) {
      if (cx < 0 || cy < 0 || cx >= (int)si.Width || cy >= (int)si.Height) continue;
      const uint8_t* s = c.shape.data() + cy * si.Pitch + cx * 4; unsigned a = s[3];
      for (int k = 0; k < 3; k++) d[k] = (uint8_t)((s[k] * a + d[k] * (255 - a)) / 255);
    } else if (si.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MASKED_COLOR) {
      if (cx < 0 || cy < 0 || cx >= (int)si.Width || cy >= (int)si.Height) continue;
      const uint8_t* s = c.shape.data() + cy * si.Pitch + cx * 4;
      if (s[3]) { d[0] ^= s[0]; d[1] ^= s[1]; d[2] ^= s[2]; } else { d[0] = s[0]; d[1] = s[1]; d[2] = s[2]; }
    } else if (si.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME) {
      const int hh = (int)si.Height / 2;   // AND mask on top, XOR mask below, 1 bit per pixel
      if (cx < 0 || cy < 0 || cx >= (int)si.Width || cy >= hh) continue;
      const uint8_t andBit = (c.shape[cy * si.Pitch + cx / 8] >> (7 - cx % 8)) & 1;
      const uint8_t xorBit = (c.shape[(cy + hh) * si.Pitch + cx / 8] >> (7 - cx % 8)) & 1;
      for (int k = 0; k < 3; k++) { uint8_t v = andBit ? d[k] : 0; d[k] = xorBit ? (uint8_t)(v ^ 0xFF) : v; }
    }
  }
}
// Encoder events arrive on Media Foundation's own thread: each encoded frame goes to stdout the moment it exists, and
// the capture loop is woken as soon as the encoder can take the next frame. (Polling for that between captures held
// 240 fps down to ~140, measured.)
class EncoderEvents : public IMFAsyncCallback {
 public:
  EncoderEvents(IMFTransform* enc, IMFMediaEventGenerator* gen) : enc_(enc), gen_(gen) { needEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr); }
  STDMETHODIMP QueryInterface(REFIID iid, void** p) override {
    if (iid == __uuidof(IUnknown) || iid == __uuidof(IMFAsyncCallback)) { *p = static_cast<IMFAsyncCallback*>(this); AddRef(); return S_OK; }
    *p = nullptr; return E_NOINTERFACE;
  }
  STDMETHODIMP_(ULONG) AddRef() override { return ++ref_; }
  STDMETHODIMP_(ULONG) Release() override { return --ref_; }   // lives as long as the process
  STDMETHODIMP GetParameters(DWORD*, DWORD*) override { return E_NOTIMPL; }
  STDMETHODIMP Invoke(IMFAsyncResult* r) override {
    ComPtr<IMFMediaEvent> ev;
    if (FAILED(gen_->EndGetEvent(r, &ev))) return S_OK;
    MediaEventType t; ev->GetType(&t);
    if (t == METransformNeedInput) { needInput++; SetEvent(needEvent); }
    else if (t == METransformHaveOutput) output();
    gen_->BeginGetEvent(this, nullptr);
    return S_OK;
  }
  void start() { gen_->BeginGetEvent(this, nullptr); }
  void submitted(double capturedAt) { std::lock_guard<std::mutex> g(m_); inflight_.push_back(capturedAt); }
  void unsubmitted() { std::lock_guard<std::mutex> g(m_); if (!inflight_.empty()) inflight_.pop_back(); }
  std::atomic<int> needInput{ 0 }, outCount{ 0 };
  HANDLE needEvent;
 private:
  void output() {
    MFT_OUTPUT_DATA_BUFFER ob = {}; DWORD st = 0;
    if (SUCCEEDED(enc_->ProcessOutput(0, 1, &ob, &st)) && ob.pSample) {
      UINT32 key = 0; ob.pSample->GetUINT32(MFSampleExtension_CleanPoint, &key);
      ComPtr<IMFMediaBuffer> mb; ob.pSample->ConvertToContiguousBuffer(&mb);
      BYTE* p; DWORD len;
      if (mb && SUCCEEDED(mb->Lock(&p, nullptr, &len))) {
        double t0;
        { std::lock_guard<std::mutex> g(m_); t0 = inflight_.empty() ? epochMs() : inflight_.front(); if (!inflight_.empty()) inflight_.pop_front(); }
        // With a viewer on the UDP link the frame goes straight out from here; otherwise (no link, link lost, or
        // TryDesk switched it off) through stdout and TryDesk's data channel as before.
        if (g_sender && g_sender->enabled && g_link.up()) g_sender->push(p, len, key != 0, t0);
        else writePacket(1, key ? 1 : 0, t0, p, len);
        outCount++;
        mb->Unlock();
      }
      ob.pSample->Release();
    }
    if (ob.pEvents) ob.pEvents->Release();
  }
  IMFTransform* enc_; IMFMediaEventGenerator* gen_;
  std::atomic<ULONG> ref_{ 1 }; std::mutex m_; std::deque<double> inflight_;
};

static int cursorWidth(const Cursor& c) { return (int)c.si.Width; }
static int cursorHeight(const Cursor& c) { return c.si.Type == DXGI_OUTDUPL_POINTER_SHAPE_TYPE_MONOCHROME ? (int)c.si.Height / 2 : (int)c.si.Height; }

int main(int argc, char** argv) {
  _setmode(_fileno(stdout), _O_BINARY);
  setvbuf(stdout, nullptr, _IOFBF, 1 << 20);
  int rx = 0, ry = 0, rw = 0, rh = 0; bool recv = false, udp = false; int port = 0;
  for (int i = 1; i < argc; i++) {
    if (!strcmp(argv[i], "--recv")) recv = true;
    else if (!strcmp(argv[i], "--udp")) udp = true;
    else if (i + 1 >= argc) break;
    else if (!strcmp(argv[i], "--rect")) sscanf_s(argv[i + 1], "%d,%d,%d,%d", &rx, &ry, &rw, &rh);
    else if (!strcmp(argv[i], "--fps")) g_fps = std::max(1, std::min(240, atoi(argv[i + 1])));
    else if (!strcmp(argv[i], "--mbps")) g_mbps = std::max(1, std::min(1000, atoi(argv[i + 1])));
    else if (!strcmp(argv[i], "--port")) port = std::max(0, std::min(65535, atoi(argv[i + 1])));
  }
  if (recv) return runRecv((uint16_t)port);
  if (FAILED(CoInitializeEx(nullptr, COINIT_MULTITHREADED)) || FAILED(MFStartup(MF_VERSION))) quit(5, "com/mf startup");
  // 1 ms waits must really be 1 ms: with Windows' default 15.6 ms timer, the short waits between frames stretched and
  // held this at ~90 fps (measured). Applies to this process only, for as long as it runs (as games do).
  timeBeginPeriod(1);

  // 1. The output (monitor) whose desktop rectangle is --rect, and the adapter that drives it.
  ComPtr<IDXGIFactory1> factory; if (FAILED(CreateDXGIFactory1(IID_PPV_ARGS(&factory)))) quit(5, "dxgi factory");
  ComPtr<IDXGIAdapter1> adapter; ComPtr<IDXGIOutput> output; DXGI_OUTPUT_DESC od{};
  for (UINT a = 0; !output; a++) {
    ComPtr<IDXGIAdapter1> ad; if (factory->EnumAdapters1(a, &ad) == DXGI_ERROR_NOT_FOUND) break;
    for (UINT o = 0;; o++) {
      ComPtr<IDXGIOutput> out; if (ad->EnumOutputs(o, &out) == DXGI_ERROR_NOT_FOUND) break;
      DXGI_OUTPUT_DESC d; out->GetDesc(&d); const RECT& r = d.DesktopCoordinates;
      const bool match = rw > 0 ? (r.left == rx && r.top == ry && r.right - r.left == rw && r.bottom - r.top == rh)
                                : (r.left == 0 && r.top == 0);   // no --rect: the primary monitor
      if (match && d.AttachedToDesktop) { adapter = ad; output = out; od = d; break; }
    }
  }
  if (!output) quit(2, "monitor not found");
  DXGI_ADAPTER_DESC1 adesc; adapter->GetDesc1(&adesc);

  // 2. D3D11 device on that adapter (video support for the colour conversion; multithread-protected: the encoder
  //    uses it from its own threads).
  ComPtr<ID3D11Device> dev; ComPtr<ID3D11DeviceContext> ctx;
  const bool nullAdapter = getenv("TDC_NULLADAPTER") != nullptr;   // diagnostics A/B
  if (FAILED(D3D11CreateDevice(nullAdapter ? nullptr : adapter.Get(), nullAdapter ? D3D_DRIVER_TYPE_HARDWARE : D3D_DRIVER_TYPE_UNKNOWN, nullptr, D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0, D3D11_SDK_VERSION, &dev, nullptr, &ctx))) quit(5, "d3d11 device");
  { ComPtr<ID3D11Multithread> mt; if (SUCCEEDED(ctx.As(&mt))) mt->SetMultithreadProtected(TRUE); }

  ComPtr<IDXGIOutput1> out1; output.As(&out1);
  ComPtr<IDXGIOutputDuplication> dup;
  // Can fail for a moment (desktop switch, an RDP session settling): a few tries before giving up.
  for (int i = 0; FAILED(out1->DuplicateOutput(dev.Get(), &dup)); i++) { dup.Reset(); if (i >= 9) quit(3, "duplicate output"); Sleep(200); }
  DXGI_OUTDUPL_DESC dd; dup->GetDesc(&dd);
  const UINT W = dd.ModeDesc.Width & ~1u, H = dd.ModeDesc.Height & ~1u;   // NV12/H.264 need even sizes
  if (W > 4096 || H > 4096) quit(4, "resolution above what H.264 hardware encoders take");

  // 3. Hardware H.264 encoder on the same adapter.
  ComPtr<IMFTransform> enc; std::wstring encName;
  {
    MFT_REGISTER_TYPE_INFO outInfo = { MFMediaType_Video, MFVideoFormat_H264 };
    ComPtr<IMFAttributes> want; MFCreateAttributes(&want, 1); want->SetBlob(MFT_ENUM_ADAPTER_LUID, (const UINT8*)&adesc.AdapterLuid, sizeof(LUID));
    IMFActivate** acts = nullptr; UINT32 n = 0;
    const bool enumEx = getenv("TDC_ENUMEX") != nullptr;   // diagnostics A/B
    HRESULT he = enumEx ? MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, nullptr, &outInfo, &acts, &n)
                        : MFTEnum2(MFT_CATEGORY_VIDEO_ENCODER, MFT_ENUM_FLAG_HARDWARE | MFT_ENUM_FLAG_SORTANDFILTER, nullptr, &outInfo, want.Get(), &acts, &n);
    if (FAILED(he) || !n) quit(4, "no hardware H.264 encoder on this GPU");
    wchar_t* name = nullptr; UINT32 nl = 0; if (SUCCEEDED(acts[0]->GetAllocatedString(MFT_FRIENDLY_NAME_Attribute, &name, &nl))) { encName = name; CoTaskMemFree(name); }
    HRESULT hr = acts[0]->ActivateObject(IID_PPV_ARGS(&enc));
    for (UINT32 i = 0; i < n; i++) acts[i]->Release(); CoTaskMemFree(acts);
    if (FAILED(hr)) quit(4, "encoder activate");
  }
  ComPtr<IMFAttributes> ea; enc->GetAttributes(&ea);
  if (ea) { ea->SetUINT32(MF_TRANSFORM_ASYNC_UNLOCK, TRUE); ea->SetUINT32(MF_LOW_LATENCY, TRUE); }
  UINT resetToken; ComPtr<IMFDXGIDeviceManager> dm;
  if (FAILED(MFCreateDXGIDeviceManager(&resetToken, &dm)) || FAILED(dm->ResetDevice(dev.Get(), resetToken)) ||
      FAILED(enc->ProcessMessage(MFT_MESSAGE_SET_D3D_MANAGER, reinterpret_cast<ULONG_PTR>(dm.Get())))) quit(4, "encoder d3d manager");
  ComPtr<ICodecAPI> api; enc.As(&api);
  auto setU4 = [&](const GUID& g, ULONG v) { if (!api) return; VARIANT x; VariantInit(&x); x.vt = VT_UI4; x.ulVal = v; api->SetValue(&g, &x); };
  if (api) { VARIANT x; VariantInit(&x); x.vt = VT_BOOL; x.boolVal = VARIANT_TRUE; api->SetValue(&CODECAPI_AVLowLatencyMode, &x); }
  setU4(CODECAPI_AVEncCommonRateControlMode, eAVEncCommonRateControlMode_CBR);
  setU4(CODECAPI_AVEncCommonMeanBitRate, (ULONG)g_mbps * 1000000);
  setU4(CODECAPI_AVEncMPVDefaultBPictureCount, 0);
  setU4(CODECAPI_AVEncMPVGOPSize, 240 * 4);   // a keyframe every ~4 s of motion; the viewer asks for one after a loss
  {
    ComPtr<IMFMediaType> ot; MFCreateMediaType(&ot);
    ot->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video); ot->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_H264);
    ot->SetUINT32(MF_MT_AVG_BITRATE, g_mbps * 1000000); MFSetAttributeSize(ot.Get(), MF_MT_FRAME_SIZE, W, H);
    MFSetAttributeRatio(ot.Get(), MF_MT_FRAME_RATE, 240, 1); ot->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    ot->SetUINT32(MF_MT_MPEG2_PROFILE, eAVEncH264VProfile_High);
    if (FAILED(enc->SetOutputType(0, ot.Get(), 0))) quit(4, "encoder output type");
    ComPtr<IMFMediaType> it; MFCreateMediaType(&it);
    it->SetGUID(MF_MT_MAJOR_TYPE, MFMediaType_Video); it->SetGUID(MF_MT_SUBTYPE, MFVideoFormat_NV12);
    MFSetAttributeSize(it.Get(), MF_MT_FRAME_SIZE, W, H); MFSetAttributeRatio(it.Get(), MF_MT_FRAME_RATE, 240, 1);
    it->SetUINT32(MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
    if (FAILED(enc->SetInputType(0, it.Get(), 0))) quit(4, "encoder input type");
  }
  ComPtr<IMFMediaEventGenerator> events; if (FAILED(enc.As(&events))) quit(4, "encoder is not asynchronous");
  enc->ProcessMessage(MFT_MESSAGE_COMMAND_FLUSH, 0);
  enc->ProcessMessage(MFT_MESSAGE_NOTIFY_BEGIN_STREAMING, 0);
  enc->ProcessMessage(MFT_MESSAGE_NOTIFY_START_OF_STREAM, 0);

  // 4. GPU surfaces: the clean desktop copy, the frame with the cursor drawn in, a staging patch for the cursor,
  //    and a small ring of NV12 surfaces the encoder reads from.
  ComPtr<ID3D11VideoDevice> vdev; dev.As(&vdev); ComPtr<ID3D11VideoContext> vctx; ctx.As(&vctx);
  if (!vdev || !vctx) quit(5, "video device");
  D3D11_VIDEO_PROCESSOR_CONTENT_DESC cd = { D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE, { 240, 1 }, W, H, { 240, 1 }, W, H, D3D11_VIDEO_USAGE_OPTIMAL_SPEED };
  ComPtr<ID3D11VideoProcessorEnumerator> venum; ComPtr<ID3D11VideoProcessor> vproc;
  if (FAILED(vdev->CreateVideoProcessorEnumerator(&cd, &venum)) || FAILED(vdev->CreateVideoProcessor(venum.Get(), 0, &vproc))) quit(5, "video processor");
  D3D11_TEXTURE2D_DESC td = {}; td.Width = W; td.Height = H; td.MipLevels = 1; td.ArraySize = 1; td.SampleDesc.Count = 1; td.Usage = D3D11_USAGE_DEFAULT; td.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  ComPtr<ID3D11Texture2D> clean, frame;
  td.BindFlags = 0; if (FAILED(dev->CreateTexture2D(&td, nullptr, &clean))) quit(5, "texture");
  td.BindFlags = D3D11_BIND_RENDER_TARGET; if (FAILED(dev->CreateTexture2D(&td, nullptr, &frame))) quit(5, "texture");
  D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC ivd = { 0, D3D11_VPIV_DIMENSION_TEXTURE2D, { 0, 0 } };
  ComPtr<ID3D11VideoProcessorInputView> inView; if (FAILED(vdev->CreateVideoProcessorInputView(frame.Get(), venum.Get(), &ivd, &inView))) quit(5, "input view");
  const int RING = 4; std::vector<ComPtr<ID3D11Texture2D>> nv12(RING); std::vector<ComPtr<ID3D11VideoProcessorOutputView>> outViews(RING);
  for (int i = 0; i < RING; i++) {
    D3D11_TEXTURE2D_DESC nd = td; nd.Format = DXGI_FORMAT_NV12; nd.BindFlags = D3D11_BIND_RENDER_TARGET;
    D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC ovd = { D3D11_VPOV_DIMENSION_TEXTURE2D };
    if (FAILED(dev->CreateTexture2D(&nd, nullptr, &nv12[i])) || FAILED(vdev->CreateVideoProcessorOutputView(nv12[i].Get(), venum.Get(), &ovd, &outViews[i]))) quit(5, "nv12 surface");
  }
  const UINT CUR = 256;   // largest pointer patch handled (Windows pointers are at most 256 px)
  D3D11_TEXTURE2D_DESC sd = {}; sd.Width = CUR; sd.Height = CUR; sd.MipLevels = 1; sd.ArraySize = 1; sd.SampleDesc.Count = 1; sd.Format = DXGI_FORMAT_B8G8R8A8_UNORM; sd.Usage = D3D11_USAGE_STAGING; sd.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  ComPtr<ID3D11Texture2D> curStage; if (FAILED(dev->CreateTexture2D(&sd, nullptr, &curStage))) quit(5, "cursor staging");

  char buf[512];
  if (udp && !g_link.open((uint16_t)port, 0)) { udp = false; info("{\"udp\":\"no socket\"}"); }
  snprintf(buf, sizeof buf, "{\"w\":%u,\"h\":%u,\"refresh\":%u,\"encoder\":\"%ls\",\"adapter\":\"%ls\",\"udpPort\":%u}", W, H,
           dd.ModeDesc.RefreshRate.Numerator / std::max(1u, dd.ModeDesc.RefreshRate.Denominator), encName.c_str(), adesc.Description, udp ? g_link.port() : 0u);
  info(buf);
  if (udp) {
    g_sender = new tdudp::Sender(g_link);   // lives as long as the process
    g_sender->start([] { g_wantKey = true; }, [](bool up) { info(up ? "{\"udp\":\"up\",\"peer\":\"" + g_link.peerText() + "\"}" : "{\"udp\":\"lost\"}"); });
  }
  std::thread(readCommands).detach();

  // 5. Capture loop. Encoded output goes to stdout from the encoder's own thread (EncoderEvents).
  EncoderEvents* encEvents = new EncoderEvents(enc.Get(), events.Get());   // lives as long as the process
  encEvents->start();
  Cursor cursor; bool haveDesktop = false, dirty = false;
  int ring = 0; long long ts100ns = 0;
  auto nextDue = clk::now();
  int lostTries = 0;
  // TDC_DEBUG=1: one info packet a second with what limited the rate (diagnostics only).
  const bool dbg = getenv("TDC_DEBUG") != nullptr; auto dbgAt = clk::now();
  int dDesk = 0, dSubmit = 0, dBusy = 0, dEarly = 0;
  auto dropsAt = clk::now();
  while (!g_stop) {
    if (dbg && clk::now() - dbgAt >= std::chrono::seconds(1)) {
      char d[200]; snprintf(d, sizeof d, "{\"desktop\":%d,\"submitted\":%d,\"encoderBusy\":%d,\"notDue\":%d,\"out\":%d}", dDesk, dSubmit, dBusy, dEarly, encEvents->outCount.exchange(0));
      info(d); dDesk = dSubmit = dBusy = dEarly = 0; dbgAt = clk::now();
    }
    // Frames the UDP sender had to drop (its queue was full): TryDesk lowers the bitrate on these.
    if (g_sender && clk::now() - dropsAt >= std::chrono::seconds(1)) { dropsAt = clk::now(); const int n = g_sender->takeDrops(); if (n) info("{\"udpDrops\":" + std::to_string(n) + "}"); }
    if (g_rateChanged.exchange(false)) setU4(CODECAPI_AVEncCommonMeanBitRate, (ULONG)g_mbps * 1000000);
    // A frame is waiting and only the encoder isn't ready: sleep until it says it is (woken at once, no polling).
    if ((dirty || g_wantKey) && haveDesktop && encEvents->needInput <= 0) { if (dbg) dBusy++; WaitForSingleObject(encEvents->needEvent, 8); }
    // Nothing to send: block until the desktop changes (up to 16 ms, then look at the commands again).
    // Something to send: wait only until it is due.
    const auto now = clk::now();
    UINT waitMs = 16;
    // (rounded UP to whole ms: rounding down to 0 made this spin tens of thousands of times a second, measured)
    if (dirty || g_wantKey) waitMs = now < nextDue ? (UINT)((std::chrono::duration_cast<std::chrono::microseconds>(nextDue - now).count() + 999) / 1000) : 0;
    // Capture was lost (below): get it back before touching it again. A failed DuplicateOutput leaves dup empty,
    // and calling AcquireNextFrame on it crashed the helper (0xC0000005, an RDP PC whose resolution changed).
    if (!dup) {
      Sleep(100);
      if (FAILED(out1->DuplicateOutput(dev.Get(), &dup))) { dup.Reset(); if (++lostTries > 50) quit(3, "capture lost"); continue; }
      DXGI_OUTDUPL_DESC d2; dup->GetDesc(&d2); if ((d2.ModeDesc.Width & ~1u) != W || (d2.ModeDesc.Height & ~1u) != H) quit(3, "display size changed");
      lostTries = 0; continue;
    }
    DXGI_OUTDUPL_FRAME_INFO fi; ComPtr<IDXGIResource> res;
    HRESULT hr = dup->AcquireNextFrame(std::min<UINT>(waitMs, 16), &fi, &res);
    if (hr == DXGI_ERROR_ACCESS_LOST || hr == DXGI_ERROR_INVALID_CALL) {
      // Display mode change, desktop switch (UAC prompt, lock screen) or another full-screen app: try to come back.
      dup.Reset(); continue;
    }
    if (SUCCEEDED(hr)) {
      if (fi.LastPresentTime.QuadPart) { ComPtr<ID3D11Texture2D> tex; res.As(&tex); D3D11_BOX box = { 0, 0, 0, W, H, 1 }; ctx->CopySubresourceRegion(clean.Get(), 0, 0, 0, 0, tex.Get(), 0, &box); haveDesktop = dirty = true; dDesk++; }
      if (fi.LastMouseUpdateTime.QuadPart) { cursor.pos = fi.PointerPosition.Position; cursor.visible = fi.PointerPosition.Visible; dirty = true; }
      if (fi.PointerShapeBufferSize) {
        cursor.shape.resize(fi.PointerShapeBufferSize); UINT got = 0;
        if (SUCCEEDED(dup->GetFramePointerShape(fi.PointerShapeBufferSize, cursor.shape.data(), &got, &cursor.si))) dirty = true;
      }
      dup->ReleaseFrame();
    } else if (hr != DXGI_ERROR_WAIT_TIMEOUT) quit(3, "capture failed");

    const bool keyNow = g_wantKey.load();
    if (dbg && (dirty || keyNow) && haveDesktop && encEvents->needInput > 0 && clk::now() < nextDue) dEarly++;
    if ((dirty || keyNow) && haveDesktop && encEvents->needInput > 0 && clk::now() >= nextDue) {
      dSubmit++;
      const double capturedAt = epochMs();
      ctx->CopyResource(frame.Get(), clean.Get());
      // Draw the pointer: read back its patch, blend on the CPU, write it back.
      const int cw = std::min<int>(cursorWidth(cursor), CUR), ch = std::min<int>(cursorHeight(cursor), CUR);
      static const bool noCursor = getenv("TDC_NOCURSOR") != nullptr;   // diagnostics only
      if (!noCursor && cursor.visible && cw > 0 && ch > 0 && !cursor.shape.empty()) {
        const int x0 = std::max<int>(0, cursor.pos.x), y0 = std::max<int>(0, cursor.pos.y);
        const int x1 = std::min<int>((int)W, cursor.pos.x + cw), y1 = std::min<int>((int)H, cursor.pos.y + ch);
        if (x1 > x0 && y1 > y0) {
          D3D11_BOX box = { (UINT)x0, (UINT)y0, 0, (UINT)x1, (UINT)y1, 1 };
          ctx->CopySubresourceRegion(curStage.Get(), 0, 0, 0, 0, clean.Get(), 0, &box);
          D3D11_MAPPED_SUBRESOURCE m;
          if (SUCCEEDED(ctx->Map(curStage.Get(), 0, D3D11_MAP_READ, 0, &m))) {
            std::vector<uint8_t> patch((size_t)(x1 - x0) * (y1 - y0) * 4);
            for (int y = 0; y < y1 - y0; y++) memcpy(&patch[(size_t)y * (x1 - x0) * 4], (uint8_t*)m.pData + y * m.RowPitch, (size_t)(x1 - x0) * 4);
            ctx->Unmap(curStage.Get(), 0);
            blendCursor(cursor, patch.data(), (x1 - x0) * 4, x0, y0, x1 - x0, y1 - y0);
            ctx->UpdateSubresource(frame.Get(), 0, &box, patch.data(), (x1 - x0) * 4, 0);
          }
        }
      }
      D3D11_VIDEO_PROCESSOR_STREAM stream = {}; stream.Enable = TRUE; stream.pInputSurface = inView.Get();
      if (SUCCEEDED(vctx->VideoProcessorBlt(vproc.Get(), outViews[ring].Get(), 0, 1, &stream))) {
        ComPtr<IMFMediaBuffer> mb; ComPtr<IMFSample> s;
        if (SUCCEEDED(MFCreateDXGISurfaceBuffer(__uuidof(ID3D11Texture2D), nv12[ring].Get(), 0, FALSE, &mb)) && SUCCEEDED(MFCreateSample(&s))) {
          s->AddBuffer(mb.Get());
          const LONGLONG dur = 10000000LL / g_fps; s->SetSampleTime(ts100ns); s->SetSampleDuration(dur); ts100ns += dur;
          if (keyNow) { setU4(CODECAPI_AVEncVideoForceKeyFrame, 1); g_wantKey = false; }
          encEvents->submitted(capturedAt);
          if (SUCCEEDED(enc->ProcessInput(0, s.Get(), 0))) { encEvents->needInput--; dirty = false; ring = (ring + 1) % RING; }
          else encEvents->unsubmitted();
        }
      }
      // A fixed cadence (due += period), not "now + period": the time spent per frame must not add up (it held
      // 240 fps down to ~135, measured). After a quiet spell, restart the cadence from now.
      const auto period = std::chrono::nanoseconds(1000000000LL / g_fps);
      nextDue += period; if (nextDue < clk::now() - period) nextDue = clk::now();
    }
  }
  quit(0, "stopped");
}
