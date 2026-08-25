// api-token.test.ts -- the token format, including every shape that is not one.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { digestOf, mintToken, parseToken } from "../../src/adapters/api-token.ts";

const KEY_ID = "01923f9c-0000-7000-8000-000000000001";

describe("minting a token", () => {
  it("produces a token that parses back to the key it was minted for", () => {
    const minted = mintToken(KEY_ID);
    const parsed = parseToken(minted.token);

    assert.ok(parsed !== null);
    assert.equal(parsed.keyId, KEY_ID);
  });

  it("stores the digest of the secret and never the secret", () => {
    const minted = mintToken(KEY_ID);
    const parsed = parseToken(minted.token);

    assert.ok(parsed !== null);
    assert.deepEqual(minted.secretHash, digestOf(parsed.secret));
    assert.equal(minted.secretHash.length, 32);
  });

  it("never mints the same secret twice", () => {
    const first = mintToken(KEY_ID);
    const second = mintToken(KEY_ID);
    assert.notEqual(first.token, second.token);
  });

  /**
   * The prefix is what makes a leaked secret findable by a fixed string, in a log, a
   * screenshot or a commit. If it ever changes, it changes here and the scanners that were
   * told about it stop matching, so it is worth a test rather than a convention.
   */
  it("carries the prefix a secret scanner would be told to look for", () => {
    assert.ok(mintToken(KEY_ID).token.startsWith("lgr_"));
  });

  /**
   * The separator has to appear in neither half or splitting is guesswork. base64url is
   * A-Z a-z 0-9 - _ and a UUID is hex and dashes, so a dot is safe -- but "safe by
   * construction" is worth checking against a few hundred real secrets rather than
   * asserted, because the alternative failure is a token that authenticates as the wrong
   * key.
   */
  it("puts exactly one separator in the token, over many secrets", () => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      const token = mintToken(KEY_ID).token;
      assert.equal(token.split(".").length, 2, `token ${token} did not split in two`);
    }
  });
});

describe("reading a presented token", () => {
  it("refuses anything without the prefix", () => {
    const minted = mintToken(KEY_ID).token;
    assert.equal(parseToken(minted.slice("lgr_".length)), null);
    assert.equal(parseToken(`other_${minted.slice("lgr_".length)}`), null);
  });

  it("refuses a token with no separator", () => {
    assert.equal(parseToken(`lgr_${KEY_ID}`), null);
  });

  it("refuses a token with more than one separator", () => {
    assert.equal(parseToken(`lgr_${KEY_ID}.abc.def`), null);
  });

  it("refuses an empty half", () => {
    assert.equal(parseToken(`lgr_${KEY_ID}.`), null);
    assert.equal(parseToken("lgr_.secret"), null);
  });

  it("refuses the empty string", () => {
    assert.equal(parseToken(""), null);
  });

  /**
   * Parsing decides nothing. An id that is not a uuid is shaped like a token and is
   * therefore parsed; whether such a key exists is the directory's answer, not this one.
   * Keeping the two apart is why a malformed id cannot become a 500.
   */
  it("reads a well-shaped token whose key id is not a uuid", () => {
    const parsed = parseToken("lgr_not-a-uuid.secret");
    assert.ok(parsed !== null);
    assert.equal(parsed.keyId, "not-a-uuid");
  });
});
