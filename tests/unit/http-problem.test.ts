// http-problem.test.ts -- the mapping from a core rejection code to an HTTP status.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  problemFor,
  problemFromRejections,
  problemType,
  statusFor,
} from "../../src/adapters/http/problem.ts";
import type { ProblemCode } from "../../src/adapters/http/problem.ts";

/**
 * The agreed table, restated as data. Exhaustiveness is the compiler's job -- the mapping
 * is a Record over the union of every rejection code, so adding one to the core without
 * deciding its status fails `npm run typecheck`. What is left for a test is that the
 * statuses are the ones that were argued for, which no type can check.
 */
const EXPECTED: readonly (readonly [ProblemCode, number])[] = [
  ["UNBALANCED", 422],
  ["TOO_FEW_ENTRIES", 422],
  ["TOO_FEW_ACCOUNTS", 422],
  ["NON_POSITIVE_AMOUNT", 422],
  ["MIXED_CURRENCY", 422],
  ["UNKNOWN_ACCOUNT", 422],
  ["INSUFFICIENT_FUNDS", 422],
  ["IDEMPOTENCY_KEY_REUSED", 422],
  ["UNKNOWN_CURRENCY", 422],
  ["UNKNOWN_TRANSACTION", 404],
  ["ALREADY_REVERSED", 409],
  ["NOT_REVERSIBLE", 409],
  ["MALFORMED_REQUEST", 400],
  ["MISSING_IDEMPOTENCY_KEY", 400],
  ["UNAUTHORIZED", 401],
  ["NOT_FOUND", 404],
  ["METHOD_NOT_ALLOWED", 405],
  ["UNSUPPORTED_MEDIA_TYPE", 415],
  ["PAYLOAD_TOO_LARGE", 413],
  ["INTERNAL_ERROR", 500],
  ["SERVICE_UNAVAILABLE", 503],
];

describe("the status of each code", () => {
  for (const [code, status] of EXPECTED) {
    it(`answers ${code} with ${status}`, () => {
      assert.equal(statusFor(code), status);
    });
  }

  /**
   * The distinction that has to survive a refactor. POST /v1/transactions exists, so a
   * missing account named inside the body is not a statement about the URL. A missing
   * transaction on the reversal route is, because there the id is the URL.
   */
  it("keeps UNKNOWN_ACCOUNT and UNKNOWN_TRANSACTION apart", () => {
    assert.equal(statusFor("UNKNOWN_ACCOUNT"), 422);
    assert.equal(statusFor("UNKNOWN_TRANSACTION"), 404);
  });
});

describe("the problem document", () => {
  it("derives type from code so the two cannot drift", () => {
    assert.equal(problemType("INSUFFICIENT_FUNDS"), "urn:ledger-core:error:insufficient-funds");
  });

  it("carries the code itself, which is the part a client branches on", () => {
    const problem = problemFor("INSUFFICIENT_FUNDS", "account X would go to -1");
    assert.deepEqual(problem, {
      type: "urn:ledger-core:error:insufficient-funds",
      title: "Insufficient funds",
      status: 422,
      detail: "account X would go to -1",
      code: "INSUFFICIENT_FUNDS",
    });
  });

  it("attaches a requestId only where there is one to attach", () => {
    assert.equal("requestId" in problemFor("NOT_FOUND", "no such route"), false);
    assert.equal(problemFor("INTERNAL_ERROR", "boom", "abc").requestId, "abc");
  });
});

describe("several rejections at once", () => {
  it("reports the first and lists the rest, so one round trip finds them all", () => {
    const problem = problemFromRejections([
      { code: "TOO_FEW_ENTRIES", message: "got 1" },
      { code: "UNBALANCED", message: "got 500" },
    ]);

    assert.equal(problem.status, 422);
    assert.equal(problem.code, "TOO_FEW_ENTRIES");
    assert.deepEqual(problem.errors, [
      { code: "TOO_FEW_ENTRIES", message: "got 1" },
      { code: "UNBALANCED", message: "got 500" },
    ]);
  });

  it("omits the list when there is only one", () => {
    const problem = problemFromRejections([{ code: "UNBALANCED", message: "got 500" }]);
    assert.equal("errors" in problem, false);
  });

  it("refuses to invent a problem out of an empty list", () => {
    assert.throws(() => problemFromRejections([]), /at least one rejection/);
  });
});
