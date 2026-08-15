// migrator.ts -- applies versioned SQL migrations, once and in order. Depends on: pg, node:fs.

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

// Any arbitrary constant works; it only has to be the same in every process. Two
// migrators started at once (a developer and CI, or two CI jobs) queue instead of racing.
const MIGRATION_LOCK_ID = 8_274_119_004_512n;

export type AppliedMigration = {
  readonly version: string;
  readonly alreadyApplied: boolean;
};

export async function migrate(
  databaseUrl: string,
  directory: string,
): Promise<readonly AppliedMigration[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        version    text primary key,
        checksum   text not null,
        applied_at timestamptz not null default now()
      )
    `);

    await client.query("select pg_advisory_lock($1)", [MIGRATION_LOCK_ID.toString()]);

    try {
      const files = (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort();
      const applied = await loadApplied(client);
      const results: AppliedMigration[] = [];

      for (const file of files) {
        const version = path.basename(file, ".sql");
        const sql = await readFile(path.join(directory, file), "utf8");
        const checksum = createHash("sha256").update(sql).digest("hex");
        const previous = applied.get(version);

        if (previous !== undefined) {
          // An applied migration is history. Editing one means the database other people
          // already have and the database a fresh clone would build are different things,
          // and nothing else would ever tell you.
          if (previous !== checksum) {
            throw new Error(
              `migration ${version} was modified after being applied ` +
                `(recorded ${previous.slice(0, 12)}, file ${checksum.slice(0, 12)}). ` +
                "Add a new migration instead of editing this one.",
            );
          }
          results.push({ version, alreadyApplied: true });
          continue;
        }

        // Schema change and its bookkeeping commit together or not at all, so an
        // interrupted run can never record a migration it did not finish applying.
        await client.query("begin");
        try {
          await client.query(sql);
          await client.query(
            "insert into schema_migrations (version, checksum) values ($1, $2)",
            [version, checksum],
          );
          await client.query("commit");
        } catch (error) {
          await client.query("rollback");
          throw new Error(`migration ${version} failed: ${(error as Error).message}`, {
            cause: error,
          });
        }

        results.push({ version, alreadyApplied: false });
      }

      return results;
    } finally {
      await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_ID.toString()]);
    }
  } finally {
    await client.end();
  }
}

async function loadApplied(client: pg.Client): Promise<Map<string, string>> {
  const result = await client.query<{ version: string; checksum: string }>(
    "select version, checksum from schema_migrations",
  );
  return new Map(result.rows.map((row) => [row.version, row.checksum]));
}
