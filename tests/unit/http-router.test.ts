// http-router.test.ts -- matching, and the difference between a wrong path and a wrong method.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRouter } from "../../src/adapters/http/router.ts";

const ID = "0198f2c1-0000-7000-8000-000000000001";

const router = createRouter<string>({
  "GET /health": "health",
  "POST /v1/accounts": "create-account",
  "GET /v1/accounts/:id/balance": "balance",
  "POST /v1/transactions": "post",
  "GET /v1/transactions/:id": "get-transaction",
  "POST /v1/transactions/:id/reversal": "reverse",
});

describe("matching a route", () => {
  it("finds a literal path", () => {
    assert.deepEqual(router.match("GET", "/health"), {
      kind: "found",
      handler: "health",
      params: {},
    });
  });

  it("captures a path parameter", () => {
    const match = router.match("POST", `/v1/transactions/${ID}/reversal`);
    assert.equal(match.kind === "found" && match.handler, "reverse");
    assert.equal(match.kind === "found" && match.params["id"], ID);
  });

  it("tells two routes of different length apart", () => {
    assert.equal(router.match("POST", "/v1/transactions").kind, "found");
    assert.equal(router.match("GET", `/v1/transactions/${ID}`).kind, "found");
  });

  it("ignores the query string, since no route reads one", () => {
    assert.equal(router.match("GET", "/health?verbose=1").kind, "found");
  });

  it("treats a trailing slash as the same route", () => {
    assert.equal(router.match("GET", "/health/").kind, "found");
  });

  it("decodes percent-escapes before comparing", () => {
    const match = router.match("GET", "/v1/accounts/a%20b/balance");
    assert.equal(match.kind === "found" && match.params["id"], "a b");
  });
});

describe("when nothing matches", () => {
  it("says not-found for a path no route has", () => {
    assert.deepEqual(router.match("GET", "/v2/accounts"), { kind: "not-found" });
  });

  /** 405 rather than 404, with Allow, because the path does exist. Answering 404 would
   * tell a caller the resource is gone when the verb was the mistake. */
  it("says method-not-allowed for a path that exists under another verb", () => {
    assert.deepEqual(router.match("DELETE", "/v1/transactions"), {
      kind: "method-not-allowed",
      allowed: ["POST"],
    });
  });

  it("reports every verb a path answers to", () => {
    const match = router.match("PUT", `/v1/transactions/${ID}`);
    assert.equal(match.kind, "method-not-allowed");
    assert.deepEqual(match.kind === "method-not-allowed" ? [...match.allowed].sort() : [], ["GET"]);
  });

  /** decodeURIComponent throws on this. Letting it through would turn a broken URL into
   * a 500 instead of a 400. */
  it("refuses a target with a broken percent-escape", () => {
    assert.equal(router.match("GET", "/v1/accounts/%zz/balance").kind, "bad-target");
  });
});

describe("building a router", () => {
  it("refuses a pattern that is not METHOD /path", () => {
    assert.throws(() => createRouter({ "/health": "x" }), /METHOD \/path/);
  });
});
