// concurrency.test.ts -- the race this project exists to prevent, and the proof it is prevented.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import pg from "pg";
import { createLedgerStore } from "../../src/adapters/postgres/ledger-store.ts";
import { createUuidV7 } from "../../src/adapters/uuid-v7.ts";
import { postTransaction } from "../../src/application/post-transaction.ts";
import type { PostOutcome } from "../../src/application/post-transaction.ts";
import {
  integrationAdminUrl,
  integrationDatabaseUrl,
  skipWithoutDatabase,
} from "./database-url.ts";

const newId = createUuidV7();

describe(
  "concurrent transfers against the same account",
  { skip: skipWithoutDatabase },
  () => {
    const url = integrationDatabaseUrl ?? "";
    const store = createLedgerStore(url);
    const pool = new pg.Pool({ connectionString: url });

    // Deleting a posting is not something the application may do, by design. Undoing a
    // violation this file commits on purpose is therefore the owner's job, and needing a
    // second connection to do it is the permission model working rather than getting in
    // the way.
    const admin = new pg.Pool({ connectionString: integrationAdminUrl ?? "" });

    after(async () => {
      await store.close();
      await pool.end();
      await admin.end();
    });

    /**
     * Not a test of our code -- a demonstration that the anomaly is real in PostgreSQL
     * under the default isolation level. Without it, the lock in postTransaction is a
     * precaution nobody can show the need for.
     *
     * Both writers read the same balance before either writes. Neither overwrites the
     * other: each inserts its own row. The invariant that breaks (balance >= 0) lives in
     * rows that neither of them touched, which is what makes this write skew rather than
     * a lost update, and why REPEATABLE READ would not catch it either.
     */
    it("overdraws the account when the balance is read without a lock", async () => {
      const { checking, revenue } = await seedAccounts(pool, 10_000n);

      const a = await pool.connect();
      const b = await pool.connect();
      try {
        await a.query("begin");
        await b.query("begin");

        const seenByA = await readBalance(a, checking);
        const seenByB = await readBalance(b, checking);
        assert.equal(seenByA, 10_000n, "A reads the full balance");
        assert.equal(seenByB, 10_000n, "B reads the same balance, having seen none of A");

        // Each writer independently concludes it has room for 60.00 out of 100.00.
        await insertRawTransfer(a, checking, revenue, 6_000n);
        await insertRawTransfer(b, checking, revenue, 6_000n);

        await a.query("commit");
        await b.query("commit");
      } finally {
        a.release();
        b.release();
      }

      // Cleared again before this returns. The overdraft has to be committed for the
      // demonstration to mean anything, and it is a real violation of the rule that no
      // account may go below zero -- leaving it behind would plant a permanent anomaly
      // that every future audit reports and nobody caused. A test that commits a
      // deliberate violation and walks away turns the auditor into a liar.
      try {
        const balance = await store.balanceOf(checking);
        assert.equal(balance, -2_000n, "both withdrawals landed and the account went negative");
      } finally {
        await erase(admin, [checking, revenue]);
      }
    });

    /**
     * The same scenario through the real code path. The lock turns the second writer's
     * read into a wait, so it reads the balance that already reflects the first write.
     */
    it("lets exactly one of two concurrent withdrawals through", async () => {
      const { checking, revenue } = await seedAccounts(pool, 10_000n);

      const withdraw = (key: string): Promise<PostOutcome> =>
        postTransaction(
          { store, newId },
          {
            idempotencyKey: key,
            description: "Concurrent withdrawal",
            occurredAt: new Date(),
            entries: [
              { accountId: revenue, direction: "debit", amount: 6_000n },
              { accountId: checking, direction: "credit", amount: 6_000n },
            ],
          },
        );

      const outcomes = await Promise.all([
        withdraw(`${newId()}-first`),
        withdraw(`${newId()}-second`),
      ]);

      const posted = outcomes.filter((outcome) => outcome.status === "posted");
      const rejected = outcomes.filter((outcome) => outcome.status === "rejected");

      assert.equal(posted.length, 1, "exactly one withdrawal is accepted");
      assert.equal(rejected.length, 1, "the other is refused");
      assert.equal(rejected[0]?.status === "rejected" && rejected[0].rejections[0]?.code,
        "INSUFFICIENT_FUNDS");

      const balance = await store.balanceOf(checking);
      assert.equal(balance, 4_000n, "the account never goes below zero");
    });

    /**
     * Two transfers touching the same pair of accounts in opposite order. Locking in id
     * order makes the cycle impossible; without it this deadlocks and PostgreSQL kills
     * one of the two with SQLSTATE 40P01.
     */
    it("does not deadlock when two transfers touch the same pair in opposite order", async () => {
      const { checking, revenue } = await seedAccounts(pool, 100_000n);

      const move = (key: string, from: string, to: string): Promise<PostOutcome> =>
        postTransaction(
          { store, newId },
          {
            idempotencyKey: key,
            description: "Opposing transfer",
            occurredAt: new Date(),
            entries: [
              { accountId: to, direction: "debit", amount: 100n },
              { accountId: from, direction: "credit", amount: 100n },
            ],
          },
        );

      const outcomes = await Promise.all(
        Array.from({ length: 10 }, (_unused, index) =>
          index % 2 === 0
            ? move(`${newId()}-forward`, checking, revenue)
            : move(`${newId()}-backward`, revenue, checking),
        ),
      );

      for (const outcome of outcomes) {
        assert.equal(outcome.status, "posted");
      }
    });
  },
);

