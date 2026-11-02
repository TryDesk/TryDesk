// trydesk-udp.h — the fast path's own UDP link (Windows host -> Windows viewer), shared by both ends of
// trydesk-capture.exe: the host side sends encoded frames straight from the encoder thread, the viewer side
// (`--recv`) reassembles them and hands whole frames to TryDesk on stdout, in the same packet format as capture.
//
// Why: Chromium's WebRTC data channel tops out near 335 Mbps on one PC and collapses above ~350 (measured 2026-11-02).
// A plain UDP socket has no such ceiling; what limits it is the cable (1 GbE carries ~940 Mbps of payload).
//
// Datagram (little-endian), 20-byte header in the clear but authenticated, then AES-256-GCM payload + 16-byte tag:
//   u8 magic 'T', u8 type, u8 flags, u8 reserved, u32 seq, u16 chunk, u16 chunks, f64 captureEpochMs
//   type 1 = frame chunk (flags bit0 keyframe), 2 = hello, 3 = keepalive / hello-ack, 4 = keyframe request
// Nonce = direction(4) | type(2) | chunk(2) | seq(4): never repeats within one key, and each session has its own
// random key handed over the DTLS-encrypted control channel. A datagram that does not authenticate is dropped,
// so a stranger on the LAN can neither read the picture nor inject frames.
// Hole punching: both ends send hellos to the addresses they were told about; the first authenticated datagram from
// a peer fixes that peer's address (Windows Firewall then also accepts its replies, as for any outbound UDP).
#pragma once
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <bcrypt.h>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdint>
#include <cstring>
#include <deque>
#include <functional>
#include <map>
#include <mutex>
#include <string>
#include <thread>
#include <vector>
#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "bcrypt.lib")

namespace tdudp {
using clk = std::chrono::steady_clock;
constexpr int HDR = 20, TAG = 16, PAYLOAD = 1350;   // 1350 + 20 + 16 + 28 (UDP/IP) < 1500 MTU
constexpr uint8_t T_FRAME = 1, T_HELLO = 2, T_KEEP = 3, T_KEY = 4;

struct Packet { uint8_t type = 0, flags = 0; uint32_t seq = 0; uint16_t chunk = 0, chunks = 0; double t = 0; const uint8_t* data = nullptr; uint32_t len = 0; };

class Link {
 public:
  // dir: 0 = host (sends frames), 1 = viewer (receives). Each direction seals with its own nonce prefix.
  bool open(uint16_t port, uint32_t dir) {
    dir_ = dir;
    WSADATA w; if (WSAStartup(MAKEWORD(2, 2), &w)) return false;
    sock_ = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock_ == INVALID_SOCKET) return false;
    int big = 32 << 20;   // a 1 Gbps burst must not overflow the kernel buffer before our thread gets to it
    setsockopt(sock_, SOL_SOCKET, SO_RCVBUF, (const char*)&big, sizeof big);
    setsockopt(sock_, SOL_SOCKET, SO_SNDBUF, (const char*)&big, sizeof big);
    sockaddr_in a{}; a.sin_family = AF_INET; a.sin_addr.s_addr = INADDR_ANY; a.sin_port = htons(port);
    if (bind(sock_, (sockaddr*)&a, sizeof a)) return false;
    int alen = sizeof a; getsockname(sock_, (sockaddr*)&a, &alen); port_ = ntohs(a.sin_port);
    DWORD tmo = 200; setsockopt(sock_, SOL_SOCKET, SO_RCVTIMEO, (const char*)&tmo, sizeof tmo);
    return true;
  }
  uint16_t port() const { return port_; }
  bool setKey(const std::vector<uint8_t>& key) {
    if (key.size() != 32) return false;
    if (BCryptOpenAlgorithmProvider(&alg_, BCRYPT_AES_ALGORITHM, nullptr, 0)) return false;
    if (BCryptSetProperty(alg_, BCRYPT_CHAINING_MODE, (PUCHAR)BCRYPT_CHAIN_MODE_GCM, sizeof(BCRYPT_CHAIN_MODE_GCM), 0)) return false;
    if (BCryptGenerateSymmetricKey(alg_, &key_, nullptr, 0, (PUCHAR)key.data(), (ULONG)key.size(), 0)) return false;
    hasKey_ = true; return true;
  }
  bool hasKey() const { return hasKey_; }
  // Candidate addresses of the other end (hellos go to all of them until one answers).
  void addCandidate(const std::string& ip, uint16_t port) {
    sockaddr_in a{}; a.sin_family = AF_INET; a.sin_port = htons(port);
    if (inet_pton(AF_INET, ip.c_str(), &a.sin_addr) != 1) return;
    std::lock_guard<std::mutex> g(m_);
    for (auto& c : cands_) if (c.sin_addr.s_addr == a.sin_addr.s_addr && c.sin_port == a.sin_port) return;
    cands_.push_back(a);
  }
  bool up() const { return peerUp_; }
  void dropPeer() { peerUp_ = false; }
  std::string peerText() { std::lock_guard<std::mutex> g(m_); char b[64]; inet_ntop(AF_INET, &peer_.sin_addr, b, sizeof b); return std::string(b) + ":" + std::to_string(ntohs(peer_.sin_port)); }

