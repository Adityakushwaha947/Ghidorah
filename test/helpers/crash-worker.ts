import { GidorahBackend } from "../../src/backend.js";
import { databaseConfig } from "../../src/config.js";
import { CONTRACT_VERSION, FIXTURE_TARGET, fixtureConfig } from "../../src/foundation/fixture-contract.js";
import { publicError } from "../../src/foundation/errors.js";

const [point, resumeRunId] = process.argv.slice(2);
const backend = new GidorahBackend(databaseConfig(), {
  leaseTtlMs: 3000,
  fixtureHooks: {
    at: async (current) => {
      if (current === point) {
        await new Promise<void>((resolve, reject) => {
          process.stdout.write(`${JSON.stringify({ faultPoint: current })}\n`, (error) =>
            error ? reject(error) : resolve(),
          );
        });
        process.kill(process.pid, "SIGKILL");
        await new Promise<void>(() => undefined);
      }
    },
  },
});

try {
  const handle = resumeRunId
    ? backend.recover(resumeRunId, { contractVersion: CONTRACT_VERSION })
    : backend.run(FIXTURE_TARGET, fixtureConfig());
  console.log(JSON.stringify({ runId: handle.runId }));
  for await (const event of handle.events) console.log(JSON.stringify(event));
} catch (error) {
  console.error(publicError(error));
  process.exitCode = 1;
} finally {
  await backend.close();
}
