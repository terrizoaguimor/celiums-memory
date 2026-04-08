# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x     | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in celiums-memory, please report it responsibly:

1. **DO NOT** open a public GitHub issue
2. Email **terrizoaguimor@gmail.com** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. Or use [GitHub Security Advisories](https://github.com/terrizoaguimor/celiums-memory/security/advisories/new)

We will respond within 48 hours and provide a fix timeline.

## Security Measures

- Dependencies are monitored via Dependabot
- CodeQL scanning is enabled for automated vulnerability detection
- The in-memory mode stores no persistent data by default
- Production mode (PG+Qdrant+Valkey) should be deployed behind a firewall
- API endpoints do not expose internal architecture or model details
- No real user biometric or medical data is processed — emotional states are computed from text patterns only

## Disclaimer

celiums-memory simulates neuroscience concepts computationally. It does not process, store, or infer real human emotions, medical conditions, or personally identifiable information. The PAD model and personality traits are mathematical abstractions, not clinical assessments.