  // Seal + send one datagram to the peer (or to every candidate while there is no peer yet).
  void send(uint8_t type, uint8_t flags, uint32_t seq, uint16_t chunk, uint16_t chunks, double t, const uint8_t* data, uint32_t len, bool toCandidates = false) {
    if (!hasKey_) return;
    uint8_t buf[HDR + PAYLOAD + TAG];
    if (len > PAYLOAD) return;
    buf[0] = 'T'; buf[1] = type; buf[2] = flags; buf[3] = 0;
    memcpy(buf + 4, &seq, 4); memcpy(buf + 8, &chunk, 2); memcpy(buf + 10, &chunks, 2); memcpy(buf + 12, &t, 8);
    uint8_t nonce[12]; makeNonce(nonce, dir_, type, chunk, seq);
    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info; BCRYPT_INIT_AUTH_MODE_INFO(info);
    info.pbNonce = nonce; info.cbNonce = 12; info.pbAuthData = buf; info.cbAuthData = HDR; info.pbTag = buf + HDR + len; info.cbTag = TAG;
    ULONG out = 0;
    if (BCryptEncrypt(key_, (PUCHAR)data, len, &info, nullptr, 0, buf + HDR, len, &out, 0)) return;
    const int total = HDR + len + TAG;
    std::lock_guard<std::mutex> g(m_);
    if (peerUp_ && !toCandidates) sendto(sock_, (const char*)buf, total, 0, (sockaddr*)&peer_, sizeof peer_);
    else for (auto& c : cands_) sendto(sock_, (const char*)buf, total, 0, (sockaddr*)&c, sizeof c);
  }
  // Blocking receive (200 ms timeout). Returns false on timeout. A good datagram from a new address makes it the peer.
  bool recv(Packet& p, std::vector<uint8_t>& plain) {
    uint8_t buf[HDR + PAYLOAD + TAG + 64];
    sockaddr_in from{}; int fl = sizeof from;
    int n = recvfrom(sock_, (char*)buf, sizeof buf, 0, (sockaddr*)&from, &fl);
    if (n < HDR + TAG || buf[0] != 'T' || !hasKey_) return false;
    const uint32_t len = (uint32_t)n - HDR - TAG;
    if (len > PAYLOAD) return false;
    p.type = buf[1]; p.flags = buf[2]; memcpy(&p.seq, buf + 4, 4); memcpy(&p.chunk, buf + 8, 2); memcpy(&p.chunks, buf + 10, 2); memcpy(&p.t, buf + 12, 8);
    uint8_t nonce[12]; makeNonce(nonce, dir_ ^ 1, p.type, p.chunk, p.seq);
    BCRYPT_AUTHENTICATED_CIPHER_MODE_INFO info; BCRYPT_INIT_AUTH_MODE_INFO(info);
    info.pbNonce = nonce; info.cbNonce = 12; info.pbAuthData = buf; info.cbAuthData = HDR; info.pbTag = buf + HDR + len; info.cbTag = TAG;
    plain.resize(len); ULONG out = 0;
    if (BCryptDecrypt(key_, buf + HDR, len, &info, nullptr, 0, plain.data(), len, &out, 0)) return false;   // not ours
    p.data = plain.data(); p.len = len;
    { std::lock_guard<std::mutex> g(m_); peer_ = from; peerUp_ = true; }
    lastIn_ = clk::now();
    return true;
  }
  double silentSec() const { return std::chrono::duration<double>(clk::now() - lastIn_.load()).count(); }
  void close() { if (sock_ != INVALID_SOCKET) { closesocket(sock_); sock_ = INVALID_SOCKET; } }

