// What a deployment does when its environment variables are wrong.
//
// The failure these guard against: the app worked locally, and on the hosted
// copy every sign-in answered "We couldn't reach Ari. Check your connection
// and try again." The student's connection was fine. The server could not
// complete its own request to Supabase, and that was reported as a network
// problem on the student's side, with nothing to say which setting was wrong.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { GeminiEmbeddings } from "@/lib/ai/embeddings/gemini";
import { embeddingConfigProblem, getEmbeddingProvider } from "@/lib/ai/embeddings/provider";
import { DEFAULT_EMBEDDING_MODELS } from "@/lib/ai/config";
import { TutorError } from "@/lib/ai/tutor/errors";
import { GeminiChat } from "@/lib/ai/tutor/gemini-chat";
import { handleTutorChat } from "@/lib/ai/tutor/handler";
import { aiConfigProblem, getTutorModel } from "@/lib/ai/tutor/provider";
import type { TutorErrorBody } from "@/lib/ai/tutor/types";
import { AUTH_SERVICE_MESSAGES, authServiceFailure, friendlyAuthError } from "@/lib/auth/errors";
import { getSupabaseConfig, isSupabaseConfigured, SupabaseConfigError, supabaseConfigProblem } from "@/lib/supabase/config";
import { checkSupabase } from "@/lib/supabase/health";
import { chatRequest, depsFor, world } from "./tutor-fakes";

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const URL_OK = "https://abcdefghijklmnopqrst.supabase.co";
// Shaped like real keys so the tests can check they never leak. Not real.
const KEY_OK = "sb_publishable_TESTnotARealKey00000000000000";
const GEMINI_KEY = "AIzaSyTEST-not-a-real-key-000000000000";

const AI_NAMES = ["AI_PROVIDER", "AI_API_KEY", "AI_MODEL", "AI_API_URL", "GEMINI_API_KEY", "GEMINI_MODEL", "XAI_API_KEY", "XAI_MODEL", "EMBEDDING_PROVIDER", "EMBEDDING_API_KEY", "EMBEDDING_MODEL", "EMBEDDING_API_URL", "GEMINI_EMBEDDING_MODEL"];
const SUPABASE_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"];

async function withEnv<T>(values: Record<string, string>, run: () => T | Promise<T>) {
  const names = [...AI_NAMES, ...SUPABASE_NAMES];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, values);
    return await run();
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

// Runs a sign-in through the real Supabase client, with the network replaced.
async function signInError(fetcher: typeof fetch, key = KEY_OK) {
  const supabase = createClient(URL_OK, key, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: fetcher } });
  const { error } = await supabase.auth.signInWithPassword({ email: "student@example.com", password: "correct horse battery" });
  return error;
}

const json = (status: number, body: unknown) => async () => Response.json(body, { status });
const noAnswer: typeof fetch = async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
};

function silently<T>(run: () => T) {
  const original = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    return { result: run(), logged: JSON.stringify(logged) };
  } finally {
    console.error = original;
  }
}

describe("sign-in when the server cannot use Supabase", () => {
  it("does not blame the student's connection when the server's own request gets no answer", async () => {
    const error = await signInError(noAnswer);
    assert.equal(authServiceFailure(error), "UNREACHABLE");

    const { result: message, logged } = silently(() => friendlyAuthError(error, "sign-in"));
    assert.equal(message, AUTH_SERVICE_MESSAGES.UNREACHABLE);
    assert.doesNotMatch(message, /check your connection/i);
    assert.match(message, /not your connection/);
    // The log says what kind of failure it was and where to look next.
    assert.match(logged, /"service":"UNREACHABLE"/);
    assert.match(logged, /\/api\/health/);
  });

  it("tells a Supabase outage and a rejected key apart from an unreachable address", async () => {
    const outage = await signInError(json(503, { message: "upstream unavailable" }));
    assert.equal(authServiceFailure(outage), "UNAVAILABLE");

    const rejected = await signInError(json(401, { message: "Invalid API key", hint: "Double check your Supabase `anon` or `service_role` API key." }));
    assert.equal(authServiceFailure(rejected), "NOT_CONFIGURED");

    for (const error of [outage, rejected]) {
      const { result: message } = silently(() => friendlyAuthError(error, "sign-in"));
      assert.doesNotMatch(message, /connection/i);
    }
  });

  it("still gives the student their own mistakes as their own", async () => {
    const wrongPassword = await signInError(json(400, { code: 400, error_code: "invalid_credentials", msg: "Invalid login credentials" }));
    assert.equal(authServiceFailure(wrongPassword), null);
    assert.equal(silently(() => friendlyAuthError(wrongPassword, "sign-in")).result, "That email and password don't match. Please try again.");

    const tooMany = await signInError(json(429, { code: 429, error_code: "over_request_rate_limit", msg: "Too many requests" }));
    assert.match(silently(() => friendlyAuthError(tooMany, "sign-in")).result, /Too many attempts/);
  });

  it("never logs or shows the failed request's message, which can repeat the key", () => {
    // What Node's fetch throws for a key that cannot go in a header.
    const error = { name: "AuthRetryableFetchError", status: 0, message: `Headers.append: "${KEY_OK}…" is an invalid header value.` };
    const { result: message, logged } = silently(() => friendlyAuthError(error, "sign-in"));
    assert.ok(!message.includes(KEY_OK));
    assert.ok(!logged.includes(KEY_OK));
  });
});

