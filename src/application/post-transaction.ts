// post-transaction.ts -- the only way a posting enters the ledger. Depends on: domain, ports.

import type { TransactionDraft, ViolationCode } from "../domain/transaction.ts";
import { fingerprint, validate } from "../domain/transaction.ts";
import { signedAmount } from "../domain/money.ts";
import { normalBalance } from "../domain/account.ts";
import type {
  IdGenerator,
  LedgerStore,
  LockedAccount,
  StoredEntry,
  StoredTransaction,
} from "./ports.ts";
import { DuplicateIdempotencyKeyError } from "./ports.ts";

/**
 * Rules the domain cannot check on its own, because answering them requires reading
 * other rows. They are checked in here, inside the lock, not in the pure layer.
 */
export type ApplicationViolationCode =
  | "UNKNOWN_ACCOUNT"
  | "MIXED_CURRENCY"
  | "INSUFFICIENT_FUNDS"
  | "IDEMPOTENCY_KEY_REUSED";

export type Rejection = {
  readonly code: ViolationCode | ApplicationViolationCode;
  readonly message: string;
};

export type PostOutcome =
  /** Written now. */
  | { readonly status: "posted"; readonly transaction: StoredTransaction }
  /** The key was already used by an identical request: the original is returned unchanged. */
  | { readonly status: "replayed"; readonly transaction: StoredTransaction }
  /** Nothing was written. */
  | { readonly status: "rejected"; readonly rejections: readonly Rejection[] };

export type PostDependencies = {
  readonly store: LedgerStore;
  readonly newId: IdGenerator;
};

export async function postTransaction(
  deps: PostDependencies,
  draft: TransactionDraft,
): Promise<PostOutcome> {
  const violations = validate(draft);
  if (violations.length > 0) {
    return { status: "rejected", rejections: violations };
  }

  const requestHash = fingerprint(draft);
  const accountIds = [...new Set(draft.entries.map((entry) => entry.accountId))];

  try {
    return await deps.store.inTransaction(async (uow) => {
      // Everything below reads balances and then writes based on what it read. Without
      // the lock this is a write-skew race: two concurrent transfers each read the same
      // balance, each decides it has room, and together they overdraw the account.
      // Raising the isolation level to REPEATABLE READ would not help -- that is
      // snapshot isolation, and snapshot isolation does not prevent write skew.
      const locked = await uow.lockAccounts(accountIds);
      const byId = new Map(locked.map((account) => [account.id, account]));

      const missing = accountIds.filter((id) => !byId.has(id));
      if (missing.length > 0) {
        return rejected("UNKNOWN_ACCOUNT", `unknown account(s): ${missing.join(", ")}`);
      }

      const currencies = new Set(locked.map((account) => account.currency));
      if (currencies.size !== 1) {
        return rejected(
          "MIXED_CURRENCY",
          `a transaction must stay in one currency, got ${[...currencies].sort().join(", ")}`,
        );
      }

      const currency = locked[0]?.currency;
      if (currency === undefined) {
        return rejected("UNKNOWN_ACCOUNT", "a transaction must touch at least one account");
      }

      const overdrawn = accountsLeftOverdrawn(byId, draft);
      if (overdrawn.length > 0) {
        return rejected("INSUFFICIENT_FUNDS", overdrawn.join("; "));
      }

      const entries: readonly StoredEntry[] = draft.entries.map((entry) => ({
        id: deps.newId(),
        accountId: entry.accountId,
        direction: entry.direction,
        amount: entry.amount,
        currency,
      }));

      const transaction = await uow.insertTransaction({
        id: deps.newId(),
        idempotencyKey: draft.idempotencyKey,
        requestHash,
        description: draft.description,
        occurredAt: draft.occurredAt,
        reversesTransactionId: null,
        entries,
      });

      return { status: "posted" as const, transaction };
    });
  } catch (error) {
    if (!(error instanceof DuplicateIdempotencyKeyError)) {
      throw error;
    }
    // The unique index is the idempotency check. Looking the key up before inserting
    // would be the same read-then-write race the lock above exists to prevent, so a
    // duplicate is detected by losing the insert, not by asking first.
    return replayOrReject(deps.store, draft.idempotencyKey, requestHash);
  }
}

async function replayOrReject(
  store: LedgerStore,
  key: string,
  requestHash: string,
): Promise<PostOutcome> {
  const original = await store.findByIdempotencyKey(key);
  if (original === null) {
    throw new Error(`idempotency key ${key} was taken but no transaction holds it`);
  }
  if (original.requestHash !== requestHash) {
    // Same key, different payload. That is not a retry, it is a caller bug, and
    // silently replaying the old result would hide it.
    return rejected(
      "IDEMPOTENCY_KEY_REUSED",
      `idempotency key ${key} was already used for a different request`,
    );
  }
  return { status: "replayed", transaction: original };
}

/**
 * Net effect per account, so that a transaction which both debits and credits the same
 * account is judged on the result rather than on one leg of it.
 *
 * The floor is applied to the normal balance, not to the raw stored sum. Stored sums are
 * debit-positive, so for a liability, equity or revenue account a healthy balance is a
 * negative sum: judging those by raw sign would read allows_negative = false as "may never
 * be credited on net", which is the opposite of what it should mean. The auditor applies
 * the same rule through normal_balance() in SQL, and it has to stay that way -- an auditor
 * judging by a different rule than the enforcer reports failures nobody can cause and
 * misses the ones they can.
 */
function accountsLeftOverdrawn(
  byId: ReadonlyMap<string, LockedAccount>,
  draft: TransactionDraft,
): string[] {
  const deltas = new Map<string, bigint>();
  for (const entry of draft.entries) {
    const delta = signedAmount(entry.direction, entry.amount);
    deltas.set(entry.accountId, (deltas.get(entry.accountId) ?? 0n) + delta);
  }

  const problems: string[] = [];
  for (const [accountId, delta] of deltas) {
    const account = byId.get(accountId);
    if (account === undefined || account.allowsNegative) {
      continue;
    }
    const after = normalBalance(account.type, account.balance + delta);
    if (after < 0n) {
      problems.push(
        `account ${accountId} would go to ${after} ` +
          `(balance ${normalBalance(account.type, account.balance)}, type ${account.type})`,
      );
    }
  }
  return problems;
}

function rejected(code: ApplicationViolationCode, message: string): PostOutcome {
  return { status: "rejected", rejections: [{ code, message }] };
}
