# Hybrid Tauri and Webview Architecture

We decided to build the cli-ck terminal emulator using a hybrid architecture consisting of a Rust backend (using Tauri 2 and the `portable-pty` crate) combined with a React 19 and WebGL-based frontend (`xterm.js`). This hybrid approach enables high GPU-accelerated rendering performance and rapid UI development velocity for complex AI features, matching the lightweight portability (~7-8MB bundle size) required for distribution via NPM, while accepting the minor memory footprint of the system webview process.
