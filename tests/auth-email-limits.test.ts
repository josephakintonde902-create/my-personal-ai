// Emails Supabase refuses to send.
//
// The failure these guard against: new students signing up on the hosted app
// were told "We've sent a few emails already. Please wait a minute before
// trying again." They had been sent nothing, and waiting a minute did not
// help. Supabase's built-in email sender had reached its hourly limit for the
// whole project, which it reports under the same error code as one address
// asking twice within a minute.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClient } from "@supabase/supabase-js";
import { EMAIL_DELIVERY_MESSAGE, EMAIL_LIMIT_MESSAGES, EMAIL_RESEND_SECONDS, emailDeliveryFailed, emailLimit, friendlyAuthError } from "@/lib/auth/errors";

const URL_OK = "https://abcdefghijklmnopqrst.supabase.co";
// Shaped like a real key. Not real.
const KEY_OK = "sb_publishable_TESTnotARealKey00000000000000";

// The two refusals, as Supabase Auth sends them.
const PROJECT_LIMIT = { code: 429, error_code: "over_email_send_rate_limit", msg: "email rate limit exceeded" };
const ADDRESS_LIMIT = { code: 429, error_code: "over_email_send_rate_limit", msg: "For security purposes, you can only request this after 43 seconds." };

// A Supabase client whose network is replaced, counting what it sends.
function clientAnswering(status: number, body: unknown) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const supabase = createClient(URL_OK, KEY_OK, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: async (input, init) => {
        requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body ?? "{}")) });
        return Response.json(body, { status });
      },
    },
  });
  return { supabase, requests };
}

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

describe("emails Supabase refuses to send", () => {
  it("tells a new student the truth when the project's hourly limit is used up", async () => {
    const { supabase } = clientAnswering(429, PROJECT_LIMIT);
    const { error } = await supabase.auth.signUp({ email: "new-student@example.com", password: "correct horse battery 1" });
    assert.equal(emailLimit(error), "PROJECT");

    const { result: message, logged } = silently(() => friendlyAuthError(error, "sign-up"));
    assert.equal(message, EMAIL_LIMIT_MESSAGES.PROJECT);
    // Nothing was sent to them, and a minute will not fix it.
    assert.doesNotMatch(message, /sent a few emails|wait a minute/i);
    assert.match(message, /on our side/);
    assert.match(message, /hour/);
    // The log says which limit it was and what lifts it.
    assert.match(logged, /"emailLimit":"PROJECT"/);
    assert.match(logged, /custom SMTP/);
  });

  it("tells a student who asked twice within a minute to wait a minute", async () => {
    const { supabase } = clientAnswering(429, ADDRESS_LIMIT);
    const { error } = await supabase.auth.resend({ type: "signup", email: "student@example.com" });
    assert.equal(emailLimit(error), "ADDRESS");

    const { result: message, logged } = silently(() => friendlyAuthError(error, "resend verification"));
    assert.equal(message, EMAIL_LIMIT_MESSAGES.ADDRESS);
    assert.match(message, /wait a minute/);
    assert.match(logged, /"emailLimit":"ADDRESS"/);
    assert.doesNotMatch(logged, /custom SMTP/);
  });

  it("reports a password reset the same two ways", async () => {
    for (const [body, expected] of [[PROJECT_LIMIT, "PROJECT"], [ADDRESS_LIMIT, "ADDRESS"]] as const) {
      const { supabase } = clientAnswering(429, body);
      const { error } = await supabase.auth.resetPasswordForEmail("student@example.com");
      assert.equal(emailLimit(error), expected);
    }
  });

  it("does not mistake other failures for an email limit", async () => {
    const tooManyRequests = await clientAnswering(429, { code: 429, error_code: "over_request_rate_limit", msg: "Too many requests" }).supabase.auth.signUp({ email: "a@example.com", password: "correct horse battery 1" });
    assert.equal(emailLimit(tooManyRequests.error), null);
    assert.match(silently(() => friendlyAuthError(tooManyRequests.error, "sign-up")).result, /Too many attempts/);

    assert.equal(emailLimit(null), null);
    assert.equal(emailLimit(new Error("email rate limit exceeded")), null);
  });

  it("never shows or logs the address, or Supabase's own wording", async () => {
    const { supabase } = clientAnswering(429, PROJECT_LIMIT);
    const { error } = await supabase.auth.signUp({ email: "private-address@example.com", password: "correct horse battery 1" });
    const { result: message, logged } = silently(() => friendlyAuthError(error, "sign-up"));
    for (const text of [message, logged]) {
      assert.ok(!text.includes("private-address@example.com"));
      assert.ok(!text.includes("email rate limit exceeded"));
    }
  });
});