 private:
  static void makeNonce(uint8_t* n, uint32_t dir, uint8_t type, uint16_t chunk, uint32_t seq) { memcpy(n, &dir, 4); n[4] = type; n[5] = 0; memcpy(n + 6, &chunk, 2); memcpy(n + 8, &seq, 4); }
  SOCKET sock_ = INVALID_SOCKET; uint16_t port_ = 0; uint32_t dir_ = 0;
  BCRYPT_ALG_HANDLE alg_ = nullptr; BCRYPT_KEY_HANDLE key_ = nullptr; bool hasKey_ = false;
  std::mutex m_; std::vector<sockaddr_in> cands_; sockaddr_in peer_{}; std::atomic<bool> peerUp_{ false };
  std::atomic<clk::time_point> lastIn_{ clk::now() };
};

// ─── Host side: frames queued by the encoder thread, sent by this thread; hellos/keepalives handled here too ───
struct Frame { std::vector<uint8_t> au; bool key; double t; };
class Sender {
 public:
  explicit Sender(Link& l) : link_(l) {}
  void start(std::function<void()> wantKey, std::function<void(bool)> peerChanged) {
    wantKey_ = wantKey; peerChanged_ = peerChanged;
    std::thread([this] { sendLoop(); }).detach();
    std::thread([this] { recvLoop(); }).detach();
  }
  // Called from the encoder thread. Drops when the queue is deep: the link can't carry this bitrate.
  bool push(const uint8_t* au, uint32_t len, bool key, double t) {
    std::lock_guard<std::mutex> g(qm_);
    if (q_.size() >= 8) { drops_++; return false; }
    q_.push_back({ std::vector<uint8_t>(au, au + len), key, t }); cv_.notify_one(); return true;
  }
  int takeDrops() { return drops_.exchange(0); }
  std::atomic<bool> enabled{ true };   // false: TryDesk asked to go back to stdout
 private:
  void sendLoop() {
    auto lastHello = clk::now() - std::chrono::seconds(1);
    for (;;) {
      Frame f; bool have = false;
      { std::unique_lock<std::mutex> lk(qm_); cv_.wait_for(lk, std::chrono::milliseconds(100), [&] { return !q_.empty(); }); if (!q_.empty()) { f = std::move(q_.front()); q_.pop_front(); have = true; } }
      const auto now = clk::now();
      if (!link_.up() || now - lastHello > std::chrono::milliseconds(500)) {   // hellos to candidates until a peer answers; then keepalives
        if (link_.hasKey()) link_.send(link_.up() ? T_KEEP : T_HELLO, 0, ctrlSeq_++, 0, 0, 0, nullptr, 0, !link_.up());
        lastHello = now;
      }
      if (!have) continue;
      if (!link_.up() || !enabled) continue;   // no one listening yet: the frame already went out on stdout
      const uint32_t seq = frameSeq_++;
      const uint16_t chunks = (uint16_t)((f.au.size() + PAYLOAD - 1) / PAYLOAD);
      for (uint16_t i = 0; i < chunks; i++) {
        const uint32_t off = (uint32_t)i * PAYLOAD, len = (uint32_t)std::min<size_t>(PAYLOAD, f.au.size() - off);
        link_.send(T_FRAME, f.key ? 1 : 0, seq, i, chunks, f.t, f.au.data() + off, len);
      }
    }
  }
  void recvLoop() {
    Packet p; std::vector<uint8_t> plain; bool wasUp = false; auto lastKey = clk::now() - std::chrono::seconds(1);
    for (;;) {
      if (link_.recv(p, plain)) {
        if (p.type == T_HELLO) link_.send(T_KEEP, 0, ctrlSeq_++, 0, 0, 0, nullptr, 0);   // answer at once: the viewer learns the link is up
        else if (p.type == T_KEY && clk::now() - lastKey > std::chrono::milliseconds(250)) { lastKey = clk::now(); if (wantKey_) wantKey_(); }
      } else if (link_.up() && link_.silentSec() > 3.0) link_.dropPeer();   // viewer went quiet: back to stdout
      const bool nowUp = link_.up();
      if (nowUp != wasUp) { wasUp = nowUp; if (nowUp && wantKey_) wantKey_(); if (peerChanged_) peerChanged_(nowUp); }
    }
  }
  Link& link_; std::mutex qm_; std::condition_variable cv_; std::deque<Frame> q_;
  std::atomic<int> drops_{ 0 }; uint32_t frameSeq_ = 0, ctrlSeq_ = 0;
  std::function<void()> wantKey_; std::function<void(bool)> peerChanged_;
};

