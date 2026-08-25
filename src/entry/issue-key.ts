// issue-key.ts -- entry point: mints a credential for a tenant and prints it once.
// Depends on: config, adapters, pg.
//
// Runs as the owner, and that is the same line 0002 drew between what a role may do and
// who may become one. The migration creates the tenants and settles what the application
// may read; nothing that holds a secret can live in a versioned file, so issuing is a
// command rather than a migration. The application role, which is what the server connects
// with, holds SELECT on api_keys and nothing else -- it authenticates callers and cannot
// invent one.
//
//   npm run issue-key -- <name> [--scope read|write] [--tenant <uuid>]

import pg from "pg";
import { requireDatabaseUrl } from "../config.ts";
import { mintToken } from "../adapters/api-token.ts";
import { createUuidV7 } from "../adapters/uuid-v7.ts";
import type { Scope } from "../application/ports.ts";

/** The tenant migration 0007 seeds, so that issuing a first key needs no other argument. */
const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

type Arguments = {
  readonly name: string;
  readonly scope: Scope;
  readonly tenantId: string;
};

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const client = new pg.Client({ connectionString: requireDatabaseUrl("DATABASE_ADMIN_URL") });
  await client.connect();

  try {
    const tenant = await client.query<{ name: string }>("select name from tenants where id = $1", [
      args.tenantId,
    ]);
    const tenantName = tenant.rows[0]?.name;
    if (tenantName === undefined) {
      throw new Error(`no tenant with id ${args.tenantId}`);
    }

    const id = createUuidV7()();
    const minted = mintToken(id);

    await client.query(
      "insert into api_keys (id, tenant_id, name, secret_hash, scope) values ($1, $2, $3, $4, $5)",
      [id, args.tenantId, args.name, Buffer.from(minted.secretHash), args.scope],
    );

    // Printed here and nowhere else, ever. Only the digest was stored, so this is not a
    // value the system can be asked for a second time -- losing it means issuing another
    // key and revoking this one, which is the property that makes the digest worth storing.
    console.log(`key ${id} issued to ${tenantName} (${args.tenantId}) with scope ${args.scope}`);
    console.log("");
    console.log(minted.token);
    console.log("");
    console.log("This is the only time the token is shown. Store it now.");
  } finally {
    await client.end();
  }
}

function parseArguments(argv: readonly string[]): Arguments {
  let name: string | undefined;
  let scope: Scope = "write";
  let tenantId = DEFAULT_TENANT;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--scope") {
      const value = argv[index + 1];
      if (value !== "read" && value !== "write") {
        throw new Error(`--scope must be read or write, got ${JSON.stringify(value)}`);
      }
      scope = value;
      index += 1;
      continue;
    }

    if (argument === "--tenant") {
      const value = argv[index + 1];
      if (value === undefined || value.length === 0) {
        throw new Error("--tenant must be followed by a tenant id");
      }
      tenantId = value;
      index += 1;
      continue;
    }

    if (argument === undefined || argument.startsWith("--")) {
      throw new Error(`unrecognised argument ${JSON.stringify(argument)}`);
    }

    if (name !== undefined) {
      throw new Error("only one name may be given");
    }
    name = argument;
  }

  if (name === undefined || name.trim().length === 0) {
    throw new Error(
      "usage: npm run issue-key -- <name> [--scope read|write] [--tenant <uuid>]\n" +
        "The name is how a person tells one credential from another when revoking it.",
    );
  }

  return { name: name.trim(), scope, tenantId };
}

await main();