describe("emails Supabase's SMTP provider does not take", () => {
  // What Supabase answers when custom SMTP is switched on but the provider
  // refuses the email. Seen on the hosted app for every new sign-up.
  const UNDELIVERED = { code: 500, error_code: "unexpected_failure", msg: "Error sending confirmation email" };

  it("says the email could not be sent, and logs where to look", async () => {
    const { supabase } = clientAnswering(500, UNDELIVERED);
    const { error } = await supabase.auth.signUp({ email: "private-address@example.com", password: "correct horse battery 1" });
    assert.equal(emailDeliveryFailed(error), true);

    const { result: message, logged } = silently(() => friendlyAuthError(error, "sign-up"));
    assert.equal(message, EMAIL_DELIVERY_MESSAGE);
    assert.match(message, /couldn't send your email/);
    assert.match(logged, /"emailDelivery":"FAILED"/);
    assert.match(logged, /SMTP/);
    // Not the hint for a wrong Supabase URL or key, which this is not.
    assert.doesNotMatch(logged, /api\/health/);
    assert.ok(!logged.includes("private-address@example.com"));
  });

  it("recognises the same failure for a password reset, and nothing else as it", async () => {
    const reset = await clientAnswering(500, { ...UNDELIVERED, msg: "Error sending recovery email" }).supabase.auth.resetPasswordForEmail("student@example.com");
    assert.equal(emailDeliveryFailed(reset.error), true);

    const outage = await clientAnswering(503, { message: "upstream unavailable" }).supabase.auth.signUp({ email: "a@example.com", password: "correct horse battery 1" });
    assert.equal(emailDeliveryFailed(outage.error), false);
    assert.match(silently(() => friendlyAuthError(outage.error, "sign-up")).result, /temporarily unavailable/);

    const limited = await clientAnswering(429, PROJECT_LIMIT).supabase.auth.signUp({ email: "a@example.com", password: "correct horse battery 1" });
    assert.equal(emailDeliveryFailed(limited.error), false);
  });
});

describe("one action, one email", () => {
  // The app calls each of these once per form submission. If the library
  // tried again by itself after a refusal, one press would spend the
  // project's hourly allowance several times over.
  it("makes exactly one request per sign-up, resend and password reset, even when refused", async () => {
    for (const status of [200, 429] as const) {
      const body = status === 200 ? { id: "11111111-1111-4111-8111-111111111111", email: "student@example.com", identities: [{}] } : PROJECT_LIMIT;

      const signUp = clientAnswering(status, body);
      await signUp.supabase.auth.signUp({ email: "student@example.com", password: "correct horse battery 1" });
      assert.deepEqual(signUp.requests.map((request) => request.path), ["/auth/v1/signup"], `sign-up answered ${status}`);

      const resend = clientAnswering(status, status === 200 ? {} : ADDRESS_LIMIT);
      await resend.supabase.auth.resend({ type: "signup", email: "student@example.com" });
      assert.deepEqual(resend.requests.map((request) => request.path), ["/auth/v1/resend"], `resend answered ${status}`);

      const reset = clientAnswering(status, status === 200 ? {} : PROJECT_LIMIT);
      await reset.supabase.auth.resetPasswordForEmail("student@example.com");
      assert.deepEqual(reset.requests.map((request) => request.path), ["/auth/v1/recover"], `password reset answered ${status}`);
    }
  });

  it("signing in sends no email at all", async () => {
    const { supabase, requests } = clientAnswering(400, { code: 400, error_code: "email_not_confirmed", msg: "Email not confirmed" });
    const { error } = await supabase.auth.signInWithPassword({ email: "student@example.com", password: "correct horse battery 1" });
    assert.equal(error?.code, "email_not_confirmed");
    // An unverified student is offered a resend button; nothing is resent for them.
    assert.deepEqual(requests.map((request) => request.path), ["/auth/v1/token"]);
  });

  it("makes the resend button wait as long as Supabase makes an address wait", () => {
    assert.equal(EMAIL_RESEND_SECONDS, 60);
  });
});