describe("Supabase settings", () => {
  it("accepts a project URL with either kind of publishable key", () => {
    assert.equal(supabaseConfigProblem(URL_OK, KEY_OK), null);
    assert.equal(supabaseConfigProblem(`${URL_OK}/`, "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJl-_"), null);
    assert.equal(supabaseConfigProblem("http://127.0.0.1:54321", KEY_OK), null);
  });

  it("names the setting that is missing", () => {
    assert.match(supabaseConfigProblem(undefined, KEY_OK)!, /^NEXT_PUBLIC_SUPABASE_URL is not set$/);
    assert.match(supabaseConfigProblem(URL_OK, "")!, /^NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is not set$/);
    assert.match(supabaseConfigProblem(undefined, undefined)!, /NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY are not set/);
  });

  it("catches the values that would otherwise fail as a request with no answer", () => {
    const problems: [string, string, RegExp][] = [
      ["https://supabase.com/dashboard/project/abcdefghijklmnopqrst", KEY_OK, /dashboard address/],
      ["https://your-project-ref.supabase.co", KEY_OK, /placeholder/],
      [`"${URL_OK}"`, KEY_OK, /not a URL/],
      ["abcdefghijklmnopqrst.supabase.co", KEY_OK, /not a URL/],
      [`${URL_OK}/rest/v1`, KEY_OK, /path after the address/],
      [URL_OK, `${KEY_OK}…`, /not part of a key/],
      [URL_OK, `sb_publishable_TEST\nnotARealKey`, /not part of a key/],
      [URL_OK, `"${KEY_OK}"`, /wrapped in quotes/],
      [URL_OK, "sb_publishable_xxxxxxxxxxxxxxxxxxxx", /placeholder/],
      [URL_OK, "sb_secret_TESTnotARealKey0000000000", /secret key/],
    ];
    for (const [url, key, expected] of problems) {
      const problem = supabaseConfigProblem(url, key);
      assert.match(problem ?? "no problem reported", expected, `for ${url}`);
      // A problem names the setting, and never repeats a key.
      assert.match(problem!, /NEXT_PUBLIC_SUPABASE_(URL|PUBLISHABLE_KEY)/);
      assert.ok(!problem!.includes(KEY_OK) && !problem!.includes("TESTnotARealKey"));
    }
  });

  it("reports a bad setting as a configuration error, and the proxy treats it as not configured", async () => {
    await withEnv({ NEXT_PUBLIC_SUPABASE_URL: "https://supabase.com/dashboard/project/abc", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: KEY_OK }, () => {
      assert.equal(isSupabaseConfigured(), false);
      assert.throws(getSupabaseConfig, (error) => {
        assert.ok(error instanceof SupabaseConfigError);
        assert.equal(authServiceFailure(error), "NOT_CONFIGURED");
        assert.equal(silently(() => friendlyAuthError(error, "sign-in")).result, AUTH_SERVICE_MESSAGES.NOT_CONFIGURED);
        return true;
      });
    });

    // Pasted with a line break after it: usable once trimmed.
    await withEnv({ NEXT_PUBLIC_SUPABASE_URL: ` ${URL_OK}\n`, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: `${KEY_OK}\n` }, () => {
      assert.equal(isSupabaseConfigured(), true);
      assert.deepEqual(getSupabaseConfig(), { url: URL_OK, key: KEY_OK });
    });
  });
});

