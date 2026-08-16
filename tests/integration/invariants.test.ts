// invariants.test.ts -- what the database refuses even when the application is bypassed.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createUuidV7 } from "../../src/adapters/uuid-v7.ts";
import { integrationDatabaseUrl, skipWithoutDatabase } from "./database-url.ts";

const newId = createUuidV7();

describe(
  "invariants enforced by the database itself",
  { skip: skipWithoutDatabase },
  () => {
    const pool = new pg.Pool({ connectionString: integrationDatabaseUrl ?? "" });
    let usd: string;
    let eur: string;

    before(async () => {
      await pool.query(
        `insert into currencies (code, minor_unit)
         values ('USD', 2), ('EUR', 2) on conflict do nothing`,
      );
      usd = newId();
      eur = newId();
      await pool.query(
        `insert into accounts (id, name, type, currency, allows_negative)
         values ($1, 'usd account', 'asset', 'USD', true),
                ($2, 'eur account', 'asset', 'EUR', true)`,
        [usd, eur],
      );
    });

    after(async () => {
      await pool.end();
    });

    it("rejects a transaction whose debits do not equal its credits", async () => {
      const other = newId();
      await pool.query(
        `insert into accounts (id, name, type, currency, allows_negative)
         values ($1, 'counterparty', 'revenue', 'USD', true)`,
        [other],
      );

      await assert.rejects(
        writeRaw(pool, [
          { accountId: usd, currency: "USD", direction: "debit", amount: 100n },
          { accountId: other, currency: "USD", direction: "credit", amount: 90n },
        ]),
        /does not balance/,
      );
    });

    it("rejects a transaction with a single entry", async () => {
      await assert.rejects(
        writeRaw(pool, [{ accountId: usd, currency: "USD", direction: "debit", amount: 100n }]),
        /at least two/,
      );
    });

    it("rejects a transaction with no entries at all", async () => {
      await assert.rejects(writeRaw(pool, []), /at least two/);
    });

    it("rejects both legs landing on the same account", async () => {
      await assert.rejects(
        writeRaw(pool, [
          { accountId: usd, currency: "USD", direction: "debit", amount: 100n },
          { accountId: usd, currency: "USD", direction: "credit", amount: 100n },
        ]),
        /distinct account/,
      );
    });

    it("rejects a transaction that spans two currencies", async () => {
      await assert.rejects(
        writeRaw(pool, [
          { accountId: usd, currency: "USD", direction: "debit", amount: 100n },
          { accountId: eur, currency: "EUR", direction: "credit", amount: 100n },
        ]),
        /spans 2 currencies/,
      );
    });

    it("refuses an entry in a currency the account does not hold", async () => {
      await assert.rejects(
        writeRaw(pool, [
          { accountId: usd, currency: "EUR", direction: "debit", amount: 100n },
          { accountId: eur, currency: "EUR", direction: "credit", amount: 100n },
        ]),
        /foreign key|violates/i,
      );
    });

    it("refuses a non-positive amount", async () => {
      const other = newId();
      await pool.query(
        `insert into accounts (id, name, type, currency, allows_negative)
         values ($1, 'counterparty two', 'revenue', 'USD', true)`,
        [other],
      );

      await assert.rejects(
        writeRaw(pool, [
          { accountId: usd, currency: "USD", direction: "debit", amount: 0n },
          { accountId: other, currency: "USD", direction: "credit", amount: 0n },
        ]),
        /check constraint|violates/i,
      );
    });

    it("refuses entries appended to a transaction that is already committed", async () => {
      const other = newId();
      await pool.query(
        `insert into accounts (id, name, type, currency, allows_negative)
         values ($1, 'counterparty four', 'revenue', 'USD', true)`,
        [other],
      );

      const committed = await writeRaw(pool, [
        { accountId: usd, currency: "USD", direction: "debit", amount: 100n },
        { accountId: other, currency: "USD", direction: "credit", amount: 100n },
      ]);

      // Balanced, so the transaction still sums to zero afterwards and every reconciliation
      // check would go on passing. Nothing but the trigger stands between this and a
      // rewritten posting.
      await assert.rejects(
        appendRaw(pool, committed, [
          { accountId: usd, currency: "USD", direction: "debit", amount: 500n },
          { accountId: other, currency: "USD", direction: "credit", amount: 500n },
        ]),
        /already committed/,
      );

      const legs = await pool.query<{ legs: number }>(
        "select count(*)::int as legs from entries where transaction_id = $1",
        [committed],
      );
      assert.equal(legs.rows[0]?.legs, 2);
    });

    it("refuses to reuse an idempotency key", async () => {
      const other = newId();
      await pool.query(
        `insert into accounts (id, name, type, currency, allows_negative)
         values ($1, 'counterparty three', 'revenue', 'USD', true)`,
        [other],
      );

      const key = `duplicate-${newId()}`;
      const legs: RawEntry[] = [
        { accountId: usd, currency: "USD", direction: "debit", amount: 100n },
        { accountId: other, currency: "USD", direction: "credit", amount: 100n },
      ];

      await writeRaw(pool, legs, key);
      await assert.rejects(writeRaw(pool, legs, key), /duplicate key|unique/i);
    });
  },
);

type RawEntry = {
  accountId: string;
  currency: string;
  direction: "debit" | "credit";
  amount: bigint;
};

/**
 * Writes straight to the tables, with no application code in the way. Anything this
 * cannot get past is guaranteed by the database rather than by our discipline.
 */
async function writeRaw(
  pool: pg.Pool,
  entries: readonly RawEntry[],
  idempotencyKey?: string,
): Promise<string> {
  const client = await pool.connect();
  const transactionId = newId();
  try {
    await client.query("begin");
    await client.query(
      `insert into transactions (id, idempotency_key, request_hash, description, occurred_at)
       values ($1, $2, 'raw', 'bypasses the application', now())`,
      [transactionId, idempotencyKey ?? `raw-${transactionId}`],
    );
    for (const entry of entries) {
      await client.query(
        `insert into entries (id, transaction_id, account_id, currency, direction, amount)
         values ($1, $2, $3, $4, $5, $6::bigint)`,
        [
          newId(),
          transactionId,
          entry.accountId,
          entry.currency,
          entry.direction,
          entry.amount.toString(),
        ],
      );
    }
    await client.query("commit");
    return transactionId;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Adds entries to a transaction that already exists, in one statement, exactly the shape
 * the adapter uses to write a posting. The only difference is that the header is not this
 * transaction's to write.
 */
async function appendRaw(
  pool: pg.Pool,
  transactionId: string,
  entries: readonly RawEntry[],
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into entries (id, transaction_id, account_id, currency, direction, amount)
       select *
         from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::bpchar[],
                     $5::entry_direction[], $6::bigint[])`,
      [
        entries.map(() => newId()),
        entries.map(() => transactionId),
        entries.map((entry) => entry.accountId),
        entries.map((entry) => entry.currency),
        entries.map((entry) => entry.direction),
        entries.map((entry) => entry.amount.toString()),
      ],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}
