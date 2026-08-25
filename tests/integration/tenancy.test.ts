// tenancy.test.ts -- one tenant cannot see, touch or name another's ledger.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createLedgerStore } from "../../src/adapters/postgres/ledger-store.ts";
import { createUuidV7 } from "../../src/adapters/uuid-v7.ts";
import { postTransaction } from "../../src/application/post-transaction.ts";
import { reverseTransaction } from "../../src/application/reverse-transaction.ts";
import type { StoredTransaction } from "../../src/application/ports.ts";
import { DEFAULT_TENANT_ID } from "../../src/domain/tenant.ts";
import { integrationAdminUrl, integrationDatabaseUrl, skipWithoutDatabase } from "./database-url.ts";

const newId = createUuidV7();

describe("what one tenant can reach of another", { skip: skipWithoutDatabase }, () => {
  const store = createLedgerStore(integrationDatabaseUrl ?? "");
  const app = new pg.Pool({ connectionString: integrationDatabaseUrl ?? "" });
  const admin = new pg.Pool({ connectionString: integrationAdminUrl ?? "" });
  const deps = { store, newId };

  const alice = DEFAULT_TENANT_ID;
  const bob = newId();

  let aliceAsset = "";
  let aliceRevenue = "";
  let bobAsset = "";
  let bobRevenue = "";
  let bobTransaction: StoredTransaction;

  before(async () => {
    await store.ensureCurrency("USD", 2);
    await admin.query("insert into tenants (id, name) values ($1, 'bob') on conflict do nothing", [
      bob,
    ]);

    aliceAsset = await account(alice, "asset");
    aliceRevenue = await account(alice, "revenue");
    bobAsset = await account(bob, "asset");
    bobRevenue = await account(bob, "revenue");

    const posted = await postTransaction(deps, draft(`bob-${newId()}`, bobAsset, bobRevenue), bob);
    assert.equal(posted.status, "posted");
    if (posted.status !== "posted") {
      throw new Error("the fixture transaction was not written");
    }
    bobTransaction = posted.transaction;
  });

  after(async () => {
    await Promise.all([store.close(), app.end(), admin.end()]);
  });

  async function account(tenantId: string, type: string): Promise<string> {
    const id = newId();
    await store.createAccount({
      id,
      tenantId,
      name: `tenancy ${type} ${id}`,
      type: type as "asset",
      currency: "USD",
      allowsNegative: true,
    });
    return id;
  }

  function draft(key: string, debit: string, credit: string) {
    return {
      idempotencyKey: key,
      description: "Tenancy fixture",
      occurredAt: new Date("2026-08-24T00:00:00.000Z"),
      entries: [
        { accountId: debit, direction: "debit" as const, amount: 1_000n },
        { accountId: credit, direction: "credit" as const, amount: 1_000n },
      ],
    };
  }

  /**
   * UNKNOWN_ACCOUNT rather than a refusal of its own, and that is the design rather than a
   * shortcut. The account is filtered out of the lock by the query, so it reaches the same
   * branch an id that was never created reaches. A distinct answer would confirm to a
   * stranger that the id exists.
   */
  it("refuses a posting against an account belonging to somebody else", async () => {
    const outcome = await postTransaction(
      deps,
      draft(`cross-${newId()}`, bobAsset, bobRevenue),
      alice,
    );

    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") {
      return;
    }
    assert.equal(outcome.rejections[0]?.code, "UNKNOWN_ACCOUNT");
  });

  it("answers a foreign account exactly as it answers an account that never existed", async () => {
    const foreign = await postTransaction(
      deps,
      draft(`foreign-${newId()}`, bobAsset, aliceRevenue),
      alice,
    );
    const invented = await postTransaction(
      deps,
      draft(`invented-${newId()}`, newId(), aliceRevenue),
      alice,
    );

    assert.equal(foreign.status, "rejected");
    assert.equal(invented.status, "rejected");
    if (foreign.status !== "rejected" || invented.status !== "rejected") {
      return;
    }
    assert.equal(foreign.rejections[0]?.code, invented.rejections[0]?.code);
  });

  it("reports no balance for an account that belongs to another tenant", async () => {
    assert.notEqual(await store.findAccountBalance(bobAsset, bob), null);
    assert.equal(await store.findAccountBalance(bobAsset, alice), null);
  });

  it("does not hand one tenant another's transaction", async () => {
    assert.notEqual(await store.findTransaction(bobTransaction.id, bob), null);
    assert.equal(await store.findTransaction(bobTransaction.id, alice), null);
  });

  it("refuses to reverse a transaction belonging to another tenant", async () => {
    const outcome = await reverseTransaction(deps, {
      transactionId: bobTransaction.id,
      tenantId: alice,
      idempotencyKey: `steal-${newId()}`,
      description: "Not mine to undo",
    });

    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") {
      return;
    }
    assert.equal(outcome.rejections[0]?.code, "UNKNOWN_TRANSACTION");
  });

  /**
   * The reason the unique index had to be scoped. With one global index the second tenant
   * either receives the first tenant's transaction in full -- the retry path hands back
   * whatever holds the key -- or is told the key is taken, which is still somebody else's
   * business. Callers name keys after their own orders, so this is the ordinary collision
   * rather than a remote one.
   */
  it("lets two tenants use the same idempotency key for different transactions", async () => {
    const key = `shared-${newId()}`;

    const first = await postTransaction(deps, draft(key, aliceAsset, aliceRevenue), alice);
    const second = await postTransaction(deps, draft(key, bobAsset, bobRevenue), bob);

    assert.equal(first.status, "posted");
    assert.equal(second.status, "posted");
    if (first.status !== "posted" || second.status !== "posted") {
      return;
    }
    assert.notEqual(first.transaction.id, second.transaction.id);

    // And neither tenant can reach the other's through the key they share.
    assert.equal((await store.findByIdempotencyKey(alice, key))?.id, first.transaction.id);
    assert.equal((await store.findByIdempotencyKey(bob, key))?.id, second.transaction.id);
  });

  it("still replays an honest retry within one tenant", async () => {
    const key = `retry-${newId()}`;
    const request = draft(key, aliceAsset, aliceRevenue);

    const first = await postTransaction(deps, request, alice);
    const again = await postTransaction(deps, request, alice);

    assert.equal(first.status, "posted");
    assert.equal(again.status, "replayed");
  });

  /**
   * Pins the behaviour that scoping the index broke and that the use case now settles for
   * itself. A retry of a reversal violates both unique indexes at once, and which one
   * reports is decided by the order the indexes were created -- rebuilding the idempotency
   * index moved it behind the reversal one, and the retry started coming back
   * ALREADY_REVERSED. Nothing in TypeScript would have caught that.
   */
  it("replays a retried reversal rather than calling it already reversed", async () => {
    const posted = await postTransaction(
      deps,
      draft(`rev-src-${newId()}`, aliceAsset, aliceRevenue),
      alice,
    );
    assert.equal(posted.status, "posted");
    if (posted.status !== "posted") {
      return;
    }

    const request = {
      transactionId: posted.transaction.id,
      tenantId: alice,
      idempotencyKey: `rev-${newId()}`,
      description: "Undo it",
    };

    const reversed = await reverseTransaction(deps, request);
    const retried = await reverseTransaction(deps, request);

    assert.equal(reversed.status, "reversed");
    assert.equal(retried.status, "replayed");
    if (reversed.status === "reversed" && retried.status === "replayed") {
      assert.equal(retried.transaction.id, reversed.transaction.id, "nothing new was written");
    }
  });

  it("still refuses a second reversal that arrives under a fresh key", async () => {
    const posted = await postTransaction(
      deps,
      draft(`twice-src-${newId()}`, aliceAsset, aliceRevenue),
      alice,
    );
    if (posted.status !== "posted") {
      throw new Error("the fixture transaction was not written");
    }

    const first = await reverseTransaction(deps, {
      transactionId: posted.transaction.id,
      tenantId: alice,
      idempotencyKey: `twice-a-${newId()}`,
      description: "Undo",
    });
    const second = await reverseTransaction(deps, {
      transactionId: posted.transaction.id,
      tenantId: alice,
      idempotencyKey: `twice-b-${newId()}`,
      description: "Undo again",
    });

    assert.equal(first.status, "reversed");
    assert.equal(second.status, "rejected");
    if (second.status !== "rejected") {
      return;
    }
    assert.equal(second.rejections[0]?.code, "ALREADY_REVERSED");
  });

  /**
   * The structural half, measured rather than assumed. Everything above is the application
   * declining to do something; this is the schema being unable to record it. Written the
   * way the adapter writes a posting, with one leg pointed at an account the transaction's
   * tenant does not own.
   */
  it("cannot record an entry whose account belongs to another tenant, even raw", async () => {
    const client = await app.connect();
    try {
      await client.query("begin");
      const transactionId = newId();
      await client.query(
        `insert into transactions
           (id, tenant_id, idempotency_key, request_hash, description, occurred_at)
         values ($1, $2, $3, 'raw', 'crosses a tenant boundary', now())`,
        [transactionId, alice, `raw-cross-${transactionId}`],
      );

      await assert.rejects(
        client.query(
          `insert into entries
             (id, transaction_id, tenant_id, account_id, currency, direction, amount)
           values ($1, $3, $4, $5, 'USD', 'debit', 100),
                  ($2, $3, $4, $6, 'USD', 'credit', 100)`,
          [newId(), newId(), transactionId, alice, aliceAsset, bobRevenue],
        ),
        /violates foreign key constraint "entries_account_tenant_fk"/,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });

  it("cannot record an entry whose transaction belongs to another tenant, even raw", async () => {
    const client = await app.connect();
    try {
      await client.query("begin");
      await assert.rejects(
        client.query(
          `insert into entries
             (id, transaction_id, tenant_id, account_id, currency, direction, amount)
           values ($1, $2, $3, $4, 'USD', 'debit', 100)`,
          [newId(), bobTransaction.id, alice, aliceAsset],
        ),
        /violates foreign key constraint "entries_transaction_tenant_fk"/,
      );
    } finally {
      await client.query("rollback");
      client.release();
    }
  });
});
