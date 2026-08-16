// auth.ts -- one static bearer token, compared in constant time. Depends on: node:crypto.

import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Authentication, and only authentication. There is no notion of which caller may touch
 * which account, because the domain has no model of ownership and inventing one here would
 * be building something nobody asked for. Anyone holding the token can do anything the API
 * offers. That limit is stated in the README rather than left for a reader to discover.
 */
export type Authenticator = (header: string | string[] | undefined) => boolean;

/**
 * Digests, not the raw strings, and not because hashing adds secrecy -- the token is
 * already in memory. timingSafeEqual throws when its two buffers differ in length, so
 * comparing raw tokens would answer "wrong length" by throwing and "wrong content" by
 * returning false, and the difference between those two is exactly the length of the
 * secret. Two SHA-256 digests are always 32 bytes, so the comparison has nothing to leak.
 */
export function createAuthenticator(token: string): Authenticator {
  const expected = createHash("sha256").update(token).digest();

  return (header) => {
    if (typeof header !== "string") {
      return false;
    }

    // The scheme is case-insensitive per RFC 9110; the token after it is not.
    const match = /^Bearer +(.+)$/i.exec(header.trim());
    const presented = match?.[1];
    if (presented === undefined) {
      return false;
    }

    return timingSafeEqual(expected, createHash("sha256").update(presented).digest());
  };
}
