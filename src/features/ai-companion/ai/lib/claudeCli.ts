import { invoke } from "@tauri-apps/api/core";

/** Delegates Claude Pro/Max chat requests to the user's own, already
 *  installed and already logged in `claude` CLI, instead of reimplementing
 *  Anthropic's client. See docs/adr/0016-subscription-login-claude-experimental.md
 *  for why this is the only Claude Pro/Max integration cli-ck ships: acting
 *  as Claude Code's own official client is the only way to use a Claude
 *  subscription that Anthropic actually permits. */

let cachedPath: string | null | undefined;

/** Cached for the life of the app, the binary doesn't move mid-session.
 *  The Subscription Login tab calls `refreshClaudeCliDetection` itself when
 *  the person actually looks at it, so a freshly-installed CLI is picked up
 *  without needing a full app restart. */
export async function detectClaudeCli(): Promise<string | null> {
  if (cachedPath !== undefined) return cachedPath;
  return refreshClaudeCliDetection();
}

export async function refreshClaudeCliDetection(): Promise<string | null> {
  cachedPath = await invoke<string | null>("claude_cli_detect");
  return cachedPath;
}

export async function runClaudeCli(
  prompt: string,
  timeoutSecs?: number,
): Promise<string> {
  return invoke<string>("claude_cli_run", { prompt, timeoutSecs });
}

type ChatContentPart = { type?: string; text?: string };
type ChatMessage = { role?: string; content?: string | ChatContentPart[] };

function messageText(content: ChatMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("\n");
}

const ROLE_LABELS: Record<string, string> = {
  system: "System",
  assistant: "Assistant",
  user: "User",
};

/** Claude Code's own agent doesn't speak cli-ck's tool-calling protocol, so
 *  this only ever sends it plain conversational text, prior tool calls and
 *  tool results in the history are dropped rather than mistranslated. */
export function flattenMessagesForClaudeCli(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const text = messageText(m.content).trim();
      if (!text) return null;
      const label = ROLE_LABELS[m.role ?? "user"] ?? "User";
      return `${label}: ${text}`;
    })
    .filter((s): s is string => !!s)
    .join("\n\n");
}

function sseChunk(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

/** A `fetch` that turns an OpenAI-compatible chat/completions request into
 *  a one-shot `claude -p` call, then synthesizes the minimal OpenAI-style
 *  SSE stream `@ai-sdk/openai-compatible` expects back: one content delta,
 *  one finish-reason delta, `[DONE]`. Real streaming would need `claude`'s
 *  own `--output-format stream-json`, deferred, see the plan doc. */
export function createClaudeCliFetch(): typeof fetch {
  return async (_input, init) => {
    let messages: ChatMessage[] = [];
    try {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (Array.isArray(body.messages)) messages = body.messages;
    } catch {
      throw new Error("Could not read the conversation to send to Claude.");
    }

    const transcript = flattenMessagesForClaudeCli(messages);
    if (!transcript) {
      throw new Error("Nothing to send to Claude.");
    }

    const text = await runClaudeCli(transcript);

    const body =
      sseChunk({
        id: "claude-cli",
        choices: [{ delta: { role: "assistant", content: text }, finish_reason: null }],
      }) +
      sseChunk({
        id: "claude-cli",
        choices: [{ delta: {}, finish_reason: "stop" }],
      }) +
      "data: [DONE]\n\n";

    return new Response(new TextEncoder().encode(body), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    });
  };
}
