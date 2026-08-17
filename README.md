<div align="center">
  <img src="public/logo.png" width="144" height="144" alt="cli-ck" />
  <h1>cli-ck</h1>

  <p><strong>Lightweight Terminal-first AI-native dev workspace.</strong></p>

  <p>
    <img src="https://img.shields.io/github/v/release/cli-ck/cli-ck?label=version&color=blue" alt="version" />
    <a href="https://www.npmjs.com/package/@codecollab.co/cli-ck" target="_blank">
      <img src="https://img.shields.io/npm/v/@codecollab.co/cli-ck?label=npm&color=blue" alt="npm" />
    </a>
    <img src="https://img.shields.io/github/downloads/cli-ck/cli-ck/total?label=github%20downloads&color=blue" alt="github downloads" />
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux%20%7C%20Windows-lightgrey" alt="platform" />
  </p>

  <p>
    <a href="https://github.com/cli-ck/cli-ck">Source code</a>
    &nbsp;·&nbsp;
    <a href="https://www.npmjs.com/package/@codecollab.co/cli-ck" target="_blank">NPM registry</a>
  </p>
</div>

---

cli-ck is a lightweight open-source terminal (ADE) built on Tauri 2 + Rust and React 19. A native PTY backend with a WebGL renderer, an agentic AI side-panel that runs against your own keys or fully local models, plus a code editor, file explorer, source control with a git graph, and a web preview pane built in. About 7-8 MB on disk. No telemetry. No account.

## Screenshots

<table>
  <tr>
    <td align="center"><img src="gallery-media/pty_terminal_shell.png" alt="Terminal" /><br/><sub>Multi-tab terminal with WebGL rendering</sub></td>
    <td align="center"><img src="gallery-media/chrome_ui_themes.png" alt="Themes and background image" /><br/><sub>Custom themes, presets, and background images</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="gallery-media/browser_live_preview.png" alt="Web preview" /><br/><sub>Web preview of local dev servers</sub></td>
    <td align="center"><img src="gallery-media/vcs_git_control.png" alt="Source control and git graph" /><br/><sub>Source control panel with git graph in history</sub></td>
  </tr>
  <tr>
    <td colspan="2" align="center"><img src="gallery-media/ai_companion_flow.png" alt="AI window" /><br/><sub>Agentic AI workflow with edit diffs in the code editor</sub></td>
  </tr>
</table>

## Features

### Terminal

- xterm.js with WebGL renderer, multi-tab with background streaming
- GPU-accelerated block-based terminal with editor-like command input
- Native PTY backend via `portable-pty` (zsh, bash, pwsh, fish, cmd)
- Split panels (horizontal and vertical)
- Inline search, link detection, true-color
- Per-tab workspace environments on Windows (Local, or any installed WSL distro)

### Code editor

- CodeMirror 6 (supports all popular languages - TS/JS, Rust, Python, Go, C/C++, Java, HTML/CSS, JSON, Markdown, etc.)
- Inline AI autocomplete with local model support
- AI edit diffs, accept or reject hunk by hunk
- Vim mode
- Ten built-in editor themes: Atom One, Aura, Copilot, GitHub Dark / Light, Gruvbox Dark, Nord, Tokyo Night, Xcode Dark / Light

### Source control

- Stage / unstage hunks, commit (Cmd+Enter / Ctrl+Enter), push with upstream awareness
- Branch display including detached HEAD state
- Git history pane with a real commit graph (lane rendering for merges and branches)
- Commit search and filter, click through to the remote commit page

### File explorer

- Catppuccin icon theme
- Fuzzy search, keyboard navigation, inline rename, context actions
- Attach files and selections directly to the AI side-panel

### Web preview

- Auto-detects local dev servers and opens them in a preview tab
- External URL preview via a native child webview

### Themes and customization

- Custom themes built in-app, switch between bundled presets and your own
- Create your own themes, share them or import from the community
- Background images with adjustable opacity and blur
- Editor theme is independent from the app theme

### AI

- **BYOK providers:** OpenAI, Anthropic, Google (Gemini), Groq, xAI (Grok), Cerebras, OpenRouter, DeepSeek, Mistral, plus any OpenAI-compatible endpoint
- **Local / offline:** LM Studio, MLX, Ollama
- **Agentic workflow:** plans, sub-agents, project memory via `cli-ck.md`, file read / write / edit / multi-edit / grep / glob, bash with approval gating, background processes
- **Composer:** snippets via `#handle`, files via `@path`, slash commands, voice input, attach-to-agent from explorer or selection
- **Custom agents** with their own system prompt and tool subset
- **Plan mode** for multi-step work, generates and confirms before doing

## Install

### Via NPM (Cross-platform Launcher) — recommended during the test phase

You can install and launch the cli-ck desktop application directly from your shell using NPM or `npx`:

```bash
# Run immediately without global installation
npx @codecollab.co/cli-ck

# Or install globally and run
npm install -g @codecollab.co/cli-ck
cli-ck
```

This is the smoothest option while cli-ck is still unsigned (see [Unsigned builds](#unsigned-builds) below). The launcher downloads the app over HTTPS — which avoids the macOS "damaged" / Windows SmartScreen prompts entirely — installs it into your Applications / Start Menu, and launches it detached. Extra commands:

```bash
cli-ck install     # download + install without launching
cli-ck uninstall   # remove the installed app and cached binaries
```

### Desktop Installers

Latest precompiled installers (DMG, MSI, DEB, RPM, AppImage) are on the [Releases](https://github.com/cli-ck/cli-ck/releases/latest) page. cli-ck auto-updates from there. If you download these through a browser, read [Unsigned builds](#unsigned-builds) first.

### Unsigned builds

cli-ck is **not code-signed or notarized yet** (no paid Apple/Windows certificates during the test phase). The app itself is safe — the OS just can't verify a signature. The `npx @codecollab.co/cli-ck` launcher above sidesteps all of this and is the recommended path. If you instead downloaded an installer from the Releases page through a browser, clear the OS block once:

- **macOS** ("cli-ck is damaged and can't be opened"): drag `cli-ck.app` into `/Applications`, then run:
  ```bash
  xattr -dr com.apple.quarantine /Applications/cli-ck.app
  ```
  Open it normally afterwards. (On Apple Silicon the "damaged" message is Gatekeeper refusing an un-notarized app, not a corrupt download.)
- **Windows** ("Windows protected your PC"): click **More info** → **Run anyway**. Or right-click the installer → **Properties** → tick **Unblock** → **OK**.
- **Linux**: `chmod +x cli-ck_*.AppImage` and ensure FUSE is installed. Without FUSE: `./cli-ck_*.AppImage --appimage-extract-and-run`. The `.deb` / `.rpm` packages don't need this.

### Windows notes

- On first launch Windows shows "Windows protected your PC" because cli-ck isn't code-signed yet. Click **More info** then **Run anyway**.
- Default shell detection: `pwsh.exe` (PowerShell 7+) -> `powershell.exe` (Windows PowerShell 5.1) -> `cmd.exe`.
- WSL is a first-class workspace environment, not a wrapped subprocess.

### Linux notes

- **Arch / AUR:** `yay -S cli-ck-bin` (or `paru`, etc.). Tracks the latest release.
- **NixOS / Nix**: use the official flake — `nix profile install github:cli-ck/cli-ck` (non-NixOS), or import the flake and add `inputs.cli-ck.packages.${pkgs.system}.cli-ck` to `environment.systemPackages` (NixOS). The `nixosModules.cli-ck` output is also available for a simpler setup.
- **AppImage:** needs FUSE. Without it: `./cli-ck_*.AppImage --appimage-extract-and-run`. On Wayland with rendering glitches, try `WEBKIT_DISABLE_DMABUF_RENDERER=1`. Otherwise the `.deb` / `.rpm` packages link against the system GTK stack and tend to be smoother.

## Configure AI

1. Open **Settings -> AI**.
2. Pick a provider and paste your API key. For local inference, point cli-ck at your LM Studio / MLX / Ollama endpoint.
3. Keys are written to the OS keychain via `keyring`. They never touch disk or localStorage.

## Build from source

**Prerequisites**
- Rust (stable), https://rustup.rs
- Node 20+ and [pnpm](https://pnpm.io)
- Tauri prerequisites for your platform, https://tauri.app/start/prerequisites/

**Run**
```bash
pnpm install
pnpm tauri dev          # development
pnpm tauri build        # production bundle
```

**Checks**
```bash
pnpm exec tsc --noEmit                                            # frontend type-check
cd src-tauri && cargo clippy --all-targets --locked -D warnings   # Rust lint (matches CI)
cd src-tauri && cargo test --locked                               # Rust tests
```

## Tech stack

Tauri 2, Rust, `portable-pty`, React 19, TypeScript, Vite, xterm.js, CodeMirror 6, Vercel AI SDK v6, Tailwind v4, shadcn/ui, Zustand.

## Contributing

Issues and PRs are welcome! Feel free to open issues, suggest features, or submit pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for more details.

## License

cli-ck is licensed under the Apache-2.0 License. For more information on our dependencies, see [Apache License 2.0](LICENSE).

## Star history

<div align="center">
  <a href="https://www.star-history.com/#cli-ck/cli-ck&Date">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=cli-ck/cli-ck&type=Date&theme=dark" />
      <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=cli-ck/cli-ck&type=Date" />
      <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=cli-ck/cli-ck&type=Date" />
    </picture>
  </a>
</div>
