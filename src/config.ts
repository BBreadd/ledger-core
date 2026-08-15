// config.ts -- the only place that reads the environment. Depends on: nothing.

/**
 * One connection string per role, because one connection string would mean one set of
 * privileges and the whole point is that these three cannot do the same things.
 *
 * There is no fallback between them on purpose. Letting the auditor quietly borrow the
 * application's URL, or the application borrow the owner's, would mean a deployment that
 * forgot to configure a role runs with more power than it asked for and nothing says so.
 * A missing variable is a startup failure with a message; a silent fallback is a hole.
 */
export type DatabaseRole = "DATABASE_URL" | "DATABASE_ADMIN_URL" | "DATABASE_AUDITOR_URL";

const ROLES: Readonly<Record<DatabaseRole, string>> = {
  DATABASE_URL: "the application role: may read and append, never update or delete",
  DATABASE_ADMIN_URL: "the owning role: runs migrations, provisions logins, sets up test data",
  DATABASE_AUDITOR_URL: "the read-only role the reconciliation job runs as",
};

export type Config = {
  readonly databaseUrl: string;
};

/**
 * Fails at startup rather than at the first query. A process that boots half-configured
 * is worse than one that refuses to boot.
 */
export function requireDatabaseUrl(
  role: DatabaseRole,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const url = env[role]?.trim();

  if (url === undefined || url.length === 0) {
    throw new Error(
      `${role} is not set. It is ${ROLES[role]}. ` +
        "Copy .env.example to .env, then run `npm run provision` so the roles it names exist.",
    );
  }

  return url;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return { databaseUrl: requireDatabaseUrl("DATABASE_URL", env) };
}
