// permissions.test.ts -- immutability as a measured fact rather than a stated intention.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createUuidV7 } from "../../src/adapters/uuid-v7.ts";
import {
  integrationAdminUrl,
  integrationAuditorUrl,
  integrationDatabaseUrl,
  skipWithoutDatabase,
} from "./database-url.ts";

const newId = createUuidV7();
const PERMISSION_DENIED = /permission denied/i;

describe("what each role is allowed to do", { skip: skipWithoutDatabase }, () => {
  const app = new pg.Pool({ connectionString: integrationDatabaseUrl ?? "" });
  const auditor = new pg.Pool({ connectionString: integrationAuditorUrl ?? "" });
  const admin = new pg.Pool({ connectionString: integrationAdminUrl ?? "" });

  let transactionId: string;
  let accountId: string;

  before(async () => {
    await app.query(
      "insert into currencies (code, minor_unit) values ('USD', 2) on conflict do nothing",
    );

    accountId = newId();
    const counterparty = newId();
    await app.query(
      `insert into accounts (id, name, type, currency, allows_negative)
       values ($1, 'permission fixture', 'asset', 'USD', true),
              ($2, 'permission counterparty', 'revenue', 'USD', true)`,
      [accountId, counterparty],
    );

    transactionId = newId();
    const client = await app.connect();
    try {
      await client.query("begin");
      await client.query(
        `insert into transactions (id, idempotency_key, request_hash, description, occurred_at)
         values ($1, $2, 'permissions', 'a posting to try to tamper with', now())`,
        [transactionId, `permissions-${transactionId}`],
      );
      await client.query(
        `insert into entries (id, transaction_id, account_id, currency, direction, amount)
         values ($1, $3, $4, 'USD', 'debit', 100), ($2, $3, $5, 'USD', 'credit', 100)`,
        [newId(), newId(), transactionId, accountId, counterparty],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  });

  after(async () => {
    // Through the owner, necessarily: the connection that wrote this posting is not
    // allowed to remove it, which is the fact the suite above exists to establish.
    await admin.query("delete from entries where transaction_id = $1", [transactionId]);
    await admin.query("delete from transactions where id = $1", [transactionId]);
    await Promise.all([app.end(), auditor.end(), admin.end()]);
  });

  /**
   * The whole point of the step. Before this, "postings are immutable" was a sentence in
   * a document and a habit in the code: the application had every right to rewrite the
   * ledger and simply chose not to. Now the sentence is enforced by something that does
   * not depend on anyone's discipline, and these four assertions are the evidence.
   */
  it("refuses the application UPDATE and DELETE on postings", async () => {
    await assert.rejects(
      app.query("update entries set amount = 1 where transaction_id = $1", [transactionId]),
      PERMISSION_DENIED,
    );
    await assert.rejects(
      app.query("delete from entries where transaction_id = $1", [transactionId]),
      PERMISSION_DENIED,
    );
    await assert.rejects(
      app.query("update transactions set description = 'edited' where id = $1", [transactionId]),
      PERMISSION_DENIED,
    );
    await assert.rejects(
      app.query("delete from transactions where id = $1", [transactionId]),
      PERMISSION_DENIED,
    );
  });

  it("still lets the application read and append, which is its whole job", async () => {
    const balance = await app.query<{ balance: unknown }>(
      "select coalesce(sum(signed_amount), 0)::bigint as balance from entries where account_id = $1",
      [accountId],
    );
    assert.equal(String(balance.rows[0]?.balance), "100");

    // The identity sequence on transactions.seq is reachable through INSERT on the table
    // alone. A `serial` column would have needed its own grant on the sequence, and the
    // failure would have surfaced only on a database provisioned from scratch.
    const seq = await app.query<{ seq: unknown }>(
      "select seq from transactions where id = $1",
      [transactionId],
    );
    assert.ok(seq.rows[0] !== undefined, "the header was written and carries a sequence");
  });

  /**
   * PostgreSQL charges the UPDATE privilege for taking a row lock, even one that never
   * modifies the row, so the write path's defence against write skew is only possible
   * because of a column-level grant on accounts.name. These two assertions are what keeps
   * that grant honest: it has to be wide enough to lock and narrow enough that the columns
   * invariants hang off remain out of reach.
   */
  it("lets the application lock an account row without letting it rewrite one", async () => {
    const client = await app.connect();
    try {
      await client.query("begin");
      await client.query("select 1 from accounts where id = $1 for update", [accountId]);
      await client.query("rollback");
    } finally {
      client.release();
    }

    await assert.rejects(
      app.query("update accounts set allows_negative = true where id = $1", [accountId]),
      PERMISSION_DENIED,
      "allows_negative gates the balance floor and must stay out of the application's reach",
    );
    await assert.rejects(
      app.query("update accounts set type = 'liability' where id = $1", [accountId]),
      PERMISSION_DENIED,
    );
    await assert.rejects(
      app.query("update accounts set currency = 'EUR' where id = $1", [accountId]),
      PERMISSION_DENIED,
    );
  });

  it("keeps the application away from the migration ledger", async () => {
    await assert.rejects(app.query("select * from schema_migrations"), PERMISSION_DENIED);
  });

  it("gives the auditor reads and nothing else", async () => {
    const read = await auditor.query("select count(*) from entries");
    assert.ok(read.rows[0] !== undefined);

    await assert.rejects(
      auditor.query(
        `insert into currencies (code, minor_unit) values ('XXX', 2)`,
      ),
      PERMISSION_DENIED,
    );
    await assert.rejects(
      auditor.query("update accounts set name = 'renamed' where id = $1", [accountId]),
      PERMISSION_DENIED,
    );
    await assert.rejects(
      auditor.query("delete from entries where transaction_id = $1", [transactionId]),
      PERMISSION_DENIED,
    );
  });

  /**
   * A superuser bypasses every privilege check there is, so a suite that connected as one
   * would watch all of the above pass while proving nothing. If this ever fails, the role
   * behind DATABASE_URL has more authority than the tests above are able to detect.
   */
  it("connects the application as something that is not a superuser", async () => {
    const result = await app.query<{ superuser: boolean; role: string }>(
      "select usesuper as superuser, current_user as role from pg_user where usename = current_user",
    );
    assert.equal(
      result.rows[0]?.superuser,
      false,
      `DATABASE_URL connects as ${result.rows[0]?.role}, a superuser, which cannot be restricted`,
    );
  });
});
