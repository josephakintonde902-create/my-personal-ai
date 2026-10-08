import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_JSON_BODY_BYTES, readJsonObject } from "@/lib/http/body";
import { handleTutorChat } from "@/lib/ai/tutor/handler";

const post = (body: BodyInit | null, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api", { method: "POST", headers: { "content-type": "application/json", ...headers }, body });

// A body sent in pieces with no length declared, as a client could do on purpose.
function streamed(text: string, pieces = 8) {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / pieces);
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + size));
      offset += size;
    },
  });
  return new Request("http://localhost/api", { method: "POST", body: stream, duplex: "half" } as RequestInit);
}

describe("reading an API request body", () => {
  it("returns a JSON object as it was sent", async () => {
    assert.deepEqual(await readJsonObject(post(JSON.stringify({ query: "refraction", topK: 3 }))), { ok: true, value: { query: "refraction", topK: 3 } });
    assert.deepEqual(await readJsonObject(streamed(JSON.stringify({ message: "héllo ✓" }))), { ok: true, value: { message: "héllo ✓" } });
  });

  it("refuses anything that is not a JSON object, without throwing", async () => {
    for (const body of ["{nope", "", "null", "42", '"text"', "[1,2,3]", "true"]) {
      assert.deepEqual(await readJsonObject(post(body)), { ok: false, reason: "invalid" }, body);
    }
    assert.deepEqual(await readJsonObject(post(null)), { ok: false, reason: "invalid" });
  });

  it("refuses a body over the limit, whether or not its length was declared", async () => {
    const big = JSON.stringify({ message: "x".repeat(MAX_JSON_BODY_BYTES) });
    assert.deepEqual(await readJsonObject(post(big)), { ok: false, reason: "too_large" });
    assert.deepEqual(await readJsonObject(streamed(big)), { ok: false, reason: "too_large" });
    // A declared length alone is enough to refuse it unread.
    assert.deepEqual(await readJsonObject(post("{}", { "content-length": String(MAX_JSON_BODY_BYTES + 1) })), { ok: false, reason: "too_large" });
    // Just under the limit is accepted.
    const fits = JSON.stringify({ message: "x".repeat(MAX_JSON_BODY_BYTES - 100) });
    assert.equal((await readJsonObject(post(fits))).ok, true);
  });

  it("makes the tutor refuse an oversized or malformed request before doing any work", async () => {
    let opened = 0;
    const deps = {
      getUser: async () => ({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      openStore: () => {
        opened++;
        throw new Error("the store must not be opened");
      },
      search: async () => [],
      getModel: () => {
        throw new Error("the model must not be created");
      },
    };

    const tooLarge = await handleTutorChat(streamed(JSON.stringify({ message: "x".repeat(2_000_000) })), deps);
    assert.equal(tooLarge.status, 400);
    assert.equal((await tooLarge.json()).code, "MESSAGE_TOO_LONG");

    for (const body of ["null", "[]", "{nope"]) {
      const response = await handleTutorChat(post(body), deps);
      assert.equal(response.status, 400, body);
      const payload = await response.json();
      assert.equal(payload.code, "INVALID_REQUEST");
      // Nothing internal: no stack frame, no file path, no parser message.
      assert.doesNotMatch(JSON.stringify(payload), /\bat \w+ \(|stack|node_modules|SyntaxError|Unexpected token/);
    }
    assert.equal(opened, 0);
  });
});
