#!/usr/bin/env node
/**
 * Headless invocation of cli-ck's real agent loop (runAgentStream in
 * src/features/ai-companion/ai/lib/aiAgent.ts), for benchmarking against
 * Warp's `oz agent run` CLI. No Tauri webview involved — fs/shell tool
 * calls route through ./tauriInvokeShim.ts instead of the real
 * `@tauri-apps/api/core`, aliased in below via Vite's SSR module loader
 * (Vite is already a project dependency; this avoids adding tsx/ts-node
 * just to run TS with path aliases).
 *
 * Usage:
 *   node scripts/headless-agent/run.mjs \
 *     --prompt "add a reverse(s) function with a test" \
 *     --cwd /path/to/scratch/repo \
 *     --provider anthropic --model claude-sonnet-5 \
 *     [--api-key sk-...]   # else read from *_API_KEY env for the provider
 */
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");

const PROVIDER_ENV_VAR = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_API_KEY",
  xai: "XAI_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  groq: "GROQ_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

// Mirrors keyring.ts's EMPTY_PROVIDER_KEYS — inlined rather than imported so
// this script's only SSR-loaded module is aiAgent.ts itself.
const EMPTY_PROVIDER_KEYS = {
  openai: null,
  anthropic: null,
  google: null,
  xai: null,
  cerebras: null,
  groq: null,
  deepseek: null,
  mistral: null,
  openrouter: null,
  "openai-compatible": null,
  lmstudio: null,
  mlx: null,
  ollama: null,
};

const { values } = parseArgs({
  options: {
    prompt: { type: "string" },
    cwd: { type: "string" },
    provider: { type: "string", default: "anthropic" },
    model: { type: "string", default: "claude-sonnet-5" },
    "api-key": { type: "string" },
  },
});

if (!values.prompt || !values.cwd) {
  console.error("Usage: node run.mjs --prompt <task> --cwd <dir> [--provider p] [--model id] [--api-key key]");
  process.exit(1);
}

const provider = values.provider;
const apiKey = values["api-key"] ?? process.env[PROVIDER_ENV_VAR[provider] ?? ""];
if (!apiKey) {
  console.error(
    `No API key for provider "${provider}". Pass --api-key or set ${PROVIDER_ENV_VAR[provider] ?? "<PROVIDER>_API_KEY"}.`,
  );
  process.exit(1);
}
const cwd = path.resolve(values.cwd);

const server = await createServer({
  root: repoRoot,
  configFile: false,
  logLevel: "warn",
  resolve: {
    alias: [
      { find: "@tauri-apps/api/core", replacement: path.join(__dirname, "tauriInvokeShim.ts") },
      { find: "@", replacement: path.join(repoRoot, "src") },
    ],
  },
  ssr: { noExternal: true },
});

try {
  const { runAgentStream } = await server.ssrLoadModule(
    path.join(repoRoot, "src/features/ai-companion/ai/lib/aiAgent.ts"),
  );

  const keys = { ...EMPTY_PROVIDER_KEYS, [provider]: apiKey };
  const toolContext = {
    getCwd: () => cwd,
    getWorkspaceRoot: () => cwd,
    getTerminalContext: () => null,
    isActiveTerminalPrivate: () => false,
    injectIntoActivePty: () => false,
    openPreview: () => false,
    spawnAgent: () => null,
    readAgentOutput: () => null,
    readCache: new Map(),
    getSessionId: () => "headless-bench",
    autoApprove: true,
  };
  const uiMessages = [
    { id: randomUUID(), role: "user", parts: [{ type: "text", text: values.prompt }] },
  ];

  const startedAt = performance.now();
  const result = await runAgentStream({
    keys,
    modelId: values.model,
    toolContext,
    uiMessages,
  });

  const [finalText, usage, finishReason, steps] = await Promise.all([
    result.text,
    result.usage,
    result.finishReason,
    result.steps,
  ]);
  const durationMs = Math.round(performance.now() - startedAt);
  const toolCallCount = steps.reduce((n, s) => n + (s.toolCalls?.length ?? 0), 0);

  console.log(
    JSON.stringify(
      {
        prompt: values.prompt,
        provider,
        model: values.model,
        durationMs,
        stepCount: steps.length,
        toolCallCount,
        finishReason,
        inputTokens: usage.inputTokens ?? null,
        outputTokens: usage.outputTokens ?? null,
        finalText,
      },
      null,
      2,
    ),
  );
  process.exitCode = 0;
} catch (err) {
  console.error(err?.stack ?? String(err));
  process.exitCode = 1;
} finally {
  await server.close();
}
