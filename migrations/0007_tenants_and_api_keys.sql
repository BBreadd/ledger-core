-- Who is calling. Tenants are the identities the ledger will come to own accounts by;
-- API keys are the credentials that speak for one.

-- The two are separate tables rather than one, for the same reason the database roles are
-- already split into groups and logins: what an identity is and what a credential is have
-- different lifetimes. Folding them together would make the tenant the key itself, and
-- then rotating a credential would orphan everything that credential owns -- an
-- owner-run data migration every time a secret is replaced, against a table the
-- application holds no UPDATE on. Kept apart, a key can be issued, revoked and reissued
-- without a single row moving.
create table tenants (
  id         uuid primary key,
  name       text not null,
  created_at timestamptz not null default now()
);

create type api_key_scope as enum ('read', 'write');

-- A credential, and nothing about a person. No e-mail, no password, no session: this is a
-- machine-to-machine API and the thing on the other end is a program holding a secret.
--
-- secret_hash is bytea because it is bytes -- a SHA-256 digest, always 32 of them --
-- rather than text that happens to be printable.
--
-- That the digest is a plain SHA-256 and not argon2 or bcrypt is a decision, not an
-- oversight. Slow password hashes exist to make guessing expensive for a secret a human
-- chose, where a dictionary is the attack. This secret is 32 bytes from a cryptographic
-- random source and never exists anywhere else: there is no dictionary to run against 256
-- bits of entropy, so a slow hash would buy nothing while costing a native dependency and
-- latency on every request.
--
-- name carries no invariant and no query depends on it. It is here because without it a
-- list of credentials is a list of UUIDs, and revoking the right one becomes guesswork.
--
-- revoked_at is nullable and is the whole revocation mechanism: authentication filters on
-- it, so a revoked key stops working on the next request rather than whenever a cache
-- expires. Nothing records when a key was last used, deliberately -- that would be a write
-- on the authentication path from the one role that must never learn to write outside the
-- ledger.
--
-- No ON DELETE was chosen for the foreign key, which leaves NO ACTION: a tenant with
-- credentials cannot be deleted out from under them. Nothing here deletes a tenant, and if
-- that ever changes, refusing is the answer that does not quietly disconnect a live key
-- from the accounts it speaks for.
create table api_keys (
  id          uuid primary key,
  tenant_id   uuid not null references tenants (id),
  name        text not null,
  secret_hash bytea not null,
  scope       api_key_scope not null,
  created_at  timestamptz not null default now(),
  revoked_at  timestamptz
);

-- No index on tenant_id. Every read of this table is by primary key, because the key id
-- travels inside the token the caller presents. An index for a query nobody makes costs
-- writes and buys nothing.

-- The tenant a freshly migrated database starts with. It is here rather than in an entry
-- point for two reasons, and neither is convenience.
--
-- The first is that the next migration gives accounts a tenant and has to backfill the
-- rows already there, and a migration cannot depend on somebody having run a command
-- first. That is exactly how the currencies table came to sit empty behind a foreign key.
--
-- The second is that the documented start-up has to work as written. `migrate` then
-- `issue-key` leaves nothing to invent; making the operator name a tenant before the
-- ledger will speak to anyone is a step that would exist only because this row was
-- missing.
--
-- The id is written out rather than generated, and written to be legible as what it is. A
-- random UUIDv7 sentinel would be indistinguishable from real data six months from now.
-- This is the honest cost of the row: a constant living in a versioned file.
insert into tenants (id, name) values
  ('00000000-0000-0000-0000-000000000001', 'default')
on conflict (id) do nothing;

-- SELECT on api_keys, and that is the entire grant.
--
-- What is absent is the point again. The application authenticates, so it reads
-- credentials; it does not issue them, revoke them or record anything about them, so it
-- holds no INSERT, UPDATE or DELETE here. An application role in the wrong hands reads a
-- table of digests it cannot reverse, and cannot mint itself a second way in.
--
-- Nothing is granted on tenants. Authentication reads tenant_id off the key row, and
-- inserting an account against the tenant foreign key does not require SELECT on the
-- referenced table -- PostgreSQL runs referential checks as the constraint's owner rather
-- than as the writer. A grant here would be a privilege handed out for a query that does
-- not exist.
grant select on api_keys to ledger_app;

-- ledger_auditor gets nothing on either table, and this is a comment rather than a REVOKE
-- for the reason 0002 has no REVOKE in it: a role that was never granted anything already
-- has nothing. The auditor reads the ledger. Digests of live credentials are not the
-- ledger, and the role that exists in order to be harmless is the last one that should see
-- them.
