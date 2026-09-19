import { GidorahBackend } from "./backend.js";
import { databaseConfig } from "./config.js";
import { CONTRACT_VERSION, FIXTURE_TARGET, fixtureConfig, type RunHandle } from "@ghidorah/foundation";
import { publicError } from "@ghidorah/foundation";
import { initializeDatabase } from "./storage/bootstrap.js";
import { LIVE_ROUTE, liveCounterProfile } from "./runtime/live-profile.js";

// The live route reserves a byte-based input bound plus the output cap per model call, so it needs a larger token
// cap than the synthetic fixture. Steps and wall time keep the fixture defaults.
const LIVE_CAP_TOKENS = 60_000;

const context = { contractVersion: CONTRACT_VERSION };
let backend: GidorahBackend | undefined;
let handle: RunHandle | undefined;
const stop = (): void => {
  handle?.control({ ...context, type: "stop" });
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

try {
  const [command, argument] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") {
    console.log(
      `Ghidorah development fixture (Mastra runtime)\n\nCommands: init | fixture | recover <runId> | inspect <runId> | fixture-live | recover-live <runId>\n\nfixture runs the counter on the synthetic model. fixture-live runs the same counter on ${LIVE_ROUTE.model} through OpenRouter (pinned upstream ${LIVE_ROUTE.upstreams.join(",")}); it needs OPENROUTER_API_KEY in the environment and makes paid model calls with a ${LIVE_CAP_TOKENS}-token cap.\n\nNo live targets, shell tools or vulnerability verdicts are enabled.`,
    );
  } else if (command === "init") {
    await initializeDatabase(databaseConfig());
    console.log(
      "Initialized only the gidorah_mastra and gidorah_mastra_runtime fixture schemas in the explicitly selected local database.",
    );
  } else if (["fixture", "recover", "inspect", "fixture-live", "recover-live"].includes(command)) {
    if (!["fixture", "fixture-live"].includes(command) && !argument) throw new Error("Missing run ID.");
    const live = command.endsWith("-live");
    backend = new GidorahBackend(databaseConfig(), live ? { modelProfile: liveCounterProfile() } : {});
    if (command === "inspect") {
      console.log(
        JSON.stringify(
          { snapshot: await backend.journal.snapshot(argument!), actions: await backend.journal.actions(argument!) },
          null,
          2,
        ),
      );
    } else {
      console.error("DEVELOPMENT FIXTURE ONLY: no customer target or security assessment.");
      if (live)
        console.error(`LIVE MODEL: ${LIVE_ROUTE.model} via OpenRouter, upstream ${LIVE_ROUTE.upstreams.join(",")}.`);
      handle =
        command === "fixture"
          ? backend.run(FIXTURE_TARGET, fixtureConfig())
          : command === "fixture-live"
            ? backend.run(FIXTURE_TARGET, fixtureConfig({ model: LIVE_ROUTE.model, capTokens: LIVE_CAP_TOKENS }))
            : backend.recover(argument!, context);
      console.error(`Run: ${handle.runId}`);
      for await (const event of handle.events) {
        console.log(JSON.stringify(event));
        if (event.type === "error" && event.fatal) process.exitCode = 1;
        if (event.type === "run.finished" && event.outcome !== "completed") process.exitCode = 1;
        if (event.type === "run.snapshot" && event.terminal && event.terminal.outcome !== "completed")
          process.exitCode = 1;
      }
    }
  } else {
    console.error("Unknown command. Run bun run cli help.");
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
