// reversal.test.ts -- correcting a posting when editing one is impossible.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createLedgerStore } from "../../src/adapters/postgres/ledger-store.ts";
import { createUuidV7 } from "../../src/adapters/uuid-v7.ts";
import { postTransaction } from "../../src/application/post-transaction.ts";
import { reverseTransaction } from "../../src/application/reverse-transaction.ts";
import type { StoredTransaction } from "../../src/application/ports.ts";
import {
  integrationAdminUrl,
  integrationDatabaseUrl,
  skipWithoutDatabase,
} from "./database-url.ts";

const newId = createUuidV7();

describe("reversing a posting", { skip: skipWithoutDatabase }, () => {
  const url = integrationDatabaseUrl ?? "";
  const store = createLedgerStore(url);
  const pool = new pg.Pool({ connectionString: url });
  const admin = new pg.Pool({ connectionString: integrationAdminUrl ?? "" });
  const deps = { store, newId };

  before(async () => {
    await pool.query(
      "insert into currencies (code, minor_unit) values ('USD', 2) on conflict do nothing",
    );
  });

  after(async () => {
    await store.close();
    await pool.end();
    await admin.end();
  });

  async function account(allowsNegative: boolean, type = "asset"): Promise<string> {
    const id = newId();
    await pool.query(
      `insert into accounts (id, name, type, currency, allows_negative)
       values ($1, $2, $3, 'USD', $4)`,
      [id, `reversal fixture ${id}`, type, allowsNegative],
    );
    return id;
  }

  async function post(from: string, to: string, amount: bigint): Promise<StoredTransaction> {
    const outcome = await postTransaction(deps, {
      idempotencyKey: `post-${newId()}`,
      description: "A posting that may need undoing",
      occurredAt: new Date("2026-03-01T10:00:00.000Z"),
      entries: [
        { accountId: to, direction: "debit", amount },
        { accountId: from, direction: "credit", amount },
      ],
    });
    assert.equal(outcome.status, "posted");
    return outcome.transaction;
  }

  it("writes the exact mirror and leaves both accounts as they were", async () => {
    const source = await account(true, "revenue");
    const destination = await account(false);
    const original = await post(source, destination, 4_200n);

    assert.equal(await store.balanceOf(destination), 4_200n);

    const outcome = await reverseTransaction(deps, {
      transactionId: original.id,
      idempotencyKey: `undo-${newId()}`,
      description: "Posted in error",
    });

    assert.equal(outcome.status, "reversed");
    if (outcome.status !== "reversed") {
      return;
    }

    assert.equal(outcome.transaction.reversesTransactionId, original.id);
    assert.equal(await store.balanceOf(destination), 0n, "the pair cancels on every account");
    assert.equal(await store.balanceOf(source), 0n);

    const directions = outcome.transaction.entries.map((entry) => ({
      accountId: entry.accountId,
      direction: entry.direction,
      amount: entry.amount,
    }));
    assert.deepEqual(directions.toSorted(byAccount), [
      { accountId: destination, direction: "credit", amount: 4_200n },
      { accountId: source, direction: "debit", amount: 4_200n },
    ].toSorted(byAccount));
  });

  /**
   * Bitemporality: the reversal undoes something that happened on the original's business
   * date, so a report by business date reads the same with the pair as without it. When
   * the correction was learned of lives in recorded_at instead, and is not lost.
   */
  it("carries the original's business date, not today's", async () => {
    const source = await account(true, "revenue");
    const destination = await account(true);
    const original = await post(source, destination, 100n);

    const outcome = await reverseTransaction(deps, {
      transactionId: original.id,
      idempotencyKey: `undo-${newId()}`,
      description: "Posted in error",
    });
    assert.equal(outcome.status, "reversed");
    if (outcome.status !== "reversed") {
      return;
    }

    assert.deepEqual(outcome.transaction.occurredAt, original.occurredAt);
    assert.ok(
      outcome.transaction.recordedAt > original.occurredAt,
      "but the system learned of it now",
    );
  });

  it("refuses to reverse the same transaction twice", async () => {
    const source = await account(true, "revenue");
    const destination = await account(true);
    const original = await post(source, destination, 500n);

    const first = await reverseTransaction(deps, {
      transactionId: original.id,
      idempotencyKey: `undo-${newId()}`,
      description: "Posted in error",
    });
    assert.equal(first.status, "reversed");

    // A different key, so this is not idempotency doing the work: it is the unique index
    // on reverses_transaction_id, and the second insert losing it.
    const second = await reverseTransaction(deps, {
      transactionId: original.id,
      idempotencyKey: `undo-${newId()}`,
      description: "Undoing it again",
    });

    assert.equal(second.status, "rejected");
    if (second.status !== "rejected") {
      return;
    }
    assert.equal(second.rejections[0]?.code, "ALREADY_REVERSED");
  });

  it("refuses to reverse a reversal", async () => {
    const source = await account(true, "revenue");
    const destination = await account(true);
    const original = await post(source, destination, 800n);

    const first = await reverseTransaction(deps, {
      transactionId: original.id,
      idempotencyKey: `undo-${newId()}`,
      description: "Posted in error",
    });
    assert.equal(first.status, "reversed");
    if (first.status !== "reversed") {
      return;
    }

    const second = await reverseTransaction(deps, {
      transactionId: first.transaction.id,
      idempotencyKey: `undo-${newId()}`,
      description: "Undo the undo",
    });

    assert.equal(second.status, "rejected");
    if (second.status !== "rejected") {
      return;
    }
    assert.equal(second.rejections[0]?.code, "NOT_REVERSIBLE");
  });

  it("replays an honest retry and refuses the same key aimed elsewhere", async () => {
    const source = await account(true, "revenue");
    const destination = await account(true);
    const first = await post(source, destination, 300n);
    const other = await post(source, destination, 300n);

    const request = {
      transactionId: first.id,
      idempotencyKey: `undo-${newId()}`,
      description: "Posted in error",
    };

    const posted = await reverseTransaction(deps, request);
    assert.equal(posted.status, "reversed");

    const retried = await reverseTransaction(deps, request);
    assert.equal(retried.status, "replayed");
    if (posted.status === "reversed" && retried.status === "replayed") {
      assert.equal(retried.transaction.id, posted.transaction.id, "nothing new was written");
    }

    const reused = await reverseTransaction(deps, { ...request, transactionId: other.id });
    assert.equal(reused.status, "rejected");
    if (reused.status !== "rejected") {
      return;
    }
    assert.equal(reused.rejections[0]?.code, "IDEMPOTENCY_KEY_REUSED");
  });

  it("says so when there is nothing to reverse", async () => {
    const outcome = await reverseTransaction(deps, {
      transactionId: newId(),
      idempotencyKey: `undo-${newId()}`,
      description: "Undo something that never happened",
    });

    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") {
      return;
    }
    assert.equal(outcome.rejections[0]?.code, "UNKNOWN_TRANSACTION");
  });

  /**
   * The deliberate exception to the balance floor. By the time an error is found the money
   * is often already spent, and refusing the correction on the grounds that the account
   * cannot afford it would freeze the mistake in place permanently: the ledger would be
   * wrong precisely because fixing it did not fit.
   *
   * The shortfall this leaves is real and the audit reports it, which is the point. What
   * the reversal buys is that the cause is on the record.
   */
  it("goes through even when it leaves the account short", async () => {
    const revenue = await account(true, "revenue");
    const checking = await account(false);
    const elsewhere = await account(true);

    const funding = await post(revenue, checking, 10_000n);
    await post(checking, elsewhere, 10_000n);
    assert.equal(await store.balanceOf(checking), 0n, "the money has been spent");

    // A plain withdrawal at this point is refused, which is what makes the next line
    // meaningful rather than a demonstration that nothing was being enforced.
    const withdrawal = await postTransaction(deps, {
      idempotencyKey: `withdraw-${newId()}`,
      description: "Should be refused",
      occurredAt: new Date(),
      entries: [
        { accountId: elsewhere, direction: "debit", amount: 10_000n },
        { accountId: checking, direction: "credit", amount: 10_000n },
      ],
    });
    assert.equal(withdrawal.status, "rejected");

    try {
      const outcome = await reverseTransaction(deps, {
        transactionId: funding.id,
        idempotencyKey: `undo-${newId()}`,
        description: "The deposit never should have happened",
      });

      assert.equal(outcome.status, "reversed", "a correction is not subject to the floor");
      assert.equal(await store.balanceOf(checking), -10_000n);
    } finally {
      // The shortfall is genuine, so the audit would report it forever. Cleared here for
      // the same reason the write-skew demonstration clears its overdraft: a test must not
      // leave behind a finding nobody caused.
      await erase(admin, [revenue, checking, elsewhere]);
    }
  });

  it("refuses a hand-written reversal that is not a mirror", async () => {
    const source = await account(true, "revenue");
    const destination = await account(true);
    const original = await post(source, destination, 1_000n);

    // Straight to the tables, with no application in the way: the amounts do not match,
    // yet the transaction balances on its own, so only the mirror trigger objects.
    await assert.rejects(
      writeRawReversal(pool, original.id, [
        { accountId: destination, direction: "credit", amount: 900n },
        { accountId: source, direction: "debit", amount: 900n },
      ]),
      /not an exact mirror/,
    );
  });

  it("refuses a hand-written reversal that drops a leg", async () => {
    const source = await account(true, "revenue");
    const destination = await account(true);
    const third = await account(true);

    const outcome = await postTransaction(deps, {
      idempotencyKey: `post-${newId()}`,
      description: "Three legs",
      occurredAt: new Date(),
      entries: [
        { accountId: destination, direction: "debit", amount: 600n },
        { accountId: third, direction: "debit", amount: 400n },
        { accountId: source, direction: "credit", amount: 1_000n },
      ],
    });
    assert.equal(outcome.status, "posted");
    if (outcome.status !== "posted") {
      return;
    }

    await assert.rejects(
      writeRawReversal(pool, outcome.transaction.id, [
        { accountId: destination, direction: "credit", amount: 600n },
        { accountId: source, direction: "debit", amount: 600n },
      ]),
      /not an exact mirror/,
    );
  });

  it("refuses to link a reversal to itself", async () => {
    const id = newId();
    await assert.rejects(
      pool.query(
        `insert into transactions
           (id, idempotency_key, request_hash, description, occurred_at,
            reverses_transaction_id)
         values ($1, $2, 'raw', 'reverses itself', now(), $1)`,
        [id, `self-${id}`],
      ),
      /transactions_no_self_reversal|violates check/i,
    );
  });
});

