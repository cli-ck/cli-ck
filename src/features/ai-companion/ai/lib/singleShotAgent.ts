import { generateObject } from "ai";
import { z } from "zod";
import { basename, resolvePath, type ToolContext } from "../tools/context";
import { applyEdits, protectedFileError } from "../tools/edit";
import { READ_BYTE_CAP } from "../tools/fs";
import {
  buildConfiguredLanguageModel,
  extractProtectedFiles,
  latestUserText,
  PRESEED_MAX_FILES,
  runAgentStream,
  type RunAgentOptions,
} from "./aiAgent";
import { native } from "./native";

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h >>> 0;
}

const SINGLE_SHOT_SYSTEM = `You are a fast, single-pass code editor. You are given the full contents of every file in a small project directory and one task. Reply with the minimal set of edits needed to complete the task — no explanation.

Rules:
- For an EXISTING file: set old_string to an exact, unique substring to replace, and new_string to its replacement.
- For a NEW file: leave old_string as an empty string and put the full file content in new_string.
- Keep old_string as short as possible while still being unique in the file.
- Only touch files that must change to complete the task.
- Never touch a file the task explicitly says not to change.`;

const SINGLE_SHOT_SCHEMA = z.object({
  edits: z
    .array(
      z.object({
        path: z.string().describe("Absolute path, exactly as listed above."),
        old_string: z
          .string()
          .describe("Exact unique substring to replace. Empty string for a brand-new file."),
        new_string: z.string().describe("Replacement text, or full content for a new file."),
      }),
    )
    .min(1),
});

type StreamableResult = {
  text: PromiseLike<string>;
  usage: PromiseLike<{ inputTokens?: number; outputTokens?: number }>;
  finishReason: PromiseLike<string>;
  steps: PromiseLike<Array<{ toolCalls?: unknown[] }>>;
  usedSingleShot: boolean;
};

async function gatherEligibleFiles(
  cwd: string,
): Promise<{ path: string; content: string }[] | null> {
  const entries = await native.readDir(cwd);
  const files = entries.filter((e) => e.kind === "file");
  if (files.length === 0 || files.length > PRESEED_MAX_FILES) return null;
  const out: { path: string; content: string }[] = [];
  for (const e of files) {
    const abs = resolvePath(e.name, cwd);
    const r = await native.readFile(abs);
    if (r.kind !== "text") continue;
    out.push({
      path: abs,
      content: r.content.length > READ_BYTE_CAP ? r.content.slice(0, READ_BYTE_CAP) : r.content,
    });
  }
  return out;
}

async function verifyTouchedFiles(
  paths: Set<string>,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const checkable = [...paths].filter((p) => /\.(m|c)?jsx?$/.test(p));
  for (const p of checkable) {
    const r = await native.runCommand(`node --check ${JSON.stringify(p)}`, null, 15);
    if (r.exit_code !== 0) {
      return {
        ok: false,
        detail: `node --check failed on ${basename(p)}: ${r.stderr.slice(0, 500)}`,
      };
    }
  }
  return { ok: true };
}

async function escalate(opts: RunAgentOptions): Promise<StreamableResult> {
  const full = await runAgentStream(opts);
  return {
    text: full.text,
    usage: full.usage,
    finishReason: full.finishReason,
    steps: full.steps,
    usedSingleShot: false,
  };
}

// Lever B: for a small, freshly-started scope, skip the multi-step
// tool-calling agent loop entirely — one structured-output call proposes
// edits directly, applied through the same edit/write primitives (and the
// same protected-file guard) the tool-based agent uses, then verified with a
// syntax check. Any ineligibility, application failure, or verification
// failure falls back to the full agent loop, so this can only ever be a net
// win: worst case is one wasted call before the safety net still runs.
export async function runSingleShotAgent(opts: RunAgentOptions): Promise<StreamableResult> {
  const ctx = opts.toolContext;
  const cwd = ctx.getCwd();
  if (opts.planMode || ctx.readCache.size > 0 || !cwd) {
    return escalate(opts);
  }

  let files: { path: string; content: string }[] | null;
  try {
    files = await gatherEligibleFiles(cwd);
  } catch {
    return escalate(opts);
  }
  if (!files) return escalate(opts);

  const taskText = latestUserText(opts.uiMessages);
  if (!taskText.trim()) return escalate(opts);

  const effectiveCtx: ToolContext = {
    ...ctx,
    protectedFiles: extractProtectedFiles(taskText),
  };

  const userPrompt = [
    `Task: ${taskText}`,
    "",
    "Project files:",
    ...files.map((f) => `### ${f.path}\n\`\`\`\n${f.content}\n\`\`\``),
  ].join("\n\n");

  opts.onStep?.("Single-shot: proposing edits");

  let object: z.infer<typeof SINGLE_SHOT_SCHEMA>;
  let inputTokens = 0;
  let outputTokens = 0;
  try {
    const model = await buildConfiguredLanguageModel(
      opts.modelId ?? "gpt-4o-mini",
      opts.keys,
      {
        lmstudioBaseURL: opts.lmstudioBaseURL,
        lmstudioModelId: opts.lmstudioModelId,
        mlxBaseURL: opts.mlxBaseURL,
        mlxModelId: opts.mlxModelId,
        ollamaBaseURL: opts.ollamaBaseURL,
        ollamaModelId: opts.ollamaModelId,
        openaiCompatibleBaseURL: opts.openaiCompatibleBaseURL,
        openaiCompatibleModelId: opts.openaiCompatibleModelId,
        openrouterModelId: opts.openrouterModelId,
        customEndpoints: opts.customEndpoints,
        customEndpointKeys: opts.customEndpointKeys,
      },
    );
    const result = await generateObject({
      model,
      schema: SINGLE_SHOT_SCHEMA,
      system: SINGLE_SHOT_SYSTEM,
      prompt: userPrompt,
      abortSignal: opts.abortSignal,
    });
    object = result.object;
    inputTokens = result.usage.inputTokens ?? 0;
    outputTokens = result.usage.outputTokens ?? 0;
  } catch {
    return escalate(opts);
  }

  const touchedPaths = new Set<string>();
  for (const e of object.edits) {
    const reqPath = resolvePath(e.path, cwd);
    const abs = await native.canonicalize(reqPath).catch(() => reqPath);
    const blocked = protectedFileError(effectiveCtx, abs);
    if (blocked) return escalate(opts);

    if (!e.old_string) {
      try {
        await native.writeFile(abs, e.new_string);
      } catch {
        return escalate(opts);
      }
      effectiveCtx.readCache.set(abs, { size: e.new_string.length, hash: djb2(e.new_string) });
      opts.onStep?.(`Writing ${basename(abs)}`);
    } else {
      const result = await applyEdits(
        abs,
        [{ old_string: e.old_string, new_string: e.new_string }],
        "edit",
        effectiveCtx.readCache,
      );
      if ("error" in result) return escalate(opts);
      opts.onStep?.(`Editing ${basename(abs)}`);
    }
    touchedPaths.add(abs);
  }

  opts.onStep?.("Single-shot: verifying");
  const verdict = await verifyTouchedFiles(touchedPaths);
  opts.onStep?.(null);
  if (!verdict.ok) return escalate(opts);

  return {
    text: Promise.resolve(
      [...touchedPaths].map((p) => `edited ${basename(p)}`).join("\n"),
    ),
    usage: Promise.resolve({ inputTokens, outputTokens }),
    finishReason: Promise.resolve("stop"),
    steps: Promise.resolve([{ toolCalls: new Array(touchedPaths.size).fill({}) }]),
    usedSingleShot: true,
  };
}
