// migrate.ts -- entry point: bring the database schema up to date. Depends on: config, migrator.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireDatabaseUrl } from "../config.ts";
import { migrate } from "../adapters/postgres/migrator.ts";

const MIGRATIONS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../migrations",
);

async function main(): Promise<void> {
  // The owner, not the application. Migrations create roles and hand out privileges,
  // which is exactly the authority the application is not supposed to hold.
  const results = await migrate(requireDatabaseUrl("DATABASE_ADMIN_URL"), MIGRATIONS_DIR);

  for (const result of results) {
    console.log(`${result.alreadyApplied ? "already applied" : "applied        "}  ${result.version}`);
  }

  const applied = results.filter((result) => !result.alreadyApplied).length;
  console.log(`\n${applied} migration(s) applied, ${results.length - applied} already up to date.`);
}

await main();
