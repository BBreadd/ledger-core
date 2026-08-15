// reconciliation.test.ts -- the verdict and the report, with no database in sight.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcile } from "../../src/application/reconcile.ts";
import type { ReconciliationSource } from "../../src/application/ports.ts";
import { isClean, reportLines, totalAnomalies } from "../../src/domain/reconciliation.ts";
import type { CheckFindings, ReconciliationReport } from "../../src/domain/reconciliation.ts";

const NOTHING: CheckFindings = { total: 0n, samples: [] };

/** Every check answers "nothing wrong" unless a test overrides that one. */
function sourceThatFinds(overrides: Partial<ReconciliationSource> = {}): ReconciliationSource {
  return {
    size: async () => ({ accounts: 3n, transactions: 2n, entries: 4n }),
    globalNet: async () => 0n,
    unbalancedTransactions: async () => NOTHING,
    malformedTransactions: async () => NOTHING,
    unbalancedCurrencies: async () => NOTHING,
    multiCurrencyTransactions: async () => NOTHING,
    overdrawnAccounts: async () => NOTHING,
    ...overrides,
  };
}

const fixedClock = (): Date => new Date("2026-08-15T12:00:00.000Z");

describe("reconcile", () => {
  it("reports every check even when the ledger is sound", async () => {
    const report = await reconcile({ source: sourceThatFinds(), now: fixedClock });

    assert.equal(isClean(report), true);
    assert.equal(totalAnomalies(report), 0n);
    assert.deepEqual(
      report.checks.map((check) => check.id),
      [
        "GLOBAL_NET",
        "TRANSACTION_NET",
        "TRANSACTION_SHAPE",
        "CURRENCY_NET",
        "TRANSACTION_CURRENCY_SPAN",
        "NEGATIVE_BALANCE",
      ],
      "a check that stops being reported stops being evidence of anything",
    );
  });

  it("turns a non-zero global net into an anomaly carrying the number", async () => {
    const report = await reconcile({
      source: sourceThatFinds({ globalNet: async () => -250n }),
      now: fixedClock,
    });

    const check = checkNamed(report, "GLOBAL_NET");
    assert.equal(check.total, 1n);
    assert.equal(check.samples[0]?.detail, "net=-250");
    assert.equal(isClean(report), false);
  });

  it("adds up anomalies across checks", async () => {
    const report = await reconcile({
      source: sourceThatFinds({
        unbalancedTransactions: async () => ({
          total: 4n,
          samples: [{ subject: "tx-1", detail: "net=10" }],
        }),
        overdrawnAccounts: async () => ({
          total: 2n,
          samples: [{ subject: "acct-1", detail: "balance=-5" }],
        }),
      }),
      now: fixedClock,
    });

    assert.equal(totalAnomalies(report), 6n);
    assert.equal(isClean(report), false);
  });
});

describe("reportLines", () => {
  it("says so when the samples are only part of the story", () => {
    const report: ReconciliationReport = {
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      finishedAt: new Date("2026-08-15T12:00:00.400Z"),
      size: { accounts: 1n, transactions: 1n, entries: 1n },
      checks: [
        {
          id: "TRANSACTION_NET",
          description: "transactions whose entries do not sum to zero",
          total: 900n,
          samples: [{ subject: "tx-1", detail: "net=10" }],
        },
      ],
    };

    const lines = reportLines(report);
    assert.ok(
      lines.includes("reconcile.truncated check=TRANSACTION_NET shown=1 of=900"),
      "a report that silently shows 1 of 900 understates the damage",
    );
    assert.ok(lines.some((line) => line.startsWith("reconcile.done status=anomalies")));
    assert.ok(lines.some((line) => line.includes("duration_ms=400")));
  });

  it("keeps quiet about truncation when nothing was truncated", () => {
    const report: ReconciliationReport = {
      startedAt: new Date("2026-08-15T12:00:00.000Z"),
      finishedAt: new Date("2026-08-15T12:00:00.000Z"),
      size: { accounts: 0n, transactions: 0n, entries: 0n },
      checks: [
        { id: "GLOBAL_NET", description: "debits minus credits", total: 0n, samples: [] },
      ],
    };

    const lines = reportLines(report);
    assert.ok(!lines.some((line) => line.startsWith("reconcile.truncated")));
    assert.ok(lines.some((line) => line.startsWith("reconcile.done status=clean")));
  });
});

function checkNamed(report: ReconciliationReport, id: string) {
  const check = report.checks.find((candidate) => candidate.id === id);
  assert.ok(check !== undefined, `no check named ${id}`);
  return check;
}
