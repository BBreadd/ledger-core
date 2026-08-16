// http.test.ts -- the surface against a real server on a real port over a real database.

import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import type { Server } from "node:http";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createLedgerServer } from "../../src/adapters/http/server.ts";
import { createLedgerStore } from "../../src/adapters/postgres/ledger-store.ts";
import { createUuidV7 } from "../../src/adapters/uuid-v7.ts";
import { integrationDatabaseUrl, skipWithoutDatabase } from "./database-url.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const newId = createUuidV7();

type Response = {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Record<string, unknown>;
};

type Options = {
  readonly body?: unknown;
  readonly key?: string;
  readonly token?: string | null;
  readonly contentType?: string;
};

describe("the HTTP surface", { skip: skipWithoutDatabase }, () => {
  const url = integrationDatabaseUrl ?? "";
  const store = createLedgerStore(url);
  const pool = new pg.Pool({ connectionString: url });
  let server: Server;
  let origin = "";

  before(async () => {
    await store.ensureCurrency("USD", 2);

    // Port 0 lets the kernel pick a free one. A hardcoded port makes a test suite fail on
    // whichever machine already has something listening there.
    server = createLedgerServer({ store, newId, token: TOKEN, log: () => {} });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    origin = `http://127.0.0.1:${address.port}`;
  });

  after(async () => {
    // Before close(), not after. fetch keeps its sockets alive, and close() waits for open
    // connections to go idle, so a suite that only calls close() hangs until keep-alive
    // times out.
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await store.close();
    await pool.end();
  });

  async function call(method: string, path: string, options: Options = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    const token = options.token === undefined ? TOKEN : options.token;
    if (token !== null) {
      headers["Authorization"] = `Bearer ${token}`;
    }
    if (options.body !== undefined) {
      headers["Content-Type"] = options.contentType ?? "application/json";
    }
    if (options.key !== undefined) {
      headers["Idempotency-Key"] = options.key;
    }

    const response = await fetch(`${origin}${path}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  }

  async function account(type: string, allowsNegative = false): Promise<string> {
    const created = await call("POST", "/v1/accounts", {
      body: { name: `http fixture ${newId()}`, type, currency: "USD", allowsNegative },
    });
    assert.equal(created.status, 201);
    return created.body["id"] as string;
  }

  function transfer(
    debit: string,
    credit: string,
    amount: string,
  ): { description: string; occurredAt: string; entries: unknown[] } {
    return {
      description: "Move value",
      occurredAt: "2026-08-15T12:00:00.000Z",
      entries: [
        { accountId: debit, direction: "debit", amount },
        { accountId: credit, direction: "credit", amount },
      ],
    };
  }

  /** Funds an asset account from revenue, the way the demo does. */
  async function funded(amount: string): Promise<string> {
    const asset = await account("asset");
    const revenue = await account("revenue");
    const posted = await call("POST", "/v1/transactions", {
      key: `fund-${newId()}`,
      body: transfer(asset, revenue, amount),
    });
    assert.equal(posted.status, 201);
    return asset;
  }

  describe("health", () => {
    it("answers without credentials, so a load balancer can reach it", async () => {
      const response = await call("GET", "/health", { token: null });
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, { status: "ok" });
    });
  });

  describe("authentication", () => {
    it("refuses a write with no token", async () => {
      const response = await call("GET", `/v1/accounts/${newId()}/balance`, { token: null });
      assert.equal(response.status, 401);
      assert.equal(response.body["code"], "UNAUTHORIZED");
    });

    it("refuses a write with the wrong token", async () => {
      const response = await call("POST", "/v1/accounts", {
        token: "f".repeat(TOKEN.length),
        body: { name: "X", type: "asset", currency: "USD" },
      });
      assert.equal(response.status, 401);
    });

    it("answers a refusal as problem+json", async () => {
      const response = await call("GET", "/v1/transactions/nope", { token: null });
      assert.equal(response.headers.get("content-type"), "application/problem+json");
    });
  });

  describe("creating an account", () => {
    it("returns the account with its minor unit", async () => {
      const response = await call("POST", "/v1/accounts", {
        body: { name: "Checking", type: "asset", currency: "USD" },
      });

      assert.equal(response.status, 201);
      assert.equal(response.body["minorUnit"], 2);
      assert.equal(response.body["type"], "asset");
      assert.equal(response.body["allowsNegative"], false);
      assert.match(response.body["id"] as string, /^[0-9a-f-]{36}$/);
    });

    /** Without the currency lookup this reaches the foreign key on accounts.currency and
     * comes back as an unmapped 23503, which the caller would see as a 500. */
    it("refuses an unknown currency with something the caller can act on", async () => {
      const response = await call("POST", "/v1/accounts", {
        body: { name: "X", type: "asset", currency: "XYZ" },
      });

      assert.equal(response.status, 422);
      assert.equal(response.body["code"], "UNKNOWN_CURRENCY");
    });
  });

  describe("posting a transaction", () => {
    it("returns 201 with a Location that resolves", async () => {
      const asset = await account("asset");
      const revenue = await account("revenue");

      const posted = await call("POST", "/v1/transactions", {
        key: `post-${newId()}`,
        body: transfer(asset, revenue, "50000"),
      });

      assert.equal(posted.status, 201);
      const location = posted.headers.get("location");
      assert.equal(location, `/v1/transactions/${posted.body["id"] as string}`);

      const fetched = await call("GET", location ?? "");
      assert.equal(fetched.status, 200);
      assert.equal(fetched.body["id"], posted.body["id"]);
    });

    it("sends amounts as strings of minor units, with the currency beside them", async () => {
      const asset = await account("asset");
      const revenue = await account("revenue");

      const posted = await call("POST", "/v1/transactions", {
        key: `wire-${newId()}`,
        body: transfer(asset, revenue, "50000"),
      });

      assert.equal(posted.body["currency"], "USD");
      assert.equal(posted.body["minorUnit"], 2);
      assert.equal(typeof posted.body["seq"], "string");
      const entries = posted.body["entries"] as { amount: unknown }[];
      assert.deepEqual(
        entries.map((entry) => entry.amount),
        ["50000", "50000"],
      );
    });

    it("does not leak the request hash, which is the server's business", async () => {
      const asset = await account("asset");
      const revenue = await account("revenue");
      const posted = await call("POST", "/v1/transactions", {
        key: `hash-${newId()}`,
        body: transfer(asset, revenue, "100"),
      });

      assert.equal("requestHash" in posted.body, false);
    });

    /** 201 against 200 is how a caller learns whether its retry landed or whether the
     * original had already been recorded. */
    it("replays a retry with 200 and the same transaction", async () => {
      const asset = await account("asset");
      const revenue = await account("revenue");
      const key = `replay-${newId()}`;
      const body = transfer(asset, revenue, "1500");

      const first = await call("POST", "/v1/transactions", { key, body });
      const second = await call("POST", "/v1/transactions", { key, body });

      assert.equal(first.status, 201);
      assert.equal(second.status, 200);
      assert.equal(second.body["id"], first.body["id"]);
    });

    it("refuses the same key carrying a different request", async () => {
      const asset = await account("asset");
      const revenue = await account("revenue");
      const key = `reuse-${newId()}`;

      await call("POST", "/v1/transactions", { key, body: transfer(asset, revenue, "1500") });
      const second = await call("POST", "/v1/transactions", {
        key,
        body: transfer(asset, revenue, "1600"),
      });

      assert.equal(second.status, 422);
      assert.equal(second.body["code"], "IDEMPOTENCY_KEY_REUSED");
    });

    it("requires the idempotency key", async () => {
      const asset = await account("asset");
      const revenue = await account("revenue");
      const response = await call("POST", "/v1/transactions", {
        body: transfer(asset, revenue, "100"),
      });

      assert.equal(response.status, 400);
      assert.equal(response.body["code"], "MISSING_IDEMPOTENCY_KEY");
    });

    it("passes core rejections through with their own codes", async () => {
      const asset = await account("asset");
      const revenue = await account("revenue");

      const unbalanced = await call("POST", "/v1/transactions", {
        key: `unbalanced-${newId()}`,
        body: {
          description: "Never reaches the database",
          occurredAt: "2026-08-15T12:00:00.000Z",
          entries: [
            { accountId: asset, direction: "debit", amount: "10000" },
            { accountId: revenue, direction: "credit", amount: "9000" },
          ],
        },
      });

      assert.equal(unbalanced.status, 422);
      assert.equal(unbalanced.body["code"], "UNBALANCED");
    });

    it("refuses an overdraft with INSUFFICIENT_FUNDS, not a generic error", async () => {
      const asset = await funded("50000");
      const other = await account("asset", true);

      const response = await call("POST", "/v1/transactions", {
        key: `overdraft-${newId()}`,
        body: transfer(other, asset, "999999"),
      });

      assert.equal(response.status, 422);
      assert.equal(response.body["code"], "INSUFFICIENT_FUNDS");
    });

    /** 422 and not 404: POST /v1/transactions exists. What is missing is named in the body. */
    it("answers an unknown account with 422, since the URL is not what is missing", async () => {
      const asset = await account("asset");
      const response = await call("POST", "/v1/transactions", {
        key: `ghost-${newId()}`,
        body: transfer(asset, newId(), "100"),
      });

      assert.equal(response.status, 422);
      assert.equal(response.body["code"], "UNKNOWN_ACCOUNT");
    });
  });

  describe("reading a balance", () => {
    it("presents the normal balance, not the stored sum", async () => {
      const asset = await account("asset");
      const revenue = await account("revenue");
      await call("POST", "/v1/transactions", {
        key: `balance-${newId()}`,
        body: transfer(asset, revenue, "50000"),
      });

      const assetBalance = await call("GET", `/v1/accounts/${asset}/balance`);
      const revenueBalance = await call("GET", `/v1/accounts/${revenue}/balance`);

      // The revenue account's stored sum is -50000. Credits increase it, so what it holds
      // is 50000, and that is what an API reader has a right to see.
      assert.equal(assetBalance.body["balance"], "50000");
      assert.equal(revenueBalance.body["balance"], "50000");
      assert.equal(revenueBalance.body["minorUnit"], 2);
    });

    /** coalesce(sum(...), 0) answers zero for an account with no entries and for an
     * account that does not exist. Only one of those is a 200. */
    it("answers 404 for an id nobody created, not a balance of zero", async () => {
      const response = await call("GET", `/v1/accounts/${newId()}/balance`);
      assert.equal(response.status, 404);
      assert.equal(response.body["code"], "NOT_FOUND");
    });

    it("answers 400 for an id that is not a UUID", async () => {
      const response = await call("GET", "/v1/accounts/not-a-uuid/balance");
      assert.equal(response.status, 400);
    });
  });

  describe("reversing a transaction", () => {
    it("creates the mirror and refuses to do it twice", async () => {
      const asset = await funded("50000");
      const savings = await account("asset");

      const posted = await call("POST", "/v1/transactions", {
        key: `to-reverse-${newId()}`,
        body: transfer(savings, asset, "12000"),
      });
      const id = posted.body["id"] as string;

      const reversed = await call("POST", `/v1/transactions/${id}/reversal`, {
        key: `undo-${newId()}`,
        body: { description: "Posted in error" },
      });
      assert.equal(reversed.status, 201);
      assert.equal(reversed.body["reversesTransactionId"], id);

      const again = await call("POST", `/v1/transactions/${id}/reversal`, {
        key: `undo-again-${newId()}`,
        body: { description: "Should be refused" },
      });
      assert.equal(again.status, 409);
      assert.equal(again.body["code"], "ALREADY_REVERSED");
    });

    it("leaves the balances exactly where they were", async () => {
      const asset = await funded("50000");
      const savings = await account("asset");

      const posted = await call("POST", "/v1/transactions", {
        key: `mirror-${newId()}`,
        body: transfer(savings, asset, "12000"),
      });

      await call("POST", `/v1/transactions/${posted.body["id"] as string}/reversal`, {
        key: `mirror-undo-${newId()}`,
        body: { description: "Undo" },
      });

      const balance = await call("GET", `/v1/accounts/${asset}/balance`);
      assert.equal(balance.body["balance"], "50000");
    });

    /** Here the id is the URL, so a missing one is genuinely about the URL. */
    it("answers 404 for a transaction that does not exist", async () => {
      const response = await call("POST", `/v1/transactions/${newId()}/reversal`, {
        key: `ghost-undo-${newId()}`,
        body: { description: "Nothing to undo" },
      });

      assert.equal(response.status, 404);
      assert.equal(response.body["code"], "UNKNOWN_TRANSACTION");
    });

    it("refuses to reverse a reversal", async () => {
      const asset = await funded("50000");
      const savings = await account("asset");

      const posted = await call("POST", "/v1/transactions", {
        key: `chain-${newId()}`,
        body: transfer(savings, asset, "500"),
      });
      const reversal = await call("POST", `/v1/transactions/${posted.body["id"] as string}/reversal`, {
        key: `chain-undo-${newId()}`,
        body: { description: "Undo" },
      });

      const again = await call("POST", `/v1/transactions/${reversal.body["id"] as string}/reversal`, {
        key: `chain-undo-undo-${newId()}`,
        body: { description: "Undo the undo" },
      });

      assert.equal(again.status, 409);
      assert.equal(again.body["code"], "NOT_REVERSIBLE");
    });
  });

  describe("requests that never reach the core", () => {
    it("answers 404 with a problem document for an unknown route", async () => {
      const response = await call("GET", "/v2/accounts");
      assert.equal(response.status, 404);
      assert.equal(response.body["code"], "NOT_FOUND");
    });

    it("answers 405 with Allow when the path exists under another verb", async () => {
      const response = await call("DELETE", "/v1/transactions");
      assert.equal(response.status, 405);
      assert.equal(response.headers.get("allow"), "POST");
    });

    it("answers 415 when the body is not declared as JSON", async () => {
      const response = await call("POST", "/v1/accounts", {
        body: { name: "X", type: "asset", currency: "USD" },
        contentType: "text/plain",
      });
      assert.equal(response.status, 415);
    });

    it("answers 400 for a body that is not JSON at all", async () => {
      const response = await fetch(`${origin}/v1/accounts`, {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: "{not json",
      });

      assert.equal(response.status, 400);
      assert.equal(((await response.json()) as Record<string, unknown>)["code"], "MALFORMED_REQUEST");
    });

    it("answers 400 for an amount sent as a JSON number", async () => {
      const asset = await account("asset");
      const revenue = await account("revenue");
      const response = await call("POST", "/v1/transactions", {
        key: `number-${newId()}`,
        body: {
          description: "Numbers lose precision",
          occurredAt: "2026-08-15T12:00:00.000Z",
          entries: [
            { accountId: asset, direction: "debit", amount: 12000 },
            { accountId: revenue, direction: "credit", amount: 12000 },
          ],
        },
      });

      assert.equal(response.status, 400);
    });

    it("refuses an oversized body it was told about in advance", async () => {
      const response = await call("POST", "/v1/accounts", {
        body: { name: "x".repeat(70_000), type: "asset", currency: "USD" },
      });

      assert.equal(response.status, 413);
      assert.equal(response.body["code"], "PAYLOAD_TOO_LARGE");
    });

    /**
     * The branch that actually defends the process. Content-Length is a hint: a chunked
     * request has none, and a hostile one can lie. Only the running byte count stops a
     * body from being however much memory the caller feels like spending.
     */
    it("refuses an oversized chunked body, which declares no length at all", async () => {
      const status = await chunkedPost(origin, "/v1/accounts", TOKEN, 70_000);
      assert.equal(status, 413);
    });
  });

  /**
   * The test the whole surface exists to make possible. Two identical POSTs at once are
   * serialised by the unique index on idempotency_key: the second blocks on it until the
   * first commits, then loses the insert with 23505 and replays. No lock of ours, no
   * retry loop, no check-then-insert.
   */
  describe("two identical requests at the same time", () => {
    it("writes exactly one transaction", async () => {
      const asset = await account("asset");
      const revenue = await account("revenue");
      const key = `concurrent-${newId()}`;
      const body = transfer(asset, revenue, "7700");

      const [first, second] = await Promise.all([
        call("POST", "/v1/transactions", { key, body }),
        call("POST", "/v1/transactions", { key, body }),
      ]);

      assert.deepEqual([first.status, second.status].sort(), [200, 201]);
      assert.equal(first.body["id"], second.body["id"]);

      const counted = await pool.query<{ count: string }>(
        "select count(*)::text as count from transactions where idempotency_key = $1",
        [key],
      );
      assert.equal(counted.rows[0]?.count, "1");
    });
  });
});

/**
 * A POST with no Content-Length. fetch cannot send one without a stream body and the
 * duplex option, and node:http says it more plainly than the cast would.
 */
function chunkedPost(origin: string, path: string, token: string, bytes: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, origin);
    const request = httpRequest(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "Transfer-Encoding": "chunked",
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );

    request.on("error", reject);
    request.write(`{"name":"${"x".repeat(bytes)}"`);
    request.end("}");
  });
}