describe("deployment health check", () => {
  const settings = { url: URL_OK, key: KEY_OK };

  it("asks the configured project, with the key in a header only", async () => {
    const calls: { url: string; apikey: string | null }[] = [];
    const health = await checkSupabase(settings, async (input, init) => {
      calls.push({ url: String(input), apikey: new Headers(init?.headers).get("apikey") });
      return Response.json({ external: {} });
    });
    assert.deepEqual(health, { status: "ok", host: "abcdefghijklmnopqrst.supabase.co" });
    assert.deepEqual(calls, [{ url: `${URL_OK}/auth/v1/settings`, apikey: KEY_OK }]);
  });

  it("gives each failure its own status and says which setting to check", async () => {
    const unreachable = await checkSupabase(settings, noAnswer);
    assert.equal(unreachable.status, "unreachable");
    assert.match(unreachable.detail!, /ENOTFOUND/);
    assert.match(unreachable.detail!, /NEXT_PUBLIC_SUPABASE_URL/);

    const rejected = await checkSupabase(settings, json(401, { message: "Invalid API key" }));
    assert.equal(rejected.status, "key_rejected");
    assert.match(rejected.detail!, /NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY/);

    assert.equal((await checkSupabase(settings, json(503, {}))).status, "unavailable");
    // Some other website answering at that address is not a Supabase project.
    assert.equal((await checkSupabase(settings, json(404, {}))).status, "unreachable");

    for (const health of [unreachable, rejected]) assert.ok(!JSON.stringify(health).includes(KEY_OK));
  });

  it("reports missing or malformed settings without making a request", async () => {
    let requests = 0;
    const counting: typeof fetch = async () => {
      requests++;
      return Response.json({});
    };
    assert.deepEqual(await checkSupabase({ url: undefined, key: KEY_OK }, counting), { status: "not_configured", detail: "NEXT_PUBLIC_SUPABASE_URL is not set" });
    assert.equal((await checkSupabase({ url: URL_OK, key: `${KEY_OK}…` }, counting)).status, "not_configured");
    assert.equal(requests, 0);
  });
});

describe("the AI settings a deployment is expected to have", () => {
  const production = { AI_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY, EMBEDDING_PROVIDER: "gemini", GEMINI_MODEL: "gemini-3.8-flash", GEMINI_EMBEDDING_MODEL: "gemini-embedding-001" };

  it("uses Gemini for answers and for embeddings, and needs no other provider's key", async () => {
    await withEnv(production, () => {
      assert.equal(aiConfigProblem(), null);
      const model = getTutorModel({ effort: "medium" });
      assert.ok(model instanceof GeminiChat);
      assert.equal(model.model, "gemini-3.8-flash");

      assert.equal(embeddingConfigProblem(), null);
      const embeddings = getEmbeddingProvider();
      assert.ok(embeddings instanceof GeminiEmbeddings);
      assert.equal(embeddings.model, "gemini-embedding-001");
      assert.equal(embeddings.dimensions, 1536);
    });

    // The two model names are optional: without them the defaults are the same.
    await withEnv({ AI_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY, EMBEDDING_PROVIDER: "gemini" }, () => {
      assert.equal(getTutorModel().model, "gemini-3.8-flash");
      assert.equal(getEmbeddingProvider().model, DEFAULT_EMBEDDING_MODELS.gemini);
    });
  });

  it("names each variable a deployment left out", async () => {
    // Only the key was added: the providers default to Claude and OpenAI.
    await withEnv({ GEMINI_API_KEY: GEMINI_KEY }, () => {
      assert.match(aiConfigProblem()!, /AI_API_KEY is not set \(needed because the AI provider is anthropic\)/);
      assert.match(embeddingConfigProblem()!, /EMBEDDING_API_KEY is not set \(needed because the embedding provider is openai\)/);
    });
    await withEnv({ AI_PROVIDER: "gemini", EMBEDDING_PROVIDER: "gemini" }, () => {
      assert.match(aiConfigProblem()!, /GEMINI_API_KEY is not set/);
      assert.match(embeddingConfigProblem()!, /GEMINI_API_KEY is not set/);
      assert.throws(() => getTutorModel(), (error) => error instanceof TutorError && error.code === "NOT_CONFIGURED");
    });
  });

  it("answers the tutor API with a configuration error, not a connection error, when the key is missing", async () => {
    await withEnv({ AI_PROVIDER: "gemini" }, async () => {
      const w = world();
      const reply = await handleTutorChat(chatRequest({ message: "What is refraction?" }), { ...depsFor(w, USER), getModel: () => getTutorModel() });
      assert.equal(reply.status, 503);
      const body = (await reply.json()) as TutorErrorBody;
      assert.equal(body.code, "NOT_CONFIGURED");
      assert.doesNotMatch(body.error, /connection|GEMINI_API_KEY/i);
      // Checked before anything is saved, so no unanswered question is left.
      assert.equal(w.db.messages.length, 0);
    });
  });
});
