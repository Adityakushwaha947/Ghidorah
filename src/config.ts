import type { PoolConfig } from "pg";
import { GidorahError } from "./foundation/errors.js";

export function databaseConfig(environment: NodeJS.ProcessEnv = process.env): PoolConfig {
  if (environment.GIDORAH_DATABASE_PROFILE !== "local") {
    throw new GidorahError(
      "database_config",
      "Set GIDORAH_DATABASE_PROFILE=local explicitly. This public fixture does not support remote database profiles.",
    );
  }
  const connectionString = environment.GIDORAH_DATABASE_URL;
  if (!connectionString)
    throw new GidorahError(
      "database_config",
      "An explicit GIDORAH_DATABASE_URL is required; DATABASE_URL is never used as a fallback.",
    );
  let endpoint: URL;
  try {
    endpoint = new URL(connectionString);
  } catch {
    throw new GidorahError("database_config", "The local database URL is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(endpoint.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) ||
    endpoint.search ||
    endpoint.hash ||
    endpoint.pathname.length < 2
  ) {
    throw new GidorahError(
      "database_config",
      "Use an explicit PostgreSQL loopback database without query or fragment overrides.",
    );
  }
  return { connectionString, ssl: false };
}
