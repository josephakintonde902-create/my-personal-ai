// Checks that Ari's AI provider is reachable with the settings in .env.local.
//
//   npm run ai:check                  the provider named by AI_PROVIDER
//   npm run ai:check -- --embeddings  also the embedding provider
//
// It sends one very short request through the same provider code the tutor,
// quizzes, flashcards and short-answer marking use, and reports what came
// back. It runs on your machine, on the server side only. API keys are read
// from the environment and are never printed, in whole or in part.
import { embeddingConfigProblem, embeddingModel, embeddingProviderName, getEmbeddingProvider } from "@/lib/ai/embeddings/provider";
import { ProcessingError } from "@/lib/ai/errors";
import { TUTOR_ERRORS, TutorError } from "@/lib/ai/tutor/errors";
import { aiConfigProblem, aiModel, aiProvider, aiSettings, getTutorModel, type AiProvider } from "@/lib/ai/tutor/provider";

const ADVICE: Partial<Record<keyof typeof TUTOR_ERRORS, string>> = {
  PROVIDER_AUTH: "The provider rejected the key. Check that it is a valid key for this provider.",
  PROVIDER_BILLING: "The account has no credit. Add credit with the provider, or switch AI_PROVIDER to another one.",
  PROVIDER_RATE_LIMITED: "The provider is rate limiting this key, or its free quota is used up for now. Wait and run this again.",
  PROVIDER_UNAVAILABLE: "The provider could not serve the request. If the detail mentions a model, check the model name.",
  TIMEOUT: "The provider did not answer in time. Check your connection and run this again.",
};

async function checkGeneration() {
  let provider: AiProvider;
  try {
    provider = aiProvider();
  } catch (error) {
    console.log(`AI provider:  not valid (${(error as TutorError).detail})`);
    return false;
  }

  const settings = aiSettings(provider);
  console.log(`AI provider:  ${provider} (${settings.name})`);
  console.log(`Model:        ${aiModel(provider)}  (set ${settings.model} to change it)`);
  console.log(`API key:      ${settings.key} is ${process.env[settings.key]?.trim() ? "set" : "NOT SET"}`);

  // Settings that do not fit together are reported without calling anyone,
  // so a key is never sent to a provider it does not belong to.
  const problem = aiConfigProblem();
  if (problem) {
    console.log(`\nNOT CONFIGURED: ${problem}.`);
    return false;
  }

  const started = Date.now();
  try {
    const model = getTutorModel({ maxOutputTokens: 200, effort: "low" });
    let reply = "";
    for await (const piece of await model.streamChat([
      { role: "system", content: "You are a connection test. Follow the instruction exactly." },
      { role: "user", content: "Reply with the single word: ready" },
    ])) {
      reply += piece;
    }

    if (!reply.trim()) {
      console.log("\nFAILED: the provider answered, but with no text.");
      return false;
    }
    console.log(`\nOK: the model replied "${reply.trim().slice(0, 60)}" in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
    console.log("Ari can use this provider for tutoring, quizzes, flashcards and marking.");
    return true;
  } catch (error) {
    const failure = error instanceof TutorError ? error : new TutorError("UNKNOWN", (error as Error)?.name);
    console.log(`\nFAILED: ${failure.code}`);
    if (failure.detail) console.log(`Detail:  ${failure.detail}`);
    console.log(`Students would see: "${failure.message}"`);
    if (ADVICE[failure.code]) console.log(`What to do: ${ADVICE[failure.code]}`);
    return false;
  }
}

async function checkEmbeddings() {
  const provider = embeddingProviderName();
  console.log(`\nEmbeddings:   ${provider ?? "not valid"}${provider ? `, model ${embeddingModel(provider)}` : ""}`);

  const problem = embeddingConfigProblem();
  if (problem) {
    console.log(`NOT CONFIGURED: ${problem}.`);
    return false;
  }

  try {
    const embeddings = getEmbeddingProvider();
    const vector = await embeddings.embedQuery("connection test");
    if (vector.length !== embeddings.dimensions) {
      console.log(`FAILED: got a vector of ${vector.length} numbers, expected ${embeddings.dimensions}.`);
      return false;
    }
    console.log(`OK: received a ${vector.length}-dimension vector. Study materials can be processed and searched.`);
    return true;
  } catch (error) {
    console.log(`FAILED: ${error instanceof ProcessingError ? `${error.code} (${error.detail})` : (error as Error)?.name}`);
    return false;
  }
}

const generationOk = await checkGeneration();
if (process.argv.includes("--embeddings")) {
  const embeddingsOk = await checkEmbeddings();
  process.exitCode = generationOk && embeddingsOk ? 0 : 1;
} else {
  const provider = embeddingProviderName();
  console.log(`\nEmbeddings use ${provider ?? "an unknown provider"} and were not tested. Add "-- --embeddings" to test them too.`);
  process.exitCode = generationOk ? 0 : 1;
}
