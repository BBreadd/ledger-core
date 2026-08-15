// ports.ts -- the interfaces the core declares and the adapters implement. Depends on: domain.

import type { AccountType } from "../domain/account.ts";
import type { Amount, Direction } from "../domain/money.ts";

export type NewAccount = {
  readonly id: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly allowsNegative: boolean;
};

/** An account plus its balance, both read while the row is locked. */
export type LockedAccount = {
  readonly id: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly allowsNegative: boolean;
  readonly balance: bigint;
};

export type StoredEntry = {
  readonly id: string;
  readonly accountId: string;
  readonly direction: Direction;
  readonly amount: Amount;
};

export type StoredTransaction = {
  readonly id: string;
  readonly seq: bigint;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly description: string;
  readonly occurredAt: Date;
  readonly recordedAt: Date;
  readonly entries: readonly StoredEntry[];
};

export type TransactionToInsert = {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly description: string;
  readonly occurredAt: Date;
  readonly entries: readonly (StoredEntry & { readonly currency: string })[];
};

/**
 * Operations available inside one database transaction. The core never learns that any
 * of this is PostgreSQL.
 */
export type UnitOfWork = {
  /**
   * Takes an exclusive lock on the given accounts and returns them with their current
   * balance. Implementations must lock in a deterministic order, otherwise two transfers
   * touching the same pair of accounts in opposite order deadlock.
   */
  lockAccounts(accountIds: readonly string[]): Promise<readonly LockedAccount[]>;

  /**
   * Writes the transaction and all of its entries, and returns it as stored, including
   * the values the database assigns (seq, recorded_at).
   * Throws DuplicateIdempotencyKeyError when the key is already taken.
   */
  insertTransaction(transaction: TransactionToInsert): Promise<StoredTransaction>;
};

export type LedgerStore = {
  inTransaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T>;

  createAccount(account: NewAccount): Promise<void>;
  ensureCurrency(code: string, minorUnit: number): Promise<void>;
  balanceOf(accountId: string): Promise<bigint>;
  findByIdempotencyKey(key: string): Promise<StoredTransaction | null>;
  close(): Promise<void>;
};

/** Raised by the adapter when the unique index on idempotency_key rejects an insert. */
export class DuplicateIdempotencyKeyError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(`idempotency key already in use (${detail})`);
    this.name = "DuplicateIdempotencyKeyError";
    this.detail = detail;
  }
}

export type IdGenerator = () => string;
export type Clock = () => Date;