type RawLeg = { accountId: string; direction: "debit" | "credit"; amount: bigint };

function byAccount(left: { accountId: string }, right: { accountId: string }): number {
  return left.accountId.localeCompare(right.accountId);
}

/** Writes a reversal straight to the tables so the database has to be the one refusing. */
async function writeRawReversal(
  pool: pg.Pool,
  reverses: string,
  legs: readonly RawLeg[],
): Promise<void> {
  const client = await pool.connect();
  const id = newId();
  try {
    await client.query("begin");
    await client.query(
      `insert into transactions
         (id, idempotency_key, request_hash, description, occurred_at, reverses_transaction_id)
       values ($1, $2, 'raw', 'bypasses the application', now(), $3)`,
      [id, `raw-${id}`, reverses],
    );
    for (const leg of legs) {
      await client.query(
        `insert into entries (id, transaction_id, account_id, currency, direction, amount)
         values ($1, $2, $3, 'USD', $4, $5::bigint)`,
        [newId(), id, leg.accountId, leg.direction, leg.amount.toString()],
      );
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/** Through the owner: removing a posting is not something the application may do. */
async function erase(pool: pg.Pool, accountIds: readonly string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const touched = await client.query<{ transaction_id: string }>(
      "select distinct transaction_id from entries where account_id = any($1::uuid[])",
      [accountIds],
    );
    const ids = touched.rows.map((row) => row.transaction_id);

    await client.query("delete from entries where transaction_id = any($1::uuid[])", [ids]);
    // Reversals first: a reversal points at what it undid, and the foreign key means the
    // target cannot go while something still refers to it.
    await client.query(
      "delete from transactions where id = any($1::uuid[]) and reverses_transaction_id is not null",
      [ids],
    );
    await client.query("delete from transactions where id = any($1::uuid[])", [ids]);
    await client.query("delete from accounts where id = any($1::uuid[])", [accountIds]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
