// reversal.test.ts -- mirroring a posting, as pure arithmetic.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { flip } from "../../src/domain/money.ts";
import { mirror, netOf, reversalFingerprint } from "../../src/domain/transaction.ts";
import type { EntryContent } from "../../src/domain/transaction.ts";

const CHECKING = "account-checking";
const SAVINGS = "account-savings";

function leg(accountId: string, direction: "debit" | "credit", amount: bigint): EntryContent {
  return { accountId, direction, amount, currency: "USD" };
}

describe("flip", () => {
  it("is its own inverse", () => {
    assert.equal(flip("debit"), "credit");
    assert.equal(flip("credit"), "debit");
    assert.equal(flip(flip("debit")), "debit");
  });
});

describe("mirror", () => {
  it("turns every leg around and leaves everything else alone", () => {
    const original = [leg(SAVINGS, "debit", 12_000n), leg(CHECKING, "credit", 12_000n)];

    assert.deepEqual(mirror(original), [
      leg(SAVINGS, "credit", 12_000n),
      leg(CHECKING, "debit", 12_000n),
    ]);
  });

  it("cancels the original exactly, on every account", () => {
    const original = [
      leg(CHECKING, "debit", 700n),
      leg(SAVINGS, "credit", 250n),
      leg(SAVINGS, "credit", 450n),
    ];
    const both = [...original, ...mirror(original)];

    assert.equal(netOf(both), 0n, "the pair nets to zero overall");

    for (const account of [CHECKING, SAVINGS]) {
      const perAccount = both.filter((entry) => entry.accountId === account);
      assert.equal(netOf(perAccount), 0n, `${account} is left exactly as it was`);
    }
  });

  it("balances on its own, so a reversal is a valid transaction in its own right", () => {
    const original = [leg(CHECKING, "debit", 999n), leg(SAVINGS, "credit", 999n)];
    assert.equal(netOf(mirror(original)), 0n);
  });

  it("keeps identical legs identical instead of collapsing them", () => {
    // The database compares the two sides with EXCEPT ALL, which counts duplicates. A
    // mirror that returned one leg for two would be rejected there, so it must not here.
    const original = [
      leg(CHECKING, "debit", 100n),
      leg(CHECKING, "debit", 100n),
      leg(SAVINGS, "credit", 200n),
    ];
    const mirrored = mirror(original);

    assert.equal(mirrored.length, 3);
    assert.equal(mirrored.filter((entry) => entry.direction === "credit").length, 2);
  });

  it("never invents a negative amount", () => {
    const mirrored = mirror([leg(CHECKING, "debit", 5n), leg(SAVINGS, "credit", 5n)]);
    for (const entry of mirrored) {
      assert.ok(entry.amount > 0n, "a credit of minus five is not a thing this can express");
    }
  });
});

describe("reversalFingerprint", () => {
  const request = {
    idempotencyKey: "undo-1",
    transactionId: "transaction-a",
    description: "Made in error",
  };

  it("is identical for the same request", () => {
    assert.equal(reversalFingerprint(request), reversalFingerprint({ ...request }));
  });

  it("changes when the key is reused against a different transaction", () => {
    assert.notEqual(
      reversalFingerprint(request),
      reversalFingerprint({ ...request, transactionId: "transaction-b" }),
    );
  });

  it("changes when the description changes", () => {
    assert.notEqual(
      reversalFingerprint(request),
      reversalFingerprint({ ...request, description: "Something else" }),
    );
  });
});
