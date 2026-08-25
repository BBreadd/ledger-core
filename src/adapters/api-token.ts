// api-token.ts -- the shape of an API token, minted in one place and read in another.
// Depends on: node:crypto.

import { createHash, randomBytes } from "node:crypto";

/**
 * A token is `lgr_<keyId>.<secret>`.
 *
 * The key id travels in the clear, in front, so that verifying a token is one lookup by
 * primary key instead of a scan that hashes every row in the table against the presented
 * secret. That is the difference between authentication costing an index probe and costing
 * the whole credentials table, and it is the reason the format has two parts at all.
 *
 * The prefix is not decoration. A secret that leaks into a log, a screenshot or a commit is
 * findable by a fixed string, which is what secret scanners look for and what a person
 * greps for at three in the morning.
 *
 * The separator is a dot for a reason that can be checked rather than assumed: base64url's
 * alphabet is A-Z a-z 0-9 - _ and a UUID is hex and dashes, so a dot appears in neither
 * half. Splitting is unambiguous, which `-` or `_` would not have been.
 */
const PREFIX = "lgr_";
const SEPARATOR = ".";

/**
 * 32 bytes, from the platform's cryptographic source. 256 bits of entropy is the number the
 * storage decision leans on: it is what makes a fast digest the right hash for this and a
 * slow one pointless, so shrinking it here would silently invalidate that argument.
 */
const SECRET_BYTES = 32;

export type MintedToken = {
  /** Shown to the operator once, at issue time, and never recoverable afterwards. */
  readonly token: string;
  /** Stored. */
  readonly secretHash: Uint8Array;
};

export function mintToken(keyId: string): MintedToken {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  return {
    token: `${PREFIX}${keyId}${SEPARATOR}${secret}`,
    secretHash: digestOf(secret),
  };
}

export type PresentedToken = {
  readonly keyId: string;
  readonly secret: string;
};

/**
 * Reads a token without deciding anything about it. Returns null for anything that is not
 * shaped like one, which the caller must treat exactly as it treats a wrong secret: a
 * malformed token is a failed authentication, never an error.
 */
export function parseToken(raw: string): PresentedToken | null {
  if (!raw.startsWith(PREFIX)) {
    return null;
  }

  const body = raw.slice(PREFIX.length);
  const parts = body.split(SEPARATOR);
  if (parts.length !== 2) {
    return null;
  }

  const [keyId, secret] = parts;
  if (keyId === undefined || secret === undefined || keyId.length === 0 || secret.length === 0) {
    return null;
  }

  return { keyId, secret };
}

export function digestOf(secret: string): Uint8Array {
  return createHash("sha256").update(secret).digest();
}
