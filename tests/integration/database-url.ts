// database-url.ts -- resolves the databases for the integration suites, and refuses to let
// them be skipped where skipping would be a lie.

const applicationUrl = process.env["DATABASE_URL"];
const adminUrl = process.env["DATABASE_ADMIN_URL"];
const auditorUrl = process.env["DATABASE_AUDITOR_URL"];

const missing = [
  applicationUrl === undefined ? "DATABASE_URL" : null,
  adminUrl === undefined ? "DATABASE_ADMIN_URL" : null,
  auditorUrl === undefined ? "DATABASE_AUDITOR_URL" : null,
].filter((name) => name !== null);

/**
 * Locally, no database means "skip these and get on with the pure core". In CI it means the
 * run proved nothing, and a green check that proved nothing is worse than a red one: nobody
 * investigates a pass. Any CI provider that marks itself in the environment is treated as
 * one, because failing to notice a real CI is the expensive mistake here, and a stray CI
 * variable on a laptop fails loudly with a message that says exactly what happened.
 *
 * All three are required together. A run with only DATABASE_URL could still execute most
 * of the suite while silently dropping the tests that prove the application cannot delete
 * a posting -- which is precisely the claim least worth taking on trust.
 */
if (missing.length > 0 && process.env["CI"] !== undefined) {
  throw new Error(
    `${missing.join(", ")} not set while CI is. Integration tests must never be skipped in ` +
      "CI: a run that skips them is not evidence that anything works.",
  );
}

export const skipWithoutDatabase = missing.length > 0 ? `${missing.join(", ")} not set` : false;

/** The application role: reads and appends, and is refused anything else. */
export const integrationDatabaseUrl = applicationUrl;

/**
 * The owner. Used only where a test has to do something the application deliberately
 * cannot -- setting up fixtures, and undoing a violation it committed on purpose.
 */
export const integrationAdminUrl = adminUrl;

/** The read-only role the reconciliation job runs as. */
export const integrationAuditorUrl = auditorUrl;
