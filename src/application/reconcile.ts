// reconcile.ts -- audits the ledger against its own invariants. Depends on: domain, ports.

import { SAMPLE_LIMIT } from "../domain/reconciliation.ts";
import type {
  CheckFindings,
  CheckId,
  CheckResult,
  ReconciliationReport,
} from "../domain/reconciliation.ts";
import type { Clock, ReconciliationSource } from "./ports.ts";

export type ReconcileDependencies = {
  readonly source: ReconciliationSource;
  readonly now: Clock;
};

/**
 * Reads the ledger without going through the write path and reports whether the
 * invariants that span more than one row still hold.
 *
 * This is the third of the three layers that enforce a balanced ledger: the types refuse
 * to build an unbalanced transaction, the deferred constraint trigger refuses to commit
 * one, and this proves after the fact that neither was bypassed. The first two answer
 * "can this be written?"; only this one answers "is what is written still true?".
 */
export async function reconcile(deps: ReconcileDependencies): Promise<ReconciliationReport> {
  const startedAt = deps.now();

  const size = await deps.source.size();
  const globalNet = await deps.source.globalNet();

  const checks: readonly CheckResult[] = [
    // Implied by TRANSACTION_NET rather than independent of it: the global net is the sum
    // of the per-transaction nets, so this can only be non-zero when that check also
    // fails. It is here as the headline figure and as the cheapest possible smoke test,
    // and it is the weak form of the question -- two opposite errors cancel out in this
    // number and are caught only one row down.
    {
      id: "GLOBAL_NET",
      description: "debits minus credits across the whole ledger",
      ...asFindings(globalNet === 0n ? [] : [{ subject: "ledger", detail: `net=${globalNet}` }]),
    },
    result(
      "TRANSACTION_NET",
      "transactions whose entries do not sum to zero",
      await deps.source.unbalancedTransactions(SAMPLE_LIMIT),
    ),
    result(
      "TRANSACTION_SHAPE",
      "transactions with fewer than two entries or fewer than two accounts",
      await deps.source.malformedTransactions(SAMPLE_LIMIT),
    ),
    // Not redundant with TRANSACTION_NET: it catches what fools it. A 100 USD debit
    // against a 100 JPY credit sums to zero in raw minor units and passes as balanced,
    // while being nonsense. Comparing money that was never comparable is exactly the
    // error a single global sum cannot see.
    result(
      "CURRENCY_NET",
      "currencies that do not sum to zero across the ledger",
      await deps.source.unbalancedCurrencies(SAMPLE_LIMIT),
    ),
    result(
      "TRANSACTION_CURRENCY_SPAN",
      "transactions holding more than one currency",
      await deps.source.multiCurrencyTransactions(SAMPLE_LIMIT),
    ),
    // The one invariant with no database backstop at all: nothing but the balance check
    // inside the write lock stops an account from going below zero, so nothing but this
    // would notice if a write ever went around it.
    // Deliberately makes no exception for reversals, even though a reversal is allowed to
    // push an account below zero. The hole a correction leaves is real money that is
    // really missing -- the funds were spent before the mistake was found -- so an audit
    // that stayed quiet about it would be hiding the one thing a person has to act on.
    // What a reversal changes is that the cause is on the record, not that the shortfall
    // stops counting.
    result(
      "NEGATIVE_BALANCE",
      "accounts below zero that are not allowed to be",
      await deps.source.overdrawnAccounts(SAMPLE_LIMIT),
    ),
    // Corrections are the only way to fix a posting, so a correction that does not
    // correct is worse than no correction at all: it reads as settled while leaving the
    // original error in force.
    result(
      "REVERSAL_INTEGRITY",
      "reversals that do not exactly mirror what they claim to undo",
      await deps.source.brokenReversals(SAMPLE_LIMIT),
    ),
  ];

  return { startedAt, finishedAt: deps.now(), size, checks };
}

function result(id: CheckId, description: string, findings: CheckFindings): CheckResult {
  return { id, description, total: findings.total, samples: findings.samples };
}

function asFindings(anomalies: CheckFindings["samples"]): CheckFindings {
  return { total: BigInt(anomalies.length), samples: anomalies };
}
