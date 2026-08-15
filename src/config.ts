// config.ts -- the only place that reads the environment. Depends on: nothing.

export type Config = {
  readonly databaseUrl: string;
};

/**
 * Fails at startup rather than at the first query. A process that boots half-configured
 * is worse than one that refuses to boot.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env["DATABASE_URL"]?.trim();

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env, or export it: " +
        "DATABASE_URL=postgresql://ledger:ledger@localhost:5432/ledger",
    );
  }

  return { databaseUrl };
}