async function seedAccounts(
  pool: pg.Pool,
  openingBalance: bigint,
): Promise<{ checking: string; revenue: string }> {
  const checking = newId();
  const revenue = newId();

  await pool.query(
    "insert into currencies (code, minor_unit) values ('USD', 2) on conflict do nothing",
  );
  await pool.query(
    `insert into accounts (id, name, type, currency, allows_negative)
     values ($1, $2, 'asset', 'USD', false), ($3, $4, 'revenue', 'USD', true)`,
    [checking, `checking ${checking}`, revenue, `revenue ${revenue}`],
  );

  // The header and its entries have to land in one database transaction. Two separate
  // pool.query calls are two transactions, and the first would commit a transaction with
  // no entries -- which the deferred trigger refuses, correctly.
  const client = await pool.connect();
  try {
    await client.query("begin");
    await insertRawTransfer(client, revenue, checking, openingBalance);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  return { checking, revenue };
}

/**
 * Removes every trace of the given accounts: their entries, the transactions those
 * entries belonged to, and the accounts themselves.
 *
 * All of it in one database transaction, because the intermediate state -- entries gone,
 * headers still there -- is itself an anomaly, and test files run in parallel, so an
 * audit running in another file could snapshot it and report transactions with no
 * entries that never existed for anyone.
 *
 * Takes the owner's pool, not the application's: DELETE on entries is a privilege the
 * application does not hold and `tests/integration/permissions.test.ts` proves it.
 */
async function erase(pool: pg.Pool, accountIds: readonly string[]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const touched = await client.query<{ transaction_id: string }>(
      "select distinct transaction_id from entries where account_id = any($1::uuid[])",
      [accountIds],
    );
    const transactionIds = touched.rows.map((row) => row.transaction_id);

    await client.query("delete from entries where transaction_id = any($1::uuid[])", [
      transactionIds,
    ]);
    await client.query("delete from transactions where id = any($1::uuid[])", [transactionIds]);
    await client.query("delete from accounts where id = any($1::uuid[])", [accountIds]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function readBalance(client: pg.PoolClient, accountId: string): Promise<bigint> {
  const result = await client.query<{ balance: unknown }>(
    "select coalesce(sum(signed_amount), 0)::bigint as balance from entries where account_id = $1",
    [accountId],
  );
  return BigInt(String(result.rows[0]?.balance ?? 0));
}

/** Deliberately bypasses the application: this is the naive write the lock exists to stop. */
async function insertRawTransfer(
  client: pg.PoolClient,
  from: string,
  to: string,
  amount: bigint,
): Promise<void> {
  const transactionId = newId();
  await client.query(
    `insert into transactions (id, idempotency_key, request_hash, description, occurred_at)
     values ($1, $2, 'raw', 'Unlocked withdrawal', now())`,
    [transactionId, `raw-${transactionId}`],
  );
  await client.query(
    `insert into entries (id, transaction_id, account_id, currency, direction, amount)
     values ($1, $3, $4, 'USD', 'debit', $6::bigint), ($2, $3, $5, 'USD', 'credit', $6::bigint)`,
    [newId(), newId(), transactionId, to, from, amount.toString()],
  );
}
