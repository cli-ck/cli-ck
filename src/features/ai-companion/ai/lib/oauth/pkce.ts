export type PkceCodes = {
  verifier: string;
  challenge: string;
};

const VERIFIER_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export async function generatePkce(): Promise<PkceCodes> {
  const verifier = Array.from(crypto.getRandomValues(new Uint8Array(43)))
    .map((b) => VERIFIER_CHARS[b % VERIFIER_CHARS.length])
    .join("");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return { verifier, challenge: base64UrlEncode(new Uint8Array(digest)) };
}

export function randomState(): string {
  return base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
}
