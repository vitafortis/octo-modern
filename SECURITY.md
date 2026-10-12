# Security

octo·modern holds the API keys of your printers and can move, heat and power them, so security reports are welcome.

## Reporting a vulnerability

Please report it privately through GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability** ([direct link](https://github.com/vitafortis/octo-modern/security/advisories/new)). Include the version (shown in the sidebar, or the image tag), how to reproduce it and what an attacker gains.

Please don't open a public issue for something that could be exploited before a fix is out. For hardening ideas and questions that aren't exploitable, a regular [issue](https://github.com/vitafortis/octo-modern/issues) is fine.

## Supported versions

Fixes go into `main` and ship as a new image (`:latest` and `0.1.<build>`); there are no back-ported fixes for older builds. Upgrade by pulling the image (see [Upgrading](README.md#upgrading)). The Android app is fixed in a new `android-v*` release.

## How octo·modern protects your printers

The [security model](README.md#security-model) in the README describes it: API keys and other credentials sealed with AES-256-GCM and never sent to a browser, every printer request going through the server, roles and per-printer access checked on the server, confirmations for dangerous actions, and narrowly scoped status, upload and device tokens.
