export const SCHEMA = `
CREATE SCHEMA IF NOT EXISTS gidorah_mastra;
CREATE TABLE IF NOT EXISTS gidorah_mastra.schema_version (version integer PRIMARY KEY CHECK (version = 1));
INSERT INTO gidorah_mastra.schema_version VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS gidorah_mastra.runs (
  id uuid PRIMARY KEY,
  runtime_version text NOT NULL,
  config jsonb NOT NULL,
  target text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  finished_at timestamptz,
  seq integer NOT NULL DEFAULT 0 CHECK (seq >= 0),
  spent_tokens integer NOT NULL DEFAULT 0 CHECK (spent_tokens >= 0),
  spent_steps integer NOT NULL DEFAULT 0 CHECK (spent_steps >= 0),
  stop_requested boolean NOT NULL DEFAULT false,
  terminal jsonb,
  lease_owner uuid,
  lease_epoch integer NOT NULL DEFAULT 0,
  lease_until timestamptz
);
CREATE TABLE IF NOT EXISTS gidorah_mastra.events (
  run_id uuid NOT NULL REFERENCES gidorah_mastra.runs(id),
  seq integer NOT NULL,
  payload jsonb NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE TABLE IF NOT EXISTS gidorah_mastra.actions (
  run_id uuid NOT NULL REFERENCES gidorah_mastra.runs(id),
  call_id text NOT NULL,
  tool text NOT NULL,
  args_digest text NOT NULL,
  state text NOT NULL CHECK (state IN ('prepared', 'dispatched', 'completed')),
  artifact_ref text,
  PRIMARY KEY (run_id, call_id)
);
CREATE TABLE IF NOT EXISTS gidorah_mastra.model_calls (
  run_id uuid NOT NULL REFERENCES gidorah_mastra.runs(id),
  call_key text NOT NULL,
  request_digest text NOT NULL,
  request jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('dispatched', 'completed')),
  response jsonb,
  PRIMARY KEY (run_id, call_key)
);
CREATE TABLE IF NOT EXISTS gidorah_mastra.artifacts (
  run_id uuid NOT NULL REFERENCES gidorah_mastra.runs(id),
  ref text NOT NULL,
  bytes text NOT NULL,
  sha256 text NOT NULL,
  PRIMARY KEY (run_id, ref)
);
CREATE TABLE IF NOT EXISTS gidorah_mastra.fixture_targets (
  run_id uuid PRIMARY KEY REFERENCES gidorah_mastra.runs(id),
  counter integer NOT NULL DEFAULT 0
);
`;
