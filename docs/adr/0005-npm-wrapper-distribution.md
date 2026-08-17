# NPM Wrapper CLI Distribution

We decided to distribute the cli-ck terminal emulator using a globally installable NPM wrapper launcher package (`@codecollab.co/cli-ck`). Rather than requiring developers to install heavy desktop bundles manually, the launcher detects the user's operating system and CPU architecture, downloads the matching precompiled desktop binary from GitHub releases to a local configuration folder (`~/.cli-ck`), extracts it, and boots it directly. This provides a CLI-centric developer experience matching their standard tooling workflow.
