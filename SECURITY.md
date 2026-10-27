# Security Policy

## Supported versions

Security fixes are applied to the latest release.

## Reporting a vulnerability

Please do not open a public issue for vulnerabilities involving credentials,
remote code execution, request proxying, SSRF, or data exposure.

Use GitHub's private vulnerability reporting for this repository:

1. Open the repository Security tab.
2. Select **Report a vulnerability**.
3. Include reproduction steps, affected version, and potential impact.

Do not include real API keys in reports. If a key may have been exposed,
revoke it at the provider immediately.

## Deployment warning

This application is designed to listen on `127.0.0.1`. Exposing the local proxy
to an untrusted network allows arbitrary upstream URLs and should not be done
without authentication, allowlisting, rate limiting, and SSRF protections.