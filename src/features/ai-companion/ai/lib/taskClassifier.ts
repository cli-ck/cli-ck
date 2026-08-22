import type { UIMessage } from "@ai-sdk/react";
import type { ModelTier } from "../config";

type MessagePart = {
  type: string;
  text?: string;
  mediaType?: string;
  input?: unknown;
  output?: unknown;
};

/** ~4 chars/token estimate over text, reasoning, and tool call input/output —
 *  the same heuristic the context-usage indicator uses, shared so the Auto
 *  router and the UI never drift apart. */
export function estimateMessagesTokens(messages: readonly UIMessage[]): number {
  let chars = 0;
  for (const m of messages) {
    for (const p of m.parts as readonly MessagePart[]) {
      if (p.type === "text" || p.type === "reasoning") {
        chars += p.text?.length ?? 0;
      } else if (p.type.startsWith("tool-")) {
        if (p.input) chars += JSON.stringify(p.input).length;
        if (p.output) chars += JSON.stringify(p.output).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

const LOOKUP_KEYWORDS =
  /\b(what is|what's|explain|why does|why is|how does|define|meaning of|difference between)\b/i;
const SUBSTANTIVE_KEYWORDS =
  /\b(refactor|redesign|architecture|implement|migrate|rewrite|add (a |the )?feature|fix (all|every|across)|across the codebase)\b/i;
const CODE_REFERENCE_RE = /```|[\w./-]+\.[a-zA-Z]{1,4}\b/;

const RECENT_ACTIVITY_WINDOW = 6;
const LIGHT_MAX_CHARS = 140;

/** Last message with role "user", with its index in `messages` — shared by
 *  every call site that needs to read or rewrite the latest user turn. */
export function findLastUserMessage(
  messages: readonly UIMessage[],
): { message: UIMessage; index: number } | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return { message: messages[i], index: i };
  }
  return null;
}

function lastUserText(messages: readonly UIMessage[]): string {
  const found = findLastUserMessage(messages);
  if (!found) return "";
  return (found.message.parts as readonly MessagePart[])
    .filter((p) => p.type === "text")
    .map((p) => p.text ?? "")
    .join(" ")
    .trim();
}

/** The latest user message carries an image attachment — the resolution
 *  call site uses this to restrict the model pool to vision-capable models
 *  before resolving a tier, regardless of which tier the text classifies to. */
export function lastMessageHasImage(messages: readonly UIMessage[]): boolean {
  const found = findLastUserMessage(messages);
  if (!found) return false;
  return (found.message.parts as readonly MessagePart[]).some(
    (p) => p.type === "file" && (p.mediaType ?? "").startsWith("image/"),
  );
}

/** A recent stretch of sustained tool-call turns is a strong signal the
 *  conversation is mid substantive work, even if the latest message is short
 *  ("now do the same for utils.ts"). */
function hasSustainedToolActivity(messages: readonly UIMessage[]): boolean {
  const recent = messages.slice(-RECENT_ACTIVITY_WINDOW);
  const toolTurns = recent.filter((m) =>
    (m.parts as readonly MessagePart[]).some((p) => p.type.startsWith("tool-")),
  ).length;
  return toolTurns >= 2;
}

/** Zero-token heuristic classifier — no dedicated model call, so it costs
 *  nothing on every turn. Defaults upward on ambiguity: "light" only when
 *  multiple signals agree the message is unambiguously trivial (see
 *  ModelSwitchingPlan.md §2, Q14). Image/vision handling is not this
 *  function's job — the resolution call site filters the model pool to
 *  vision-capable models when needed, letting resolveTierModel's existing
 *  upward fallback take care of picking a tier that has one. */
export function classifyMessageTier(messages: readonly UIMessage[]): ModelTier {
  const text = lastUserText(messages);
  if (SUBSTANTIVE_KEYWORDS.test(text)) return "heavy";
  if (hasSustainedToolActivity(messages)) return "standard";
  const isShort = text.length > 0 && text.length <= LIGHT_MAX_CHARS;
  const looksLikeLookup = LOOKUP_KEYWORDS.test(text);
  const noCodeReference = !CODE_REFERENCE_RE.test(text);
  if (isShort && looksLikeLookup && noCodeReference) return "light";
  return "standard";
}

/** Coarse task domain, orthogonal to ModelTier (which is complexity, not
 *  domain). Lets model-reliability memory (modelFriction.ts) learn e.g. "this
 *  model times out on code, fine for reading" instead of one blended rate —
 *  the "team of models" story is only as good as picking the right model per
 *  task, not just the right size. */
export type TaskKind = "code" | "read" | "general";

/** Reuses the same signals as classifyMessageTier, applied directly to text
 *  so worker/team callers (workerRun.ts) can classify a standalone prompt
 *  with no message history. */
export function classifyTaskKindFromText(text: string): TaskKind {
  if (
    SUBSTANTIVE_KEYWORDS.test(text) ||
    CODE_REFERENCE_RE.test(text) ||
    text.includes("```")
  ) {
    return "code";
  }
  if (LOOKUP_KEYWORDS.test(text)) return "read";
  return "general";
}

export function classifyTaskKind(messages: readonly UIMessage[]): TaskKind {
  if (hasSustainedToolActivity(messages)) return "code";
  return classifyTaskKindFromText(lastUserText(messages));
}
