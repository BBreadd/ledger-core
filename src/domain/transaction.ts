// transaction.ts -- the double-entry invariants, as pure functions. Depends on: money.

import { createHash } from "node:crypto";
import type { Amount, Direction } from "./money.ts";
import { signedAmount } from "./money.ts";

export type EntryDraft = {
  readonly accountId: string;
  readonly direction: Direction;
  readonly amount: Amount;
};

export type TransactionDraft = {
  readonly idempotencyKey: string;
  readonly description: string;
  readonly occurredAt: Date;
  readonly entries: readonly EntryDraft[];
};

export type ViolationCode =
  | "EMPTY_IDEMPOTENCY_KEY"
  | "EMPTY_DESCRIPTION"
  | "TOO_FEW_ENTRIES"
  | "TOO_FEW_ACCOUNTS"
  | "NON_POSITIVE_AMOUNT"
  | "UNBALANCED";

export type Violation = {
  readonly code: ViolationCode;
  readonly message: string;
};

/** Debits minus credits. Zero means the transaction balances. */
export function netOf(entries: readonly EntryDraft[]): bigint {
  return entries.reduce((sum, entry) => sum + signedAmount(entry.direction, entry.amount), 0n);
}

/**
 * Every rule checked here is checked again by a deferred constraint trigger in the
 * database. That is deliberate and not duplication: this layer exists to return a usable
 * error, the database exists to guarantee that no write path -- including a hand-typed
 * psql session -- can get around the rule.
 *
 * The rules that need to read other rows (currency agreement, balance floors) are not
 * here, because they are not pure. They live in the use case, inside the lock.
 */
export function validate(draft: TransactionDraft): readonly Violation[] {
  const violations: Violation[] = [];

  if (draft.idempotencyKey.trim().length === 0) {
    violations.push({
      code: "EMPTY_IDEMPOTENCY_KEY",
      message: "idempotencyKey must not be empty",
    });
  }

  if (draft.description.trim().length === 0) {
    violations.push({ code: "EMPTY_DESCRIPTION", message: "description must not be empty" });
  }

  if (draft.entries.length < 2) {
    violations.push({
      code: "TOO_FEW_ENTRIES",
      message: `double-entry requires at least two entries, got ${draft.entries.length}`,
    });
  }

  const accounts = new Set(draft.entries.map((entry) => entry.accountId));
  if (draft.entries.length >= 2 && accounts.size < 2) {
    violations.push({
      code: "TOO_FEW_ACCOUNTS",
      message: `entries must touch at least two distinct accounts, got ${accounts.size}`,
    });
  }

  for (const entry of draft.entries) {
    if (entry.amount <= 0n) {
      violations.push({
        code: "NON_POSITIVE_AMOUNT",
        message: `amount must be positive, got ${entry.amount} for account ${entry.accountId}`,
      });
    }
  }

  const net = netOf(draft.entries);
  if (draft.entries.length > 0 && net !== 0n) {
    violations.push({
      code: "UNBALANCED",
      message: `debits minus credits must be zero, got ${net}`,
    });
  }

  return violations;
}

/**
 * Fingerprint of what the caller asked for, so that the same idempotency key arriving
 * with a different payload can be told apart from an honest retry. Order-independent on
 * entries, because [debit A, credit B] and [credit B, debit A] are the same request.
 *
 * Lives in the domain rather than behind a port because hashing is a pure function: same
 * input, same output, no I/O and no clock.
 */
export function fingerprint(draft: TransactionDraft): string {
  const legs = draft.entries
    .map((entry) => `${entry.accountId}:${entry.direction}:${entry.amount}`)
    .sort()
    .join("|");
  const payload = [
    draft.idempotencyKey,
    draft.description,
    draft.occurredAt.toISOString(),
    legs,
  ].join("\n");
  return createHash("sha256").update(payload).digest("hex");
}
