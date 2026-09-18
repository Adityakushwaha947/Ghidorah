import { GidorahBackend } from "./backend.js";
import { databaseConfig } from "./config.js";
import { CONTRACT_VERSION, FIXTURE_TARGET, fixtureConfig, type RunHandle } from "./foundation/contracts.js";
import { publicError } from "./foundation/errors.js";
import { initializeDatabase } from "./storage/bootstrap.js";

const context = { contractVersion: CONTRACT_VERSION };
let backend: GidorahBackend | undefined;
let handle: RunHandle | undefined;
const stop = (): void => { handle?.control({ ...context, type: "stop" }); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const [command, argument] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log("Gidorah development fixture (Mastra runtime)\n\nCommands: init | fixture | recover <runId> | inspect <runId>\n\nNo live targets, paid model calls, shell tools or vulnerability verdicts are enabled.");
  } else if (command === "init") {
    await initializeDatabase(databaseConfig());
    console.log("Initialized only the gidorah_mastra and gidorah_mastra_runtime fixture schemas in the explicitly selected local database.");
  } else if (["fixture", "recover", "inspect"].includes(command)) {
    if (command !== "fixture" && !argument) throw new Error("Missing run ID.");
    backend = new GidorahBackend(databaseConfig());
    if (command === "inspect") {
      console.log(JSON.stringify({ snapshot: await backend.journal.snapshot(argument!), actions: await backend.journal.actions(argument!) }, null, 2));
    } else {
      console.error("DEVELOPMENT FIXTURE ONLY: no customer target or security assessment.");
      handle = command === "fixture" ? backend.run(FIXTURE_TARGET, fixtureConfig()) : backend.recover(argument!, context);
      console.error(`Run: ${handle.runId}`);
      for await (const event of handle.events) {
        console.log(JSON.stringify(event));
        if (event.type === "error" && event.fatal) process.exitCode = 1;
        if (event.type === "run.finished" && event.outcome !== "completed") process.exitCode = 1;
        if (event.type === "run.snapshot" && event.terminal && event.terminal.outcome !== "completed") process.exitCode = 1;
      }
    }
  } else {
    console.error("Unknown command. Run npm run cli -- help.");
    process.exitCode = 1;
  }
} catch (error) {
  console.error(publicError(error));
  process.exitCode = 1;
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
  await backend?.close();
}
