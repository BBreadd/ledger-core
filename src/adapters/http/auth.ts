// auth.ts -- turns an Authorization header into the caller it names. Depends on: adapters,
// application, node:crypto.

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CredentialDirectory, Scope } from "../../application/ports.ts";
import { digestOf, parseToken } from "../api-token.ts";

/**
 * Who is calling and what they are allowed to do. Which accounts they may touch is not
 * here: that is a question about the ledger's data, and it is answered where the data is
 * read.
 */
export type Principal = {
  readonly keyId: string;
  readonly tenantId: string;
  readonly scope: Scope;
};

export type Authenticator = (header: string | string[] | undefined) => Promise<Principal | null>;

/**
 * A digest to compare against when no key was found. Its only job is to make the code do
 * the same work either way, so that "no such key" and "wrong secret" leave by the same
 * door rather than one of them returning early.
 *
 * What this does not claim: that authentication is constant-time end to end. The database
 * lookup before it is a hit or a miss and those do not take the same time, and closing that
 * would cost far more machinery than the threat is worth -- a key id is a UUIDv7 with 74
 * random bits, so enumerating one is not an attack anybody runs. The dummy exists so the
 * comparison is not skipped, not so the timing is proven flat.
 */
const ABSENT_KEY_DIGEST = digestOf(randomBytes(32).toString("base64url"));

export function createAuthenticator(credentials: CredentialDirectory): Authenticator {
  return async (header) => {
    // An array means the header arrived more than once. Picking one would be choosing which
    // of two contradictory claims to believe.
    if (typeof header !== "string") {
      return null;
    }

    // The scheme is case-insensitive per RFC 9110; the token after it is not.
    const match = /^Bearer +(.+)$/i.exec(header.trim());
    const presented = match?.[1];
    if (presented === undefined) {
      return null;
    }

    const token = parseToken(presented);
    if (token === null) {
      return null;
    }

    const key = await credentials.findKey(token.keyId);
    const expected = key?.secretHash ?? ABSENT_KEY_DIGEST;

    // Digests, never the raw secrets. timingSafeEqual throws when its two buffers differ in
    // length, so comparing raw tokens would answer a short guess with an exception and a
    // wrong guess with false -- and the difference between those two behaviours is exactly
    // the length of the secret that the constant-time comparison exists in order not to
    // leak. Two SHA-256 digests are always 32 bytes and have nothing to say about each
    // other.
    const matches = timingSafeEqual(expected, digestOf(token.secret));
    if (key === null || !matches) {
      return null;
    }

    return { keyId: key.id, tenantId: key.tenantId, scope: key.scope };
  };
}

/**
 * Whether a credential's scope covers what a route asks for. write covers read, so a
 * credential able to post a transaction can also fetch the one it just posted -- the
 * Location header of its own 201 points at a route it would otherwise be refused.
 */
export function scopeAllows(held: Scope, required: Scope): boolean {
  return held === "write" || required === "read";
}
