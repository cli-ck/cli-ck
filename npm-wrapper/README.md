# @codecollab.co/cli-ck

cli-ck is an open-source, lightweight, AI-native terminal emulator (ADE - agentic development environment). It integrates a GPU-accelerated WebGL terminal, code editor, file explorer, source control manager, and a first-class AI agent subsystem that runs against your own keys or local inference engines.

This package is a multi-platform CLI launcher for the desktop application. When run for the first time, it automatically fetches, extracts, and runs the precompiled desktop binary for your current operating system and architecture.

## Installation

Install globally via npm or pnpm:

```bash
npm install -g @codecollab.co/cli-ck
# or
pnpm add -g @codecollab.co/cli-ck
```

## Usage

Launch the cli-ck desktop application directly from your shell:

```bash
cli-ck
```

Or run without global installation:

```bash
npx @codecollab.co/cli-ck
```

Other commands:

```bash
cli-ck install     # download + install into Applications / Start Menu, without launching
cli-ck uninstall   # remove the installed app and cached binaries (~/.cli-ck)
```

## Why install via this launcher?

cli-ck is not code-signed or notarized yet (test phase — no paid Apple/Windows
certificates). Installers downloaded through a **browser** are tagged by the OS
(macOS quarantine flag, Windows Mark-of-the-Web), so Gatekeeper reports
"cli-ck is damaged" and SmartScreen shows "Windows protected your PC".

This launcher fetches the release over plain HTTPS instead of a browser, so those
tags are never applied. It also:

- copies the app into `/Applications` (macOS), adds a Start Menu shortcut (Windows),
  or writes a `.desktop` entry (Linux) so cli-ck shows up like a normally installed app;
- strips `com.apple.quarantine` and repairs the ad-hoc signature on macOS defensively;
- launches cli-ck **detached**, so your terminal is freed immediately instead of being
  held open until you quit the app.

No Apple Developer account or signing secret is required.

## Documentation & Source Code

For the full codebase, roadmap, and build options, visit the GitHub repository:
[github.com/cli-ck/cli-ck](https://github.com/cli-ck/cli-ck)
