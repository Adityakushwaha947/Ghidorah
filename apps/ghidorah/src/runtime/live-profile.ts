import { OpenRouterClient } from "@ghidorah/model";
import { GidorahError } from "@ghidorah/foundation";
import { byteInputBound } from "../storage/model-dispatch-journal.js";
import { counterModelProfile, type CounterModelProfile } from "./model-profile.js";

/** Pinned live route for the counter fixture. Change deliberately; the profile's runtime version changes with it. */
export const LIVE_ROUTE = Object.freeze({
  model: "z-ai/glm-4.7",
  upstreams: Object.freeze(["DeepInfra"]),
  maxOutputTokens: 1024,
  timeoutMs: 90_000,
  inputBoundRevision: "development-byte-bound-v1",
});

/**
 * Builds the live counter profile from the process environment. The credential is read from `OPENROUTER_API_KEY`
 * only; this never opens a file. Anything else about the route is fixed above so a recovered run resolves to the
 * same runtime identity as the run that created it.
 */
export function liveCounterProfile(environment: NodeJS.ProcessEnv = process.env): CounterModelProfile {
  const apiKey = environment.OPENROUTER_API_KEY;
  if (!apiKey)
    throw new GidorahError(
      "model_credential_missing",
      "OPENROUTER_API_KEY is not set. The live counter route needs it in the process environment.",
    );
  const client = new OpenRouterClient({
    apiKey,
    model: LIVE_ROUTE.model,
    upstreams: LIVE_ROUTE.upstreams,
    referer: "https://github.com/Adityakushwaha947/Ghidorah",
    title: "Ghidorah counter fixture",
  });
  return counterModelProfile({
    route: {
      id: `openrouter:${LIVE_ROUTE.model}:${LIVE_ROUTE.upstreams.join(",")}`,
      provider: "openrouter",
      model: LIVE_ROUTE.model,
      responseModels: [LIVE_ROUTE.model],
      sampling: ["temperature", "seed"],
      client,
    },
    inputBound: byteInputBound,
    inputBoundRevision: LIVE_ROUTE.inputBoundRevision,
    maxOutputTokens: LIVE_ROUTE.maxOutputTokens,
    timeoutMs: LIVE_ROUTE.timeoutMs,
  });
}
