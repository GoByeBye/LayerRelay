# Security policy

## Supported versions

Before the first tagged release, security fixes are made on the default branch. After releases begin, only the latest tagged release and the default branch receive security fixes.

| Version | Support |
|---|---|
| Default branch | Best effort |
| Latest tagged release | Supported |
| Older releases | Not supported |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Use [GitHub's private vulnerability reporting](https://github.com/GoByeBye/3d-livestream/security/advisories/new). If private reporting is temporarily unavailable, open a public issue asking for a private contact channel without including technical details.

Include:

- The affected version or commit
- The installation method and operating system
- Reproduction steps or a minimal proof of concept
- The likely impact and any known mitigations
- Whether the issue is already being exploited or publicly discussed

Reports are handled on a best-effort basis. Please allow time to reproduce the issue, prepare a fix, and coordinate disclosure before publishing details.

## Protect sensitive information

Never submit a real `config.json`, passwords, API tokens, OAuth refresh tokens, private RTSP URLs, unredacted logs, or private camera frames. Redact printer addresses, usernames, job names, local paths, and other identifying details. If a credential was exposed, rotate it immediately even if the message or commit was later removed.

## Deployment boundary

The default local-only listener is part of the security model. Binding the service to a LAN or public interface exposes read APIs and may expose relayed camera imagery. Use host firewall rules or an authenticated reverse proxy, configure write authentication, and review the deployment documentation before enabling remote access.
