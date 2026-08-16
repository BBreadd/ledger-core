// http-parse.test.ts -- the boundary where hostile JSON becomes a value the core accepts.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseIdempotencyKey,
  parseNewAccount,
  parseReversalDescription,
  parseTransactionDraft,
  parseUuidPath,
} from "../../src/adapters/http/parse.ts";
import type { ParseResult } from "../../src/adapters/http/parse.ts";

const ACCOUNT_A = "0198f2c1-0000-7000-8000-000000000001";
const ACCOUNT_B = "0198f2c1-0000-7000-8000-000000000002";

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    description: "Move to savings",
    occurredAt: "2026-08-15T12:00:00.000Z",
    entries: [
      { accountId: ACCOUNT_A, direction: "debit", amount: "12000" },
      { accountId: ACCOUNT_B, direction: "credit", amount: "12000" },
    ],
    ...overrides,
  };
}

function legs(amount: unknown): Record<string, unknown> {
  return body({ entries: [{ accountId: ACCOUNT_A, direction: "debit", amount }] });
}

function refusal<T>(result: ParseResult<T>): { code: string; message: string } {
  assert.equal(result.ok, false, "expected the parser to refuse this");
  return result.ok ? { code: "", message: "" } : { code: result.code, message: result.message };
}

describe("amounts on the wire", () => {
  it("accepts a string of minor units", () => {
    const result = parseTransactionDraft(body(), "key");
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.entries[0]?.amount, 12_000n);
  });

  /**
   * Every one of these is a value BigInt() reads happily, which is why the regex exists
   * and a try/catch around BigInt() would not have been enough. Measured on Node 22:
   * "" is 0n, "0x10" is 16n, "0b11" is 3n, "0o17" is 15n, "+5" is 5n, "007" is 7n, and
   * whitespace is trimmed before any of it.
   */
  for (const amount of ["", "  ", "0x10", "0b11", "0o17", "+5", "-5", "007", " 12 ", "0"]) {
    it(`refuses ${JSON.stringify(amount)}, which BigInt() would have accepted`, () => {
      assert.equal(refusal(parseTransactionDraft(legs(amount), "key")).code, "MALFORMED_REQUEST");
    });
  }

  it("refuses a JSON number, because it would lose precision above 2^53", () => {
    const { message } = refusal(parseTransactionDraft(legs(12_000), "key"));
    assert.match(message, /must be a string/);
  });

  it("refuses more digits than a BIGINT column holds", () => {
    assert.equal(refusal(parseTransactionDraft(legs("9".repeat(19)), "key")).code, "MALFORMED_REQUEST");
  });

  it("accepts the largest amount it allows", () => {
    const result = parseTransactionDraft(legs("9".repeat(18)), "key");
    assert.equal(result.ok, true);
  });
});

describe("occurredAt", () => {
  it("is required, because a default would break a retry's fingerprint", () => {
    const { code } = refusal(parseTransactionDraft(body({ occurredAt: undefined }), "key"));
    assert.equal(code, "MALFORMED_REQUEST");
  });

  /** new Date("2026") is a valid date in JavaScript. Accepting it turns a truncated
   * field into midnight on New Year's Day and nothing complains. */
  for (const value of ["2026", "2026-08-15", "hola", "15/08/2026", "2026-13-45T00:00:00Z"]) {
    it(`refuses ${JSON.stringify(value)}`, () => {
      assert.equal(refusal(parseTransactionDraft(body({ occurredAt: value }), "key")).code, "MALFORMED_REQUEST");
    });
  }

  it("accepts an offset, not only Z", () => {
    const result = parseTransactionDraft(body({ occurredAt: "2026-08-15T14:00:00+02:00" }), "key");
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.occurredAt.toISOString(), "2026-08-15T12:00:00.000Z");
  });
});

