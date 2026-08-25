// credentials.test.ts -- who may read credentials, who may not, and what revocation does.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import { createCredentialDirectory } from "../../src/adapters/postgres/credential-directory.ts";
import { mintToken } from "../../src/adapters/api-token.ts";
import { createUuidV7 } from "../../src/adapters/uuid-v7.ts";
import {
  integrationAdminUrl,
  integrationAuditorUrl,
  integrationDatabaseUrl,
  skipWithoutDatabase,
} from "./database-url.ts";

const newId = createUuidV7();
const PERMISSION_DENIED = /permission denied/i;
const DEFAULT_TENANT = "00000000-0000-0000-0000-000000000001";

describe("credentials in the database", { skip: skipWithoutDatabase }, () => {
  const app = new pg.Pool({ connectionString: integrationDatabaseUrl ?? "" });
  const auditor = new pg.Pool({ connectionString: integrationAuditorUrl ?? "" });
  const admin = new pg.Pool({ connectionString: integrationAdminUrl ?? "" });
  const directory = createCredentialDirectory(integrationDatabaseUrl ?? "");

  const liveId = newId();
  const revokedId = newId();
  const live = mintToken(liveId);
  const revoked = mintToken(revokedId);

  before(async () => {
    // Through the owner, necessarily. That the application cannot do this is asserted below
    // and is the reason issuing is an entry point rather than an endpoint.
    await admin.query(
      `insert into api_keys (id, tenant_id, name, secret_hash, scope)
       values ($1, $3, 'credentials fixture live', $4, 'write'),
              ($2, $3, 'credentials fixture revoked', $5, 'read')`,
      [
        liveId,
        revokedId,
        DEFAULT_TENANT,
        Buffer.from(live.secretHash),
        Buffer.from(revoked.secretHash),
      ],
    );
    await admin.query("update api_keys set revoked_at = now() where id = $1", [revokedId]);
  });

  after(async () => {
    await admin.query("delete from api_keys where id = any($1)", [[liveId, revokedId]]);
    await Promise.all([app.end(), auditor.end(), admin.end(), directory.close()]);
  });

  /**
   * The tenant seeded by migration 0007. Without it, `migrate` then `issue-key` would need
   * a tenant invented in between, and the next migration would have nothing to backfill
   * accounts to -- which is the whole argument for the row existing in a migration at all.
   */
  it("starts with the default tenant a migrated database is supposed to have", async () => {
    const found = await admin.query("select name from tenants where id = $1", [DEFAULT_TENANT]);
    assert.equal(found.rowCount, 1);
  });

  it("lets the application read a live credential", async () => {
    const key = await directory.findKey(liveId);

    assert.ok(key !== null);
    assert.equal(key.id, liveId);
    assert.equal(key.tenantId, DEFAULT_TENANT);
    assert.equal(key.scope, "write");
    assert.deepEqual(Uint8Array.from(key.secretHash), Uint8Array.from(live.secretHash));
  });

  /**
   * Revocation with nothing cached in front of it. The row is still there and the digest
   * still matches; the key is gone from the directory's point of view, which is the only
   * point of view that decides anything.
   */
  it("hides a revoked credential instead of reporting it as revoked", async () => {
    assert.equal(await directory.findKey(revokedId), null);
  });

  it("answers null for a key nobody was issued", async () => {
    assert.equal(await directory.findKey(newId()), null);
  });

  /**
   * The key id arrives inside a token a stranger composed, so it is whatever they typed.
   * PostgreSQL answers a malformed uuid with 22P02, and letting that out would turn a
   * client's typo into a 500 on the authentication path.
   */
  it("answers null for a key id that is not a uuid at all", async () => {
    assert.equal(await directory.findKey("'; drop table api_keys; --"), null);
    assert.equal(await directory.findKey(""), null);
  });

  /**
   * Minimum privilege on the credentials table, measured rather than stated. The
   * application authenticates callers; it does not issue them, revoke them or record
   * anything about them, so a compromised application role reads digests it cannot reverse
   * and cannot mint itself a second way in.
   */
  it("refuses the application everything on api_keys except reading it", async () => {
    await assert.rejects(
      app.query(
        `insert into api_keys (id, tenant_id, name, secret_hash, scope)
         values ($1, $2, 'forged', '\\x00', 'write')`,
        [newId(), DEFAULT_TENANT],
      ),
      PERMISSION_DENIED,
    );
    await assert.rejects(
      app.query("update api_keys set revoked_at = null where id = $1", [revokedId]),
      PERMISSION_DENIED,
    );
    await assert.rejects(
      app.query("delete from api_keys where id = $1", [liveId]),
      PERMISSION_DENIED,
    );
  });

  /**
   * Nothing is granted on tenants, and nothing needs to be: authentication reads tenant_id
   * off the key row, and referential checks against tenants run as the constraint's owner
   * rather than as the writer. A grant here would be a privilege issued for a query that
   * does not exist.
   */
  it("does not let the application read the tenants table", async () => {
    await assert.rejects(app.query("select id from tenants"), PERMISSION_DENIED);
  });

  /**
   * The auditor exists in order to be harmless, so it is the last role that should be able
   * to read live credentials. It gets nothing on either table.
   */
  it("keeps credentials out of reach of the read-only auditor", async () => {
    await assert.rejects(auditor.query("select id from api_keys"), PERMISSION_DENIED);
    await assert.rejects(auditor.query("select id from tenants"), PERMISSION_DENIED);
  });
});
