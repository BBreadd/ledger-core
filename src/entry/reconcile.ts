// reconcile.ts -- entry point: audits the ledger and reports whether it still holds.
// Depends on: config, adapters, application, domain.
//
// Exit codes are the contract with whatever runs this:
//   0  the ledger reconciles
//   2  the audit ran and found anomalies
//   1  the audit could not run (an uncaught error; Node's own default)
// Two and one are kept apart on purpose. "The books are wrong" and "the auditor is
// broken" are different incidents with different responses, and collapsing them means
// a failing auditor reads as a failing ledger forever.

import { requireDatabaseUrl } from "../config.ts";
import { createReconciliationReader } from "../adapters/postgres/reconciliation-source.ts";
import { reconcile } from "../application/reconcile.ts";
import { isClean, reportLines } from "../domain/reconciliation.ts";

const EXIT_ANOMALIES_FOUND = 2;

async function main(): Promise<void> {
  // A role that holds SELECT and nothing else. The read-only transaction says the audit
  // will not write; this says it could not have.
  const reader = createReconciliationReader(requireDatabaseUrl("DATABASE_AUDITOR_URL"));

  try {
    const report = await reader.read((source) => reconcile({ source, now: () => new Date() }));
    for (const line of reportLines(report)) {
      console.log(line);
    }
    process.exitCode = isClean(report) ? 0 : EXIT_ANOMALIES_FOUND;
  } finally {
    await reader.close();
  }
}

await main();
