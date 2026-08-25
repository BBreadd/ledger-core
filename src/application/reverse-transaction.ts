// reverse-transaction.ts -- the only way to correct a posting. Depends on: domain, ports.

import { mirror, reversalFingerprint } from "../domain/transaction.ts";
import type { IdGenerator, LedgerStore, StoredEntry, StoredTransaction } from "./ports.ts";
import { AlreadyReversedError, DuplicateIdempotencyKeyError } from "./ports.ts";

export type ReversalViolationCode =
  | "UNKNOWN_TRANSACTION"
  | "ALREADY_REVERSED"
  | "NOT_REVERSIBLE"
  | "EMPTY_IDEMPOTENCY_KEY"
  | "IDEMPOTENCY_KEY_REUSED";

export type ReversalRejection = {
  readonly code: ReversalViolationCode;
  readonly message: string;
};

export type ReverseOutcome =
  | { readonly status: "reversed"; readonly transaction: StoredTransaction }
  /** The key was already used by an identical request: the original reversal comes back. */
  | { readonly status: "replayed"; readonly transaction: StoredTransaction }
  | { readonly status: "rejected"; readonly rejections: readonly ReversalRejection[] };

/**
 * tenantId is here rather than alongside because a reversal request is already an object,
 * and it does not reach the fingerprint: reversalFingerprint names the three fields it
 * hashes, and the tenant is the scope of the key rather than part of what was asked for.
 */
export type ReversalRequest = {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly idempotencyKey: string;
  readonly description: string;
};

export type ReverseDependencies = {
  readonly store: LedgerStore;
  readonly newId: IdGenerator;
};

/**
 * Posts the exact mirror of an existing transaction, linked to it.
 *
 * The original is never touched -- it cannot be, the application holds no UPDATE or DELETE
 * on postings. A corrected ledger is one with two transactions in it, not one with a
 * rewritten transaction, and that is the difference between a record and a draft.
 *
 * No account lock is taken here, unlike the posting path, and the absence is the point:
 * this writes without reading any balance, so there is no read-then-write to race. That is
 * the reward of an append-only ledger -- contention only exists where a decision depends
 * on what was read.
 */
export async function reverseTransaction(
  deps: ReverseDependencies,
  request: ReversalRequest,
): Promise<ReverseOutcome> {
  if (request.idempotencyKey.trim().length === 0) {
    return rejected("EMPTY_IDEMPOTENCY_KEY", "idempotencyKey must not be empty");
  }

  try {
    const outcome = await deps.store.inTransaction(async (uow) => {
      // Scoped to the caller's tenant, so a transaction belonging to somebody else is
      // simply not found. Ownership needs no branch of its own here: the branch for a
      // transaction that does not exist already says the only thing that may be said.
      //
      // No lock is taken, and this does not reintroduce one. The read exists to build the
      // mirror, not to decide against a balance, and an account cannot change tenant --
      // the composite foreign keys make that unwritable -- so there is nothing here that
      // could be true when read and false when written.
      const original = await uow.findTransaction(request.transactionId, request.tenantId);

      if (original === null) {
        return rejected("UNKNOWN_TRANSACTION", `no transaction with id ${request.transactionId}`);
      }

      // Reversing a reversal of A re-applies A by a longer route, and leaves a chain whose
      // meaning depends on counting how long it is. Post A again instead, with its own key.
      if (original.reversesTransactionId !== null) {
        return rejected(
          "NOT_REVERSIBLE",
          `transaction ${original.id} is itself a reversal of ` +
            `${original.reversesTransactionId}; post the original again instead`,
        );
      }

      const entries: readonly StoredEntry[] = mirror(original.entries).map((entry) => ({
        ...entry,
        id: deps.newId(),
      }));

      const transaction = await uow.insertTransaction({
        id: deps.newId(),
        tenantId: request.tenantId,
        idempotencyKey: request.idempotencyKey,
        requestHash: reversalFingerprint(request),
        description: request.description,
        // When it happened in the business, per the bitemporal split: undoing an event
        // that occurred then is part of what occurred then, so a report by business date
        // reads the same with the pair as without it. recorded_at is still now, so when
        // the correction was learned of is not lost.
        occurredAt: original.occurredAt,
        reversesTransactionId: original.id,
        entries,
      });

      return { status: "reversed" as const, transaction };
    });

    return outcome;
  } catch (error) {
    // An honest retry of a reversal violates both unique indexes at once: the same key was
    // used before, and the transaction it names was reversed before. Which of the two
    // reports the 23505 is not decided by anything in this file -- PostgreSQL checks the
    // indexes in the order they were created, so recreating one moves it in the queue.
    // Measured: scoping idempotency per tenant rebuilt that index last, and a retry that
    // used to replay started coming back ALREADY_REVERSED.
    //
    // So the key is asked about first, whichever constraint spoke. A caller retrying the
    // same request gets its original answer; a caller reaching for an already-reversed
    // transaction under a new key gets the conflict. The outcome no longer depends on an
    // ordering nobody declared.
    if (error instanceof AlreadyReversedError || error instanceof DuplicateIdempotencyKeyError) {
      const outcome = await replayOrReject(deps, request);
      if (outcome.status !== "rejected" || !(error instanceof AlreadyReversedError)) {
        return outcome;
      }
      return rejected(
        "ALREADY_REVERSED",
        `transaction ${request.transactionId} already has a reversal`,
      );
    }
    throw error;
  }
}

async function replayOrReject(
  deps: ReverseDependencies,
  request: ReversalRequest,
): Promise<ReverseOutcome> {
  const existing = await deps.store.findByIdempotencyKey(request.tenantId, request.idempotencyKey);
  if (existing === null) {
    // Reachable now, and only from the branch above: the reversal index can report the
    // conflict while this key has never been used at all. That is not a replay and not a
    // bug -- it is a second reversal wearing a new key, and the caller above turns it into
    // ALREADY_REVERSED. When the duplicate key really was the cause, the row is there.
    return rejected(
      "ALREADY_REVERSED",
      `transaction ${request.transactionId} already has a reversal`,
    );
  }

  // A retry means the same key asking for the same thing. The same key pointing anywhere
  // else is a caller bug, and replaying the old result would hide it.
  if (existing.requestHash !== reversalFingerprint(request)) {
    return rejected(
      "IDEMPOTENCY_KEY_REUSED",
      `idempotency key ${request.idempotencyKey} was already used for a different request`,
    );
  }
  return { status: "replayed", transaction: existing };
}

function rejected(code: ReversalViolationCode, message: string): ReverseOutcome {
  return { status: "rejected", rejections: [{ code, message }] };
}
