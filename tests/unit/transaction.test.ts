// transaction.test.ts -- the pure invariants. No database, no clock, no network.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fingerprint, netOf, validate } from "../../src/domain/transaction.ts";
import type { TransactionDraft } from "../../src/domain/transaction.ts";
import { format, signedAmount } from "../../src/domain/money.ts";
import { normalBalance } from "../../src/domain/account.ts";

const A = "11111111-1111-7111-8111-111111111111";
const B = "22222222-2222-7222-8222-222222222222";

function draft(overrides: Partial<TransactionDraft> = {}): TransactionDraft {
  return {
    idempotencyKey: "key-1",
    description: "Transfer",
    occurredAt: new Date("2026-01-01T00:00:00.000Z"),
    entries: [
      { accountId: A, direction: "debit", amount: 500n },
      { accountId: B, direction: "credit", amount: 500n },
    ],
    ...overrides,
  };
}

function codes(d: TransactionDraft): string[] {
  return validate(d).map((violation) => violation.code);
}

describe("double-entry validation", () => {
  it("accepts a balanced two-legged transfer", () => {
    assert.deepEqual(codes(draft()), []);
  });

  it("rejects debits that do not equal credits", () => {
    const codesOut = codes(
      draft({
        entries: [
          { accountId: A, direction: "debit", amount: 500n },
          { accountId: B, direction: "credit", amount: 400n },
        ],
      }),
    );
    assert.ok(codesOut.includes("UNBALANCED"));
  });

  it("rejects a single-legged transaction", () => {
    const codesOut = codes(
      draft({ entries: [{ accountId: A, direction: "debit", amount: 500n }] }),
    );
    assert.ok(codesOut.includes("TOO_FEW_ENTRIES"));
  });

  it("rejects both legs on the same account", () => {
    const codesOut = codes(
      draft({
        entries: [
          { accountId: A, direction: "debit", amount: 500n },
          { accountId: A, direction: "credit", amount: 500n },
        ],
      }),
    );
    assert.ok(codesOut.includes("TOO_FEW_ACCOUNTS"));
  });

  it("rejects a zero or negative amount", () => {
    assert.ok(
      codes(
        draft({
          entries: [
            { accountId: A, direction: "debit", amount: 0n },
            { accountId: B, direction: "credit", amount: 0n },
          ],
        }),
      ).includes("NON_POSITIVE_AMOUNT"),
    );
  });

  it("rejects an empty idempotency key", () => {
    assert.ok(codes(draft({ idempotencyKey: "   " })).includes("EMPTY_IDEMPOTENCY_KEY"));
  });

  it("balances a transaction with more than two legs", () => {
    const C = "33333333-3333-7333-8333-333333333333";
    assert.deepEqual(
      codes(
        draft({
          entries: [
            { accountId: A, direction: "debit", amount: 300n },
            { accountId: B, direction: "debit", amount: 200n },
            { accountId: C, direction: "credit", amount: 500n },
          ],
        }),
      ),
      [],
    );
  });

  it("stays exact past the range where a double would not", () => {
    const huge = 9_007_199_254_740_993n; // Number.MAX_SAFE_INTEGER + 2
    assert.equal(
      netOf([
        { accountId: A, direction: "debit", amount: huge },
        { accountId: B, direction: "credit", amount: huge },
      ]),
      0n,
    );
  });
});

describe("request fingerprint", () => {
  it("is identical for the same request", () => {
    assert.equal(fingerprint(draft()), fingerprint(draft()));
  });

  it("ignores the order the entries arrive in", () => {
    const forward = draft();
    const reversed = draft({ entries: [...draft().entries].reverse() });
    assert.equal(fingerprint(forward), fingerprint(reversed));
  });

  it("changes when the amount changes", () => {
    const other = draft({
      entries: [
        { accountId: A, direction: "debit", amount: 501n },
        { accountId: B, direction: "credit", amount: 501n },
      ],
    });
    assert.notEqual(fingerprint(draft()), fingerprint(other));
  });
});

describe("signs and presentation", () => {
  it("treats debits as positive and credits as negative", () => {
    assert.equal(signedAmount("debit", 100n), 100n);
    assert.equal(signedAmount("credit", 100n), -100n);
  });

  it("flips the stored sum for credit-normal accounts", () => {
    assert.equal(normalBalance("asset", 500n), 500n);
    assert.equal(normalBalance("expense", 500n), 500n);
    assert.equal(normalBalance("liability", -500n), 500n);
    assert.equal(normalBalance("revenue", -500n), 500n);
    assert.equal(normalBalance("equity", -500n), 500n);
  });

  it("places the decimal point according to the currency", () => {
    const usd = { code: "USD", minorUnit: 2 };
    const jpy = { code: "JPY", minorUnit: 0 };
    assert.equal(format(123_45n, usd), "123.45 USD");
    assert.equal(format(5n, usd), "0.05 USD");
    assert.equal(format(-123_45n, usd), "-123.45 USD");
    assert.equal(format(1234n, jpy), "1234 JPY");
  });
});