// ─── Viewer side: reassemble chunks into frames, emit them in order; a lost chunk skips to the next keyframe ───
struct Pending { std::vector<std::vector<uint8_t>> parts; uint16_t got = 0; bool key = false; double t = 0; clk::time_point first; };
class Receiver {
 public:
  explicit Receiver(Link& l) : link_(l) {}
  // emit(flags, t, data, len): flags bit0 keyframe, bit1 "a frame before this one was lost"
  void run(std::function<void(uint8_t, double, const uint8_t*, uint32_t)> emit, std::function<void(const std::string&)> info) {
    Packet p; std::vector<uint8_t> plain;
    auto lastKeep = clk::now(), lastInfo = clk::now(); uint32_t lost = 0, frames = 0; bool wasUp = false; bool haveNext = false; uint32_t next = 0;
    for (;;) {
      const auto now = clk::now();
      if (!link_.up() || now - lastKeep > std::chrono::milliseconds(500)) { link_.send(link_.up() ? T_KEEP : T_HELLO, 0, ctrlSeq_++, 0, 0, 0, nullptr, 0, !link_.up()); lastKeep = now; }
      if (link_.up() && link_.silentSec() > 3.0) link_.dropPeer();
      if (link_.up() != wasUp) { wasUp = link_.up(); info(wasUp ? "{\"udp\":\"up\",\"peer\":\"" + link_.peerText() + "\"}" : "{\"udp\":\"lost\"}"); if (wasUp) link_.send(T_KEY, 0, ctrlSeq_++, 0, 0, 0, nullptr, 0); }
      if (now - lastInfo > std::chrono::seconds(1)) { if (lost || frames) info("{\"udpFrames\":" + std::to_string(frames) + ",\"udpLost\":" + std::to_string(lost) + "}"); lost = frames = 0; lastInfo = now; }
      if (!link_.recv(p, plain) || p.type != T_FRAME || !p.chunks || p.chunk >= p.chunks || p.chunks > 1024) continue;
      // Newer than anything seen + 1: start a new frame; too old (already emitted or given up on): ignore.
      if (haveNext && (int32_t)(p.seq - next) < 0) continue;
      auto& f = pend_[p.seq];
      if (f.parts.empty()) { f.parts.resize(p.chunks); f.key = p.flags & 1; f.t = p.t; f.first = now; }
      if (p.chunk < f.parts.size() && f.parts[p.chunk].empty()) { f.parts[p.chunk].assign(p.data, p.data + p.len); f.got++; }
      if (pend_.size() > 64) { pend_.erase(pend_.begin()); lost++; gap_ = true; }
      // Emit every complete frame that is next in line; a frame stuck incomplete for 30 ms (or with newer complete
      // ones piling up) counts as lost: skip it and tell TryDesk, which then asks for a keyframe.
      for (;;) {
        if (!haveNext) { if (pend_.empty()) break; next = pend_.begin()->first; haveNext = true; }
        auto it = pend_.find(next);
        if (it != pend_.end() && it->second.got == it->second.parts.size()) {
          auto& fr = it->second; std::vector<uint8_t> au; size_t len = 0; for (auto& part : fr.parts) len += part.size(); au.reserve(len);
          for (auto& part : fr.parts) au.insert(au.end(), part.begin(), part.end());
          emit((fr.key ? 1 : 0) | (gap_ ? 2 : 0), fr.t, au.data(), (uint32_t)au.size()); gap_ = false; frames++;
          pend_.erase(it); next++; continue;
        }
        const auto oldest = it != pend_.end() ? it->second.first : (pend_.empty() ? now : pend_.begin()->second.first);
        if (!pend_.empty() && (now - oldest > std::chrono::milliseconds(30) || pend_.size() > 8)) {
          if (it != pend_.end()) pend_.erase(it);
          lost++; gap_ = true; next++;
          if (now - lastKeyAsk_ > std::chrono::milliseconds(250)) { lastKeyAsk_ = now; link_.send(T_KEY, 0, ctrlSeq_++, 0, 0, 0, nullptr, 0); }
          if (pend_.empty() || (int32_t)(pend_.begin()->first - next) > 0) { haveNext = !pend_.empty(); if (haveNext) next = pend_.begin()->first; }
          continue;
        }
        break;
      }
    }
  }
 private:
  Link& link_; std::map<uint32_t, Pending> pend_; bool gap_ = false; uint32_t ctrlSeq_ = 0; clk::time_point lastKeyAsk_ = clk::now();
};
}  // namespace tdudp
