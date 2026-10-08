// Lets Node's built-in test runner load the app's TypeScript directly:
//
//   node --import ./tests/register.mjs --test tests/*.test.ts
//
// Node strips type annotations by itself. This hook adds the two things the
// bundler normally does: the "@/..." path alias and extensionless imports.
// It also replaces "server-only" (which throws outside Next.js) with nothing.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");

function withExtension(path) {
  for (const candidate of [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`]) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      if (candidate === path && !/\.[a-z]+$/i.test(path)) continue;
      return candidate;
    }
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { url: "data:text/javascript,", shortCircuit: true };
    }

    let path = null;
    if (specifier.startsWith("@/")) {
      path = resolvePath(root, specifier.slice(2));
    } else if (specifier.startsWith(".") && context.parentURL?.startsWith("file:") && !context.parentURL.includes("/node_modules/")) {
      path = resolvePath(dirname(fileURLToPath(context.parentURL)), specifier);
    }

    const resolved = path && withExtension(path);
    if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
