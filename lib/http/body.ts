// Reads the JSON body of an API request, refusing one that is larger than
// anything the app sends. Server Actions are limited by Next.js itself; route
// handlers are not, so without this a request of any size would be read into
// memory and parsed before its contents were ever looked at.

// Far above the largest real request (a tutor message is at most a few
// thousand characters) and far below anything that could strain the server.
export const MAX_JSON_BODY_BYTES = 64 * 1024;

export type JsonBody = { ok: true; value: Record<string, unknown> } | { ok: false; reason: "too_large" | "invalid" };

export async function readJsonObject(request: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<JsonBody> {
  // The declared length is checked first, so an honest oversized request is
  // refused without being read at all.
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, reason: "too_large" };

  let text: string;
  try {
    text = await readText(request, maxBytes);
  } catch {
    return { ok: false, reason: "too_large" };
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  // A body of `null`, a number or a list is valid JSON but not a request.
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, reason: "invalid" };
  return { ok: true, value: value as Record<string, unknown> };
}

// The length header can be missing or wrong, so the body is also counted as
// it arrives and abandoned once it passes the limit.
async function readText(request: Request, maxBytes: number) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("body too large");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
