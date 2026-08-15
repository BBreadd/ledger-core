// provision.ts -- entry point: makes the roles the connection strings name able to
// connect. Depends on: config, pg.
//
// The migration decides what ledger_app and ledger_auditor may do and leaves both
// unable to log in. This grants the logging in. Keeping the two apart means a database
// that has only been migrated has no new way into it, and a credential never has to
// live in a migration file to get there.
//
// Runs after migrate, never before: the group roles it grants have to exist first.

import pg from "pg";
import { requireDatabaseUrl } from "../config.ts";
import type { DatabaseRole } from "../config.ts";

const MEMBERSHIPS: readonly { readonly role: DatabaseRole; readonly group: string }[] = [
  { role: "DATABASE_URL", group: "ledger_app" },
  { role: "DATABASE_AUDITOR_URL", group: "ledger_auditor" },
];

async function main(): Promise<void> {
  const client = new pg.Client({ connectionString: requireDatabaseUrl("DATABASE_ADMIN_URL") });
  await client.connect();

  try {
    for (const { role, group } of MEMBERSHIPS) {
      const login = credentialsIn(role);
      await ensureLogin(client, login);
      await ensureMembership(client, login.user, group);
      console.log(`${login.user} can log in and is a member of ${group}`);
    }
  } finally {
    await client.end();
  }
}

type Credentials = { readonly user: string; readonly password: string };

/**
 * The connection string is the single source of truth for who the application is. Asking
 * for the same username and password a second time, in their own variables, would create
 * two places to change and one of them would eventually be wrong.
 *
 * Parsed by constructing a client and reading it back rather than with the URL class,
 * because a libpq connection string is not always a valid WHATWG URL: the socket form
 * `postgresql://user:pass@/db?host=/var/run` has no authority and URL rejects it outright.
 * Letting the driver parse the string it is going to receive means provisioning cannot
 * disagree with the connection about who is being created.
 */
function credentialsIn(role: DatabaseRole): Credentials {
  const parsed = new pg.Client({ connectionString: requireDatabaseUrl(role) });
  const user = parsed.user ?? "";
  const password = typeof parsed.password === "string" ? parsed.password : "";

  if (user.length === 0 || password.length === 0) {
    throw new Error(`${role} must carry a username and a password for provisioning to act on`);
  }

  return { user, password };
}

/**
 * CREATE ROLE takes no parameters -- no DDL statement does, because an identifier is not
 * a value. Rather than escaping the name and the password by hand in JavaScript, the
 * statement is assembled by PostgreSQL's own format() with %I for the identifier and %L
 * for the literal, both passed in as bound parameters, and the quoted result is executed
 * verbatim. The escaping is done by the database that will parse it.
 */
async function ensureLogin(client: pg.Client, login: Credentials): Promise<void> {
  const existing = await client.query("select 1 from pg_roles where rolname = $1", [login.user]);
  const template =
    existing.rowCount === 0
      ? "create role %I login password %L"
      : "alter role %I login password %L";

  await client.query(await render(client, template, login.user, login.password));
}

async function ensureMembership(client: pg.Client, user: string, group: string): Promise<void> {
  await client.query(await render(client, "grant %I to %I", group, user));
}

async function render(
  client: pg.Client,
  template: string,
  first: string,
  second: string,
): Promise<string> {
  const result = await client.query<{ statement: string }>(
    "select format($1::text, $2::text, $3::text) as statement",
    [template, first, second],
  );

  const statement = result.rows[0]?.statement;
  if (statement === undefined) {
    throw new Error("format() returned no statement");
  }
  return statement;
}

await main();
