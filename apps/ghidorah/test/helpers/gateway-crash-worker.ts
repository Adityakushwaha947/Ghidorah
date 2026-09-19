import { GidorahBackend } from "../../src/backend.js";
import { databaseConfig } from "../../src/config.js";
import { FIXTURE_TARGET, fixtureConfig } from "@ghidorah/foundation";
import { modelCounter } from "./model-counter.js";

const point = process.argv[2];
const { profile } = modelCounter({ onRequest: () => process.stdout.write("PROVIDER_DISPATCH\n") });
const backend = new GidorahBackend(databaseConfig(), {
  modelProfile: profile,
  leaseTtlMs: 1000,
  fixtureHooks: {
    at: async (current) => {
      if (current === point) process.kill(process.pid, "SIGKILL");
    },
  },
});
const handle = backend.run(FIXTURE_TARGET, fixtureConfig({ model: profile.route.model, capTokens: 20000 }));
process.stdout.write(`RUN:${handle.runId}\n`);
try {
  for await (const _event of handle.events) {
  }
} finally {
  await backend.close();
}
