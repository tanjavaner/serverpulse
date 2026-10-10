# Security Policy

ServerPulse holds SSH credentials and runs commands on your servers, so security reports are taken seriously.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Include the affected version, steps to reproduce and the impact you expect. You should get a first response within a week.

## Supported versions

Only the latest release receives fixes. Installed copies update themselves from GitHub Releases.

## Security model

What the app is designed to guarantee, and therefore what counts as a vulnerability when it does not hold:

- **Fixed command set:** every command sent to a server comes from the whitelist in `src/main/ssh/commands.ts`; names, paths and ports are validated before they reach a shell. Any way to run a different command (except through the opt-in terminal) is a vulnerability.
- **Host key verification:** the first host key is confirmed by the user (TOFU); a changed key stops the connection.
- **Secrets at rest:** passwords, private keys and notification tokens are encrypted with Electron `safeStorage` (Windows DPAPI, macOS Keychain) and never written in plain text. Exported configuration files only contain secrets when the user opts in, encrypted with a password (scrypt + AES-256-GCM).
- **Renderer isolation:** `contextIsolation`, `sandbox` and no `nodeIntegration`; IPC is typed and only accepted from the app's own windows.
- **Opt-in actions:** management actions (container start/stop, deploy, cleanup, maintenance) and the terminal are off by default and need a native confirmation.

Out of scope: anything that requires the attacker to already control the user's computer or account, and commands the user types into the opt-in terminal.
