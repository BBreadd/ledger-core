// views.ts -- how the ledger looks on the wire. Depends on: domain, ports.

import { normalBalance } from "../../domain/account.ts";
import type { AccountType } from "../../domain/account.ts";
import type { Direction } from "../../domain/money.ts";
import type { AccountBalance, StoredTransaction } from "../../application/ports.ts";
import type { NewAccountRequest } from "./parse.ts";

/**
 * Money leaves as a string of minor units, with the currency and its minorUnit beside it
 * so the client can format without knowing anything in advance.
 *
 * Three ways to do this and only one survives. A JSON number loses precision above 2^53,
 * which is the integer-money decision made twice in one project and lost the second time.
 * A decimal string ("500.00") puts rounding rules back into runtime, which is what integer
 * minor units exist to avoid. And a raw bigint cannot be serialised at all: JSON.stringify
 * throws a TypeError on one, rather than producing something wrong quietly.
 */
export type TransactionView = {
  readonly id: string;
  readonly seq: string;
  readonly idempotencyKey: string;
  readonly description: string;
  readonly occurredAt: string;
  readonly recordedAt: string;
  readonly reversesTransactionId: string | null;
  readonly currency: string;
  readonly minorUnit: number;
  readonly entries: readonly {
    readonly id: string;
    readonly accountId: string;
    readonly direction: Direction;
    readonly amount: string;
  }[];
};

export type AccountView = {
  readonly id: string;
  readonly name: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly minorUnit: number;
  readonly allowsNegative: boolean;
};

export type BalanceView = {
  readonly accountId: string;
  readonly type: AccountType;
  readonly currency: string;
  readonly minorUnit: number;
  readonly balance: string;
};

/**
 * The currency sits on the transaction rather than on each entry because I8 guarantees
 * there is only one of them per transaction, and repeating it per leg would invite a
 * client to believe the legs could disagree.
 *
 * requestHash is deliberately absent. It is how the server tells a retry from a collision;
 * a client has no use for it and publishing it would freeze an implementation detail into
 * the contract.
 */
export function transactionView(
  transaction: StoredTransaction,
  minorUnit: number,
): TransactionView {
  const currency = transaction.entries[0]?.currency ?? "";
  return {
    id: transaction.id,
    seq: transaction.seq.toString(),
    idempotencyKey: transaction.idempotencyKey,
    description: transaction.description,
    occurredAt: transaction.occurredAt.toISOString(),
    recordedAt: transaction.recordedAt.toISOString(),
    reversesTransactionId: transaction.reversesTransactionId,
    currency,
    minorUnit,
    entries: transaction.entries.map((entry) => ({
      id: entry.id,
      accountId: entry.accountId,
      direction: entry.direction,
      amount: entry.amount.toString(),
    })),
  };
}

export function accountView(
  id: string,
  request: NewAccountRequest,
  minorUnit: number,
): AccountView {
  return {
    id,
    name: request.name,
    type: request.type,
    currency: request.currency,
    minorUnit,
    allowsNegative: request.allowsNegative,
  };
}

/**
 * The balance is presented as a normal balance, never as the stored debit-positive sum. A
 * revenue account holding 500 reads as 500 here and as -500 in the column, and the reader
 * of an API has no business knowing which convention the rows use. The flip belongs to
 * whoever presents; the data keeps one convention.
 */
export function balanceView(account: AccountBalance, minorUnit: number): BalanceView {
  return {
    accountId: account.id,
    type: account.type,
    currency: account.currency,
    minorUnit,
    balance: normalBalance(account.type, account.balance).toString(),
  };
}
