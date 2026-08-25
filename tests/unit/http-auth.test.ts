// http-auth.test.ts -- the bearer check, including the cases that would have thrown.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthenticator, scopeAllows } from "../../src/adapters/http/auth.ts";
import { digestOf, mintToken } from "../../src/adapters/api-token.ts";
import type { ApiKeyRecord, CredentialDirectory, Scope } from "../../src/application/ports.ts";

const WRITER_ID = "01923f9c-0000-7000-8000-00000000000a";
const READER_ID = "01923f9c-0000-7000-8000-00000000000b";

const writer = mintToken(WRITER_ID);
const reader = mintToken(READER_ID);

/**
 * A directory holding two live keys and nothing else. Faked rather than run against
 * PostgreSQL because what is under test here is the comparison and the parsing; that the
 * real directory hides revoked keys is a fact about SQL and is measured against a real
 * database in the integration suite.
 */
const directory: CredentialDirectory = {
  async findKey(id: string): Promise<ApiKeyRecord | null> {
    const keys: Record<string, ApiKeyRecord> = {
      [WRITER_ID]: {
        id: WRITER_ID,
        tenantId: "tenant-1",
        scope: "write",
        secretHash: writer.secretHash,
      },
      [READER_ID]: {
        id: READER_ID,
        tenantId: "tenant-2",
        scope: "read",
        secretHash: reader.secretHash,
      },
    };
    return keys[id] ?? null;
  },
  async close(): Promise<void> {},
};

const authenticate = createAuthenticator(directory);

describe("the bearer token", () => {
  it("names the caller behind a valid token", async () => {
    const principal = await authenticate(`Bearer ${writer.token}`);

    assert.deepEqual(principal, { keyId: WRITER_ID, tenantId: "tenant-1", scope: "write" });
  });

  it("accepts the scheme in any case, as RFC 9110 requires", async () => {
    assert.notEqual(await authenticate(`bearer ${writer.token}`), null);
  });

  it("carries each key's own scope and tenant", async () => {
    const principal = await authenticate(`Bearer ${reader.token}`);

    assert.deepEqual(principal, { keyId: READER_ID, tenantId: "tenant-2", scope: "read" });
  });

  it("refuses a real key id with the wrong secret", async () => {
    const forged = `lgr_${WRITER_ID}.${"f".repeat(43)}`;
    assert.equal(await authenticate(`Bearer ${forged}`), null);
  });

  /**
   * A key id that does not exist must not take a different path from a secret that does not
   * match. Both leave through the same comparison against a dummy digest, which is why this
   * returns null rather than throwing on the missing hash.
   */
  it("refuses a key id nobody was ever issued", async () => {
    const unknown = mintToken("01923f9c-0000-7000-8000-0000000000ff");
    assert.equal(await authenticate(`Bearer ${unknown.token}`), null);
  });

  /**
   * The reason both sides are hashed before comparing. timingSafeEqual throws when its
   * buffers differ in length, so comparing raw secrets would answer a short guess with an
   * exception and a wrong guess with false -- and the difference between those two
   * behaviours is the length of the secret.
   */
  it("refuses a secret of a different length without throwing", async () => {
    assert.equal(await authenticate(`Bearer lgr_${WRITER_ID}.x`), null);
    assert.equal(
      await authenticate(`Bearer lgr_${WRITER_ID}.${"x".repeat(500)}`),
      null,
    );
  });

  it("refuses a token that is not shaped like one", async () => {
    assert.equal(await authenticate("Bearer 0123456789abcdef0123456789abcdef"), null);
    assert.equal(await authenticate(`Bearer lgr_${WRITER_ID}`), null);
  });

  it("refuses a missing header", async () => {
    assert.equal(await authenticate(undefined), null);
  });

  it("refuses the token without its scheme", async () => {
    assert.equal(await authenticate(writer.token), null);
  });

  it("refuses another scheme", async () => {
    assert.equal(await authenticate(`Basic ${writer.token}`), null);
  });

  it("refuses a repeated header rather than picking one", async () => {
    assert.equal(await authenticate([`Bearer ${writer.token}`, "Bearer nope"]), null);
  });

  it("does not authenticate a secret that only matches another key", async () => {
    const parsed = reader.token.slice(`lgr_${READER_ID}.`.length);
    assert.equal(digestOf(parsed).length, 32);
    assert.equal(await authenticate(`Bearer lgr_${WRITER_ID}.${parsed}`), null);
  });
});

describe("what a scope covers", () => {
  const cases: readonly { held: Scope; required: Scope; allowed: boolean }[] = [
    { held: "read", required: "read", allowed: true },
    { held: "read", required: "write", allowed: false },
    { held: "write", required: "read", allowed: true },
    { held: "write", required: "write", allowed: true },
  ];

  for (const { held, required, allowed } of cases) {
    it(`${allowed ? "allows" : "refuses"} a ${held} credential on a ${required} route`, () => {
      assert.equal(scopeAllows(held, required), allowed);
    });
  }
});
