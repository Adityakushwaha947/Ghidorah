/**
 * Placeholder entry for the frontend workspace. Proves that the frontend package resolves the shared contracts
 * through the workspace and that a committed event validates. Replace this package with the real frontend.
 */
import { CONTRACT_VERSION, EventSchema } from "@ghidorah/contracts";

const event = EventSchema.parse({
  contractVersion: CONTRACT_VERSION,
  runId: "00000000-0000-4000-8000-000000000000",
  seq: 1,
  type: "run.started",
  target: "fixture://counter",
  mode: "pentest",
  capabilities: ["agentic_pentesting"],
  caps: { tokens: 1000, steps: 500, wallSec: 7200 },
});

console.log(JSON.stringify({ frontendWorkspace: "ready", contractVersion: CONTRACT_VERSION, sampleEvent: event.type }));
