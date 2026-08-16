// http-auth.test.ts -- the bearer check, including the case that would have thrown.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAuthenticator } from "../../src/adapters/http/auth.ts";

const TOKEN = "0123456789abcdef0123456789abcdef";
const authenticate = createAuthenticator(TOKEN);

describe("the bearer token", () => {
  it("accepts the token it was built with", () => {
    assert.equal(authenticate(`Bearer ${TOKEN}`), true);
  });

  it("accepts the scheme in any case, as RFC 9110 requires", () => {
    assert.equal(authenticate(`bearer ${TOKEN}`), true);
  });

  it("refuses a different token of the same length", () => {
    assert.equal(authenticate(`Bearer ${"f".repeat(TOKEN.length)}`), false);
  });

  /**
   * The reason both sides are hashed before comparing. timingSafeEqual throws when its
   * buffers differ in length, so comparing raw tokens would answer a short guess with an
   * exception and a wrong guess with false -- and the difference between those two
   * behaviours is the length of the secret.
   */
  it("refuses a token of a different length without throwing", () => {
    assert.equal(authenticate("Bearer x"), false);
    assert.equal(authenticate(`Bearer ${TOKEN}${TOKEN}`), false);
  });

  it("refuses a missing header", () => {
    assert.equal(authenticate(undefined), false);
  });

  it("refuses the token without its scheme", () => {
    assert.equal(authenticate(TOKEN), false);
  });

  it("refuses another scheme", () => {
    assert.equal(authenticate(`Basic ${TOKEN}`), false);
  });

  it("refuses a repeated header rather than picking one", () => {
    assert.equal(authenticate([`Bearer ${TOKEN}`, "Bearer nope"]), false);
  });
});
