# Security Policy

TryDesk handles remote screen, input, and file access, so security reports are
taken seriously and prioritized.

## Reporting a vulnerability

**Please do not report security vulnerabilities publicly** — not in a GitHub issue, nor on social media,
comments or forums.

Instead, email **security@trydesk.ai.id** (or **support@trydesk.ai.id**) with:

- a description of the issue and its impact,
- clear reproduction steps or a proof of concept,
- the affected version / commit.

We aim to acknowledge reports within a few days and will keep you updated on the
fix. Responsible disclosure is appreciated — please give us reasonable time to
release a patch before any public disclosure.

## Scope

In scope: the desktop app (`src/`), the signaling server (`server/`), and the
deployment configuration (`deploy/`).

The security model: screen, input, and file data flow **directly between peers**,
encrypted with DTLS-SRTP. The signaling server only brokers the initial handshake
and never sees session content. A TURN relay is used only when a direct P2P path
is impossible. Reports that strengthen these guarantees are especially welcome.

## What protects a session (and what doesn't)

- **Content:** screen, input, files, clipboard and chat travel peer to peer over WebRTC, encrypted with DTLS-SRTP.
  The signaling server and the TURN relay only see encrypted traffic.
- **Getting in:** a host either asks its owner to click Accept, or (if an access password is set) checks the password
  with a challenge/response. The host sends a salt and a one-time nonce; the requester answers with
  HMAC-SHA256(PBKDF2-SHA256(password, salt, 150 000 rounds), nonce). The password itself never leaves either device,
  and the server only relays the exchange.
- **Guessing:**
  - Each wrong answer costs a fixed second.
  - The third wrong answer from one requester starts a cool-down of 5 to 20 minutes.
  - A separate tally per path (internet ID / LAN) withholds the password check after 12 wrong answers in 10 minutes.
    The ID path then falls back to manual Accept; LAN refuses.
- **Connect by IP (LAN):**
  - Off by default. It listens on TCP 7171 and accepts only private, loopback, link-local and CGNAT addresses.
  - It is refused unless the access password has at least 10 characters. There is no Accept dialog for strangers on
    the network.
  - The SDP offer/answer is signed with the password-derived key, so a machine in the middle can't swap the DTLS
    fingerprint.
  - **Known limit:** the LAN signaling line itself is plain TCP. Someone who records it can try passwords offline
    against the captured HMAC, which is why short passwords are not allowed there. A PAKE would remove this, and it
    is on the list.
- **Host-side permissions:** control, file transfer and clipboard can each be switched off on the host, and
  view-only blocks all three. These checks run on the host, so a modified viewer can't skip them.
- **App hardening:** the renderer runs with context isolation, a sandbox and a strict CSP. Files received get the
  Windows "downloaded from the internet" mark.

## Supported versions

The latest release receives security fixes. From 1.2.8 the app checks `https://trydesk.ai.id/version.json`. When a
fix closes a security hole, the published `minimum` version is raised, and older apps then show a notice and refuse
to open or accept connections until they are updated. A failed check (offline, LAN-only) never blocks anything.
Versions before 1.2.8 can't be notified this way.
