import { PositiveIntegerSchema, RunConfigSchema, type RunConfig } from "@ghidorah/contracts";
import { digest, FIXTURE_MODEL, GidorahError, validateFixtureRun } from "@ghidorah/foundation";
import type { ModelRoute } from "@ghidorah/model";
import type { InputTokenBound } from "../storage/model-dispatch-journal.js";

export type CounterModelProfile = Readonly<{
  route: ModelRoute;
  inputBound: InputTokenBound;
  inputBoundRevision: string;
  maxOutputTokens: number;
  timeoutMs: number;
  runtimeVersion: string;
}>;

export function counterModelProfile(input: Omit<CounterModelProfile, "runtimeVersion">): CounterModelProfile {
  PositiveIntegerSchema.parse(input.maxOutputTokens);
  PositiveIntegerSchema.parse(input.timeoutMs);
  if (!input.inputBoundRevision || typeof input.inputBound !== "function" || input.route.model === FIXTURE_MODEL)
    throw new GidorahError("model_profile", "An explicit model route and versioned input bound are required.");
  const route = Object.freeze({
    ...input.route,
    responseModels: Object.freeze([...input.route.responseModels]),
    sampling: Object.freeze([...input.route.sampling]),
  });
  const identity = {
    routeId: route.id,
    provider: route.provider,
    model: route.model,
    responseModels: route.responseModels,
    sampling: route.sampling,
    inputBoundRevision: input.inputBoundRevision,
    maxOutputTokens: input.maxOutputTokens,
    timeoutMs: input.timeoutMs,
  };
  return Object.freeze({ ...input, route, runtimeVersion: `ghidorah-model-counter/1:${digest(identity)}` });
}

export function validateCounterRun(target: string, input: unknown, profile?: CounterModelProfile): RunConfig {
  if (!profile) return validateFixtureRun(target, input);
  const config = RunConfigSchema.parse(input);
  if (config.model !== profile.route.model)
    throw new GidorahError(
      "unsupported_profile",
      "The requested model does not match the explicitly configured route.",
    );
  validateFixtureRun(target, { ...config, model: FIXTURE_MODEL });
  return config;
}