describe("the shape of a request", () => {
  it("refuses an unknown field instead of ignoring it", () => {
    const { message } = refusal(parseTransactionDraft(body({ ocurredAt: "typo" }), "key"));
    assert.match(message, /unknown field.*ocurredAt/);
  });

  it("refuses an unknown field inside an entry, saying which one", () => {
    const draft = body({
      entries: [{ accountId: ACCOUNT_A, direction: "debit", amount: "1", currency: "USD" }],
    });
    assert.match(refusal(parseTransactionDraft(draft, "key")).message, /entries\[0\].*currency/);
  });

  it("refuses an array where an object belongs", () => {
    assert.equal(refusal(parseTransactionDraft([], "key")).code, "MALFORMED_REQUEST");
  });

  it("refuses an accountId that is not a UUID", () => {
    const draft = body({ entries: [{ accountId: "42", direction: "debit", amount: "1" }] });
    assert.match(refusal(parseTransactionDraft(draft, "key")).message, /accountId must be a UUID/);
  });

  it("refuses a direction outside the vocabulary", () => {
    const draft = body({ entries: [{ accountId: ACCOUNT_A, direction: "DEBIT", amount: "1" }] });
    assert.match(refusal(parseTransactionDraft(draft, "key")).message, /debit, credit/);
  });

  it("refuses a description of whitespace", () => {
    assert.equal(refusal(parseTransactionDraft(body({ description: "   " }), "key")).code, "MALFORMED_REQUEST");
  });

  it("leaves counting entries to the core, which has a code for it", () => {
    const result = parseTransactionDraft(body({ entries: [] }), "key");
    assert.equal(result.ok, true, "an empty array parses; TOO_FEW_ENTRIES is the core's answer");
  });
});

describe("the idempotency key header", () => {
  it("is required, and says why", () => {
    const { code, message } = refusal(parseIdempotencyKey(undefined));
    assert.equal(code, "MISSING_IDEMPOTENCY_KEY");
    assert.match(message, /retry cannot post twice/);
  });

  it("accepts the bare form the industry sends", () => {
    assert.deepEqual(parseIdempotencyKey("abc-123"), { ok: true, value: "abc-123" });
  });

  it("accepts the quoted form the IETF draft asks for", () => {
    assert.deepEqual(parseIdempotencyKey('"abc-123"'), { ok: true, value: "abc-123" });
  });

  it("refuses an empty key", () => {
    assert.equal(refusal(parseIdempotencyKey('""')).code, "MALFORMED_REQUEST");
  });

  it("refuses the header repeated, rather than picking one", () => {
    assert.equal(refusal(parseIdempotencyKey(["a", "b"])).code, "MALFORMED_REQUEST");
  });
});

describe("new accounts", () => {
  it("defaults allowsNegative to false", () => {
    const result = parseNewAccount({ name: "Checking", type: "asset", currency: "USD" });
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    assert.equal(result.value.allowsNegative, false);
  });

  it("refuses a type outside the five", () => {
    const result = parseNewAccount({ name: "X", type: "cash", currency: "USD" });
    assert.match(refusal(result).message, /asset, liability, equity, revenue, expense/);
  });

  it("refuses a lowercase currency code", () => {
    const result = parseNewAccount({ name: "X", type: "asset", currency: "usd" });
    assert.match(refusal(result).message, /ISO 4217/);
  });

  it("refuses an id supplied by the caller, since the server assigns it", () => {
    const result = parseNewAccount({ id: ACCOUNT_A, name: "X", type: "asset", currency: "USD" });
    assert.match(refusal(result).message, /unknown field.*id/);
  });
});

describe("path parameters", () => {
  it("accepts a UUID", () => {
    assert.deepEqual(parseUuidPath(ACCOUNT_A), { ok: true, value: ACCOUNT_A });
  });

  /** Without this the id reaches PostgreSQL and comes back as 22P02, which the surface
   * has no mapping for -- a client typo would read as an internal error. */
  it("refuses anything else, so a typo cannot become a 500", () => {
    assert.equal(refusal(parseUuidPath("../../etc/passwd")).code, "MALFORMED_REQUEST");
  });
});

describe("reversal bodies", () => {
  it("takes a description and nothing else", () => {
    assert.deepEqual(parseReversalDescription({ description: "Posted in error" }), {
      ok: true,
      value: "Posted in error",
    });
  });

  it("refuses a transactionId in the body, since the URL already says which one", () => {
    const result = parseReversalDescription({ description: "x", transactionId: ACCOUNT_A });
    assert.match(refusal(result).message, /unknown field.*transactionId/);
  });
});
