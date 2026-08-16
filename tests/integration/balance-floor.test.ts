// balance-floor.test.ts -- I9 across all five account types, since the rule is stated in
// normal-balance terms and there is no database backstop for it.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createLedgerStore } from "../../src/adapters/postgres/ledger-store.ts";
import { createUuidV7 } from "../../src/adapters/uuid-v7.ts";
import { postTransaction } from "../../src/application/post-transaction.ts";
import type { PostOutcome } from "../../src/application/post-transaction.ts";
import type { AccountType } from "../../src/domain/account.ts";
import { integrationDatabaseUrl, skipWithoutDatabase } from "./database-url.ts";

const newId = createUuidV7();

describe("the balance floor", { skip: skipWithoutDatabase }, () => {
  const url = integrationDatabaseUrl ?? "";
  const store = createLedgerStore(url);
  const pool = new pg.Pool({ connectionString: url });
  const deps = { store, newId };

  before(async () => {
    await store.ensureCurrency("USD", 2);
  });

  after(async () => {
    await store.close();
    await pool.end();
  });

  async function account(type: AccountType, allowsNegative = false): Promise<string> {
    const id = newId();
    await pool.query(
      `insert into accounts (id, name, type, currency, allows_negative)
       values ($1, $2, $3, 'USD', $4)`,
      [id, `floor fixture ${id}`, type, allowsNegative],
    );
    return id;
  }

  /** Moves `amount` by debiting `debit` and crediting `credit`. */
  function move(debit: string, credit: string, amount: bigint): Promise<PostOutcome> {
    return postTransaction(deps, {
      idempotencyKey: `floor-${newId()}`,
      description: "A posting the floor has an opinion about",
      occurredAt: new Date("2026-04-01T09:00:00.000Z"),
      entries: [
        { accountId: debit, direction: "debit", amount },
        { accountId: credit, direction: "credit", amount },
      ],
    });
  }

  function assertRefused(outcome: PostOutcome): void {
    assert.equal(outcome.status, "rejected");
    if (outcome.status !== "rejected") {
      return;
    }
    assert.equal(outcome.rejections[0]?.code, "INSUFFICIENT_FUNDS");
  }

  it("refuses to take a debit-normal account below zero", async () => {
    const checking = await account("asset");
    const elsewhere = await account("asset", true);

    assertRefused(await move(elsewhere, checking, 1n));
  });

  /**
   * The case the old rule got backwards. Stored sums are debit-positive, so earning
   * revenue drives the stored sum negative while the account is doing precisely what it
   * exists to do. Read by raw sign, `allows_negative = false` meant "may never be credited
   * on net" -- so the only way to have a working income account was to opt out of the
   * floor entirely, which is what the demo used to do.
   */
  it("lets a credit-normal account be credited on net", async () => {
    const revenue = await account("revenue");
    const cash = await account("asset", true);

    const outcome = await move(cash, revenue, 50_000n);

    assert.equal(outcome.status, "posted", "earning revenue is not overdrawing it");
    assert.equal((await store.findAccountBalance(revenue))?.balance, -50_000n);
  });

  it("refuses to take a credit-normal account below zero in its own direction", async () => {
    const revenue = await account("revenue");
    const cash = await account("asset", true);

    assertRefused(await move(revenue, cash, 1n));
  });

  /** Liability and equity are credit-normal too, and the rule is one rule, not three. */
  for (const type of ["liability", "equity"] as const) {
    it(`applies the same direction to a ${type} account`, async () => {
      const subject = await account(type);
      const cash = await account("asset", true);

      assert.equal((await move(cash, subject, 10_000n)).status, "posted");
      assertRefused(await move(subject, cash, 10_001n));
    });
  }

  it("lets an account opt out of the floor entirely", async () => {
    const spender = await account("asset", true);
    const receiver = await account("asset", true);

    assert.equal((await move(receiver, spender, 25n)).status, "posted");
    assert.equal((await store.findAccountBalance(spender))?.balance, -25n);
  });

  it("judges the net effect, not the individual legs", async () => {
    const checking = await account("asset");
    const other = await account("asset", true);

    await move(checking, other, 5_000n);

    // Credits 9000 and debits 9000 on the same account inside one transaction. Judged leg
    // by leg the credit alone would take it to -4000; judged on the result it never moves.
    const outcome = await postTransaction(deps, {
      idempotencyKey: `floor-${newId()}`,
      description: "Both directions on one account",
      occurredAt: new Date("2026-04-01T09:00:00.000Z"),
      entries: [
        { accountId: checking, direction: "credit", amount: 9_000n },
        { accountId: checking, direction: "debit", amount: 9_000n },
        { accountId: other, direction: "debit", amount: 1_000n },
        { accountId: other, direction: "credit", amount: 1_000n },
      ],
    });

    assert.equal(outcome.status, "posted");
    assert.equal((await store.findAccountBalance(checking))?.balance, 5_000n);
  });

  it("reports no balance for an account that does not exist", async () => {
    assert.equal(await store.findAccountBalance(newId()), null);
  });
});
