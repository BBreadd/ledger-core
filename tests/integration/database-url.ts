// database-url.ts -- resolves the database for the integration suites, and refuses to let
// them be skipped where skipping would be a lie.

const databaseUrl = process.env["DATABASE_URL"];

/**
 * Locally, no database means "skip these and get on with the pure core". In CI it means the
 * run proved nothing, and a green check that proved nothing is worse than a red one: nobody
 * investigates a pass. Any CI provider that marks itself in the environment is treated as
 * one, because failing to notice a real CI is the expensive mistake here, and a stray CI
 * variable on a laptop fails loudly with a message that says exactly what happened.
 */
if (databaseUrl === undefined && process.env["CI"] !== undefined) {
  throw new Error(
    "DATABASE_URL is not set while CI is. Integration tests must never be skipped in CI: " +
      "a run that skips them is not evidence that anything works.",
  );
}

export const integrationDatabaseUrl = databaseUrl;

export const skipWithoutDatabase = databaseUrl === undefined ? "DATABASE_URL is not set" : false;
