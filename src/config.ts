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

export type ServerConfig = {
  readonly databaseUrl: string;
  readonly port: number;
  readonly apiToken: string;
};

const DEFAULT_PORT = 8080;

/**
 * Short tokens are refused at startup rather than accepted and regretted. A bearer token is
 * the only thing between the open internet and a write endpoint on a ledger, and one that
 * fits in a wordlist is not a secret. Thirty-two characters is what `openssl rand -hex 16`
 * produces, which is what the README tells the operator to run.
 */
const MIN_TOKEN_LENGTH = 32;

/**
 * The server connects with DATABASE_URL, never with the owner's. It has no business
 * migrating anything, and the role it runs as is what makes a posting immutable.
 */
export function loadServerConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const token = env["API_TOKEN"]?.trim() ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `API_TOKEN must be set and at least ${MIN_TOKEN_LENGTH} characters. ` +
        "Generate one with `openssl rand -hex 16`.",
    );
  }

  return {
    databaseUrl: requireDatabaseUrl("DATABASE_URL", env),
    port: readPort(env["PORT"]),
    apiToken: token,
  };
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw.trim().length === 0) {
    return DEFAULT_PORT;
  }

  // Written out rather than left to Number(), which reads "8080abc" as NaN but "0x1f90" as
  // 8080 and " 80 " as 80. A port that was mistyped should stop the process, not bind
  // something plausible.
  if (!/^\d{1,5}$/.test(raw.trim())) {
    throw new Error(`PORT must be a number between 0 and 65535, got ${JSON.stringify(raw)}`);
  }

  const port = Number(raw.trim());
  if (port > 65535) {
    throw new Error(`PORT must be a number between 0 and 65535, got ${port}`);
  }
  return port;
}
