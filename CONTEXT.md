# cli-ck Context Glossary

This document defines the core domain terms used throughout the cli-ck project.

## Language

**cli-ck**:
The open-source AI-native terminal emulator and agentic development environment.
_Avoid_: App, client, shell application

**Launcher**:
The lightweight NPM CLI wrapper package that downloads, extracts, and runs the cli-ck desktop application binaries for the host OS.
_Avoid_: Wrapper, installer, runner

**WebGL Renderer**:
The GPU-accelerated drawing layer on the frontend that displays the terminal output grid with high performance.
_Avoid_: Canvas, layout drawer

**PTY Session**:
The interactive pseudoterminal process managed in the Rust backend that hosts the user's active shell.
_Avoid_: Terminal instance, terminal process

**Keychain**:
The secure host system credential vault used to encrypt and store sensitive API keys.
_Avoid_: LocalStorage, secret file, config database

**AI Sidebar**:
A dedicated, collapsible panel in the terminal workspace hosting the multi-turn conversational AI assistant.
_Avoid_: Chat box, inline prompt

**Supervised Tool Execution**:
A security validation pattern where the AI assistant's proposed shell or file actions are blocked until manually approved by the user via confirmation cards.
_Avoid_: Auto-run, background execution, autonomous shell

**Manual Context Selection**:
A developer-driven interaction model where terminal outputs, code snippets, or logs are only sent to the AI assistant if explicitly selected or attached by the user.
_Avoid_: Auto-context, log scraping, background bridge

**Shell Integration**:
The technique of injecting configuration scripts into a PTY session shell startup profiles to track terminal runtime metadata.
_Avoid_: Profile modifier, prompt hack

**OSC Sequences**:
Operating System Command escape sequences (specifically OSC 7 and OSC 133) parsed by the emulator to track current directories, command borders, and exit codes.
_Avoid_: Escape tokens, terminal flags, control logs

**AI HTTP Proxy**:
The backend network pipeline in Rust that intercepts LLM API requests, injects auth credentials, and forwards streams to the frontend webview.
_Avoid_: Client fetcher, direct router, web requester

**BYOK (Bring Your Own Key)**:
The API authorization paradigm where developers provide their own private keys to cover their usage costs directly with LLM providers.
_Avoid_: Free tier, shared keys, company API account

**Local Offline Models**:
Large language models hosted and executed locally on the user's CPU/GPU via client-side engines (Ollama, LM Studio) to operate without internet access.
_Avoid_: Remote weights, cloud LLM, API server models

**Meta-Orchestration**:
The process where the built-in cli-ck agent coordinates, launches, and manages external CLI-based coding agents as child PTY sessions.
_Avoid_: Custom wrappers, endpoint plugins, standalone executors

**Session Persistence**:
The layout recovery architecture that serializes tab metadata, scrollback logs, and split grids to restore terminal layouts after restarts.
_Avoid_: Process checkpointing, VM snapshot, memory freeze

## Example Dialogue


**Developer**: I am setting up **cli-ck** on my new system. Should I download the desktop app binary manually?

**DevOps Expert**: No, just install the **Launcher** globally via NPM and run it. It automatically downloads and extracts the correct platform-specific binaries in the background for you.

**Developer**: Great. I want to hook up my private OpenAI key. Does it save it in cleartext inside local storage?

**DevOps Expert**: No, for security reasons it uses the **BYOK (Bring Your Own Key)** model and writes your key directly to your host OS secure **Keychain**. When you interact with the **AI Sidebar**, requests are proxied through the backend **AI HTTP Proxy** which injects the keys, ensuring the JavaScript frontend never holds your secrets in memory.

**Developer**: Can the AI query my Kubernetes cluster and analyze running pod logs directly?

**DevOps Expert**: Yes, but since it has **Supervised Tool Execution**, it will display a validation card asking for your permission before executing any command. Make sure to use **Manual Context Selection** to copy and attach the pod info you want it to evaluate, as it doesn't scrape your active logs by default.

**Developer**: What about the interface speed?

**DevOps Expert**: The rendering is instant because it uses a **WebGL Renderer** to draw the active **PTY Session** grid. It also registers a custom **Shell Integration** using **OSC Sequences** to automatically monitor prompt boundaries and directory changes under the hood.







