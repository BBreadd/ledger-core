// reconciliation.ts -- what an audit of the ledger reports, and when it passes. Depends on: nothing.

/**
 * Identifies a check so a report can be read by a machine and not only by a person.
 * These are ids, not labels: renaming one breaks whatever greps for it.
 */
export type CheckId =
  | "GLOBAL_NET"
  | "TRANSACTION_NET"
  | "TRANSACTION_SHAPE"
  | "CURRENCY_NET"
  | "TRANSACTION_CURRENCY_SPAN"
  | "NEGATIVE_BALANCE"
  | "REVERSAL_INTEGRITY";

export type Anomaly = {
  /** The id the anomaly is about: a transaction, an account, a currency code. */
  readonly subject: string;
  readonly detail: string;
};

/**
 * What one check found: how many anomalies exist, and a bounded sample of them. The two
 * are separate because a ledger with a million broken transactions must not produce a
 * million log lines, and truncating without saying so would understate the damage.
 */
export type CheckFindings = {
  readonly total: bigint;
  readonly samples: readonly Anomaly[];
};

export type CheckResult = CheckFindings & {
  readonly id: CheckId;
  readonly description: string;
};

export type LedgerSize = {
  readonly accounts: bigint;
  readonly transactions: bigint;
  readonly entries: bigint;
};

export type ReconciliationReport = {
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly size: LedgerSize;
  readonly checks: readonly CheckResult[];
};

/** How many anomalies of a single check get carried into the report. */
export const SAMPLE_LIMIT = 20;

export function totalAnomalies(report: ReconciliationReport): bigint {
  return report.checks.reduce((sum, check) => sum + check.total, 0n);
}

export function isClean(report: ReconciliationReport): boolean {
  return report.checks.every((check) => check.total === 0n);
}

/**
 * Key-value lines rather than prose, so the output is greppable and parseable without
 * being unreadable. Pure on purpose: the decision of what to say is testable, and only
 * the entry point decides where it goes.
 */
export function reportLines(report: ReconciliationReport): readonly string[] {
  const lines = [
    `reconcile.size accounts=${report.size.accounts} transactions=${report.size.transactions} ` +
      `entries=${report.size.entries}`,
  ];

  for (const check of report.checks) {
    lines.push(`reconcile.check id=${check.id} anomalies=${check.total}`);
    for (const anomaly of check.samples) {
      lines.push(`reconcile.anomaly check=${check.id} subject=${anomaly.subject} ${anomaly.detail}`);
    }
    if (check.total > BigInt(check.samples.length)) {
      lines.push(
        `reconcile.truncated check=${check.id} shown=${check.samples.length} of=${check.total}`,
      );
    }
  }

  lines.push(
    `reconcile.done status=${isClean(report) ? "clean" : "anomalies"} ` +
      `anomalies=${totalAnomalies(report)} checks=${report.checks.length} ` +
      `duration_ms=${report.finishedAt.getTime() - report.startedAt.getTime()}`,
  );
  return lines;
}
