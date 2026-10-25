# Security Policy

TryDesk handles remote screen, input, and file access, so security reports are
taken seriously and prioritized.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

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

## Supported versions

The latest release on the default branch receives security fixes.
