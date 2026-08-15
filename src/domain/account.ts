// account.ts -- account types and how a stored sum becomes a readable balance. Depends on: money.

export type AccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export const ACCOUNT_TYPES: readonly AccountType[] = [
  "asset",
  "liability",
  "equity",
  "revenue",
  "expense",
];

const DEBIT_NORMAL: ReadonlySet<AccountType> = new Set<AccountType>(["asset", "expense"]);

/** True when a debit increases this account, false when a credit does. */
export function isDebitNormal(type: AccountType): boolean {
  return DEBIT_NORMAL.has(type);
}

/**
 * Stored sums are always debit-positive. A liability with a stored sum of -500 holds 500,
 * because credits increase it. The flip happens here, on the way out, so the data keeps a
 * single convention and only the reading of it changes.
 */
export function normalBalance(type: AccountType, signedSum: bigint): bigint {
  return isDebitNormal(type) ? signedSum : -signedSum;
}
