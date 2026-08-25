// revoke-key.ts -- entry point: stops a credential from working, immediately.
// Depends on: config, pg.
//
// Runs as the owner for the same reason issuing does: the application may read credentials
// and may not change them. Takes the key id, which `issue-key` prints and which appears on
// every request line the server logs -- so the thing needed to revoke a credential is
// already in front of whoever noticed the problem.
//
//   npm run revoke-key -- <key-id>

import pg from "pg";
import { requireDatabaseUrl } from "../config.ts";

async function main(): Promise<void> {
  const id = process.argv[2];
  if (id === undefined || id.trim().length === 0) {
    throw new Error("usage: npm run revoke-key -- <key-id>");
  }

  const client = new pg.Client({ connectionString: requireDatabaseUrl("DATABASE_ADMIN_URL") });
  await client.connect();

  try {
    // Already-revoked keys are left alone rather than re-stamped, so the timestamp keeps
    // saying when the credential actually stopped working. Running this twice is not an
    // error and does not rewrite that.
    const result = await client.query<{ name: string; revoked_at: Date }>(
      `update api_keys
          set revoked_at = now()
        where id = $1
          and revoked_at is null
      returning name, revoked_at`,
      [id.trim()],
    );

    const row = result.rows[0];
    if (row === undefined) {
      // Deliberately one message for both cases. Whether the key never existed or was
      // revoked last Tuesday, the state afterwards is the same and the operator needs no
      // more than that.
      console.log(`no live key with id ${id.trim()}; nothing to do`);
      return;
    }

    console.log(`key ${id.trim()} (${row.name}) revoked at ${row.revoked_at.toISOString()}`);
    console.log("It stops working on the next request: nothing caches credentials.");
  } finally {
    await client.end();
  }
}

await main();
