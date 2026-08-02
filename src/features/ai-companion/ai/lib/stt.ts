import type { ProviderKeys } from "./keyring";

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const STT_TIMEOUT_GROQ_MS = 30_000;

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function transcribeOpenAI(blob: Blob, apiKey: string): Promise<string> {
  const [{ createOpenAI }, { experimental_transcribe: transcribe }] =
    await Promise.all([import("@ai-sdk/openai"), import("ai")]);
  const openai = createOpenAI({ apiKey });
  const buf = new Uint8Array(await blob.arrayBuffer());
  const { text } = await transcribe({
    model: openai.transcription("whisper-1"),
    audio: buf,
  });
  return text;
}

async function transcribeViaRest(
  baseURL: string,
  blob: Blob,
  apiKey: string | null,
  model: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", blob, "audio.webm");
  form.append("model", model);
  form.append("response_format", "text");

  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const res = await fetchWithTimeout(`${baseURL}/audio/transcriptions`, {
    method: "POST",
    headers,
    body: form,
  }, STT_TIMEOUT_GROQ_MS);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(
      `STT request failed (${res.status}): ${body || res.statusText}`,
    );
  }
  return res.text();
}

export type SttOptions = {
  groqSttModel?: string;
};

export async function transcribeAudio(
  blob: Blob,
  provider: import("../config").SttProvider,
  apiKeys: ProviderKeys,
  options: SttOptions = {},
): Promise<string> {
  switch (provider) {
    case "openai": {
      const key = apiKeys.openai;
      if (!key) throw new Error("OpenAI API key is not configured");
      return transcribeOpenAI(blob, key);
    }
    case "groq": {
      const key = apiKeys.groq;
      if (!key) throw new Error("Groq API key is not configured");
      const model = options.groqSttModel || "whisper-large-v3-turbo";
      return transcribeViaRest(GROQ_BASE_URL, blob, key, model);
    }
  }
}
