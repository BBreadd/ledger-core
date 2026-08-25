// credential-directory.ts -- the PostgreSQL implementation of the CredentialDirectory port.
// Depends on: ports, pg.

import pg from "pg";
import type { ApiKeyRecord, CredentialDirectory, Scope } from "../../application/ports.ts";

/**
 * One row per request, read by primary key, and no cache.
 *
 * A credentials table that changes about never is the textbook place to memoise, and
 * memoising it is exactly how a revoked key keeps working for as long as the entry lives.
 * Revocation that takes effect "soon" is not revocation. There is no measurement saying
 * this indexed read costs anything, so it stays a read -- the same answer findCurrency got,
 * for a stronger reason.
 *
 * The pool is this adapter's own rather than shared with the ledger store. Sharing would
 * mean the composition root owning a pool and handing it to both, which is probably where
 * this ends up, but it is a change to how every adapter is constructed and it does not
 * belong smuggled inside an authorization change.
 */
export function createCredentialDirectory(databaseUrl: string): CredentialDirectory {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  return {
    async findKey(id: string): Promise<ApiKeyRecord | null> {
      // The id arrives inside a token a stranger composed, so it reaches the database as a
      // parameter and as nothing else. A malformed uuid is rejected by the type, which is
      // 22P02 rather than a row, and is caught below: an unparseable id is an absent key,
      // not a failed request.
      let result;
      try {
        result = await pool.query<{
          id: string;
          tenant_id: string;
          scope: string;
          secret_hash: unknown;
        }>(
          `select id, tenant_id, scope, secret_hash
             from api_keys
            where id = $1
              and revoked_at is null`,
          [id],
        );
      } catch (error) {
        if (isInvalidTextRepresentation(error)) {
          return null;
        }
        throw error;
      }

      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }

      return {
        id: row.id,
        tenantId: row.tenant_id,
        scope: toScope(row.scope),
        secretHash: toBytes(row.secret_hash),
      };
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

const INVALID_TEXT_REPRESENTATION = "22P02";

function isInvalidTextRepresentation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === INVALID_TEXT_REPRESENTATION
  );
}

/**
 * Converted at the boundary rather than annotated, for the reason every other column in
 * this adapter is: an annotation on a driver row is a promise about what the socket
 * produced, not a check of it. An enum arriving as something outside the two values it can
 * hold means the schema and this file have drifted, and that should stop the request rather
 * than authorize it under a scope nobody defined.
 */
function toScope(value: unknown): Scope {
  if (value === "read" || value === "write") {
    return value;
  }
  throw new TypeError(`api_keys.scope arrived as ${JSON.stringify(value)}, which is not a scope`);
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) {
    return value;
  }
  throw new TypeError(`api_keys.secret_hash arrived as ${typeof value}, cannot read it as bytes`);
}
