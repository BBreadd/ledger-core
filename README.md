# ledger-core

A double-entry ledger engine in TypeScript on PostgreSQL. Postings are immutable, balances
are always derived, a retried request cannot post twice, and every rule that matters is
enforced by the database as well as by the code.

Built as a study of correctness under concurrency, so the interesting part is not that it
works but that there are tests showing what breaks when the safeguards are removed.

## What it guarantees

| Invariant | Enforced by |
|---|---|
| Every transaction's debits equal its credits | Types, a deferred constraint trigger, and the reconciliation job |
| A transaction has at least two entries across at least two accounts | Deferred constraint trigger |
| Postings are never updated or deleted | The application role holds no `UPDATE` or `DELETE`. Corrections are reversing entries |
| A transaction's entries are fixed when it is written | A trigger refuses any entry whose transaction was committed by an earlier database transaction |
| A reversal is the exact mirror of what it undoes | Built from the original, checked by a deferred trigger, audited afterwards |
| A transaction is reversed at most once | `unique (reverses_transaction_id)` |
| A reversal is not itself reversible | A deferred trigger; post the original again instead |
| A balance is never a stored, authoritative value | It is `sum(signed_amount)`; there is no balance column |
| A retry with the same idempotency key posts once | `unique (idempotency_key)` |
| The same key with a different payload is an error, not a replay | A stored fingerprint of the request |
| An entry cannot be in a currency its account does not hold | Composite foreign key `(account_id, currency)` |
| Amounts are strictly positive | `check (amount > 0)` |
| An account marked non-negative never goes below zero, read in its own direction | Checked inside a row lock, and audited afterwards with the same rule |

## Ownership

An account belongs to exactly one tenant, and a transaction never leaves one. Neither of
those is a rule the application applies — both are things the schema cannot record.

`entries` carries `tenant_id`, denormalised from `accounts`, for the same single reason it
already carries `currency`: it makes a composite foreign key possible. With
`(account_id, tenant_id)` pointing at `accounts` and `(transaction_id, tenant_id)` pointing
at `transactions`, an entry can only exist where its account and its transaction agree on
whose it is. A transaction spanning two tenants is not refused. It cannot be written, by
anyone, through any path.

What that costs, said plainly rather than discovered later: an account can never change
tenant, and value cannot move between two tenants in a single transaction. The first is
right for a ledger — an account with history does not change hands, a new one is opened.
The second is a real limit: a platform moving money between its customers does it through a
clearing account on each side, which is two transactions and a design of its own. If that
day comes, these foreign keys are what has to be taken apart, and that is the honest price
of them being this strong.

**Idempotency keys are unique per tenant, not globally**, and that is the other half of
ownership rather than housekeeping. Under one global index a second tenant reusing a key
receives the first tenant's answer — the retry path hands back whatever holds the key, and
when the payload does not match it still reports that the key is taken. Callers name keys
after their own orders, so this is the ordinary collision, not a remote one.

## The concurrency problem

Two transfers withdrawing from the same account read the same balance, each concludes it
has room, and together they overdraw it. Neither overwrites the other -- each inserts its
own row -- so the invariant that breaks lives in rows that neither of them touched. That is
**write skew**, and the trap is that PostgreSQL's `REPEATABLE READ` is snapshot isolation,
which does not prevent it.

This engine takes an explicit row lock on every account a transaction touches, acquired in
sorted id order so that two transfers over the same pair of accounts cannot deadlock. The
account row is used as an exclusion token; it is never modified.

`tests/integration/concurrency.test.ts` contains both halves: a test that reproduces the
overdraft with the lock removed, and a test that shows the real path refusing the second
withdrawal.

## Corrections

A posting cannot be edited, so it is corrected by posting its exact mirror: every leg back
on the same account for the same amount in the opposite direction, linked to the original
through `reverses_transaction_id`. The pair nets to zero on every account it touched, and
the mistake stays in the record instead of disappearing from it. A corrected ledger has two
transactions in it, not one rewritten transaction, and that is the difference between a
record and a draft.

Three things about it are worth stating outright:

**A reversal takes no lock.** The posting path locks every account it touches because it
reads a balance and then decides. A reversal reads no balance, so there is no
read-then-write to race, and contention that does not exist does not need preventing.

**A reversal is allowed to leave an account short.** By the time an error is found the money
has often been spent, and refusing the correction because the account cannot afford it would
freeze the mistake in place: the ledger would stay wrong precisely because fixing it did not
fit. The shortfall this leaves is real, and the audit reports it rather than exempting it —
what the reversal changes is that the cause is on the record, not that the money is back.

**A reversal cannot be reversed.** Undoing the undo of A is a roundabout way of posting A
again, and it leaves a chain whose meaning depends on counting its length. Posting A again,
with its own idempotency key, says the same thing and reads as what it is.

## Roles

Three connection strings, because one would mean one set of privileges:

| Variable | Role | May |
|---|---|---|
| `DATABASE_ADMIN_URL` | the owner | everything; runs migrations and provisioning |
| `DATABASE_URL` | the application | `SELECT`, `INSERT` |
| `DATABASE_AUDITOR_URL` | the reconciliation job | `SELECT` |

There is no `REVOKE` anywhere in the migrations, and that is the mechanism rather than an
oversight: a new role holds no privileges at all and `PUBLIC` holds none on these tables,
so immutability comes from never granting `UPDATE` or `DELETE`. Revoking a privilege nobody
was given would read as protection while doing nothing.

`ledger_app` and `ledger_auditor` are `NOLOGIN` groups created by the migration, which
settles what each role may do and never who may become one. `provision` creates the
identities that connect and adds them to a group, so a database that has only been migrated
has no new way into it and no credential ever lives in a migration file.

API credentials are split the same way one level up, for the same reason: a migration
creates the tenants and settles that the application may only read `api_keys`, while
`issue-key` mints the secrets. The application authenticates callers and cannot mint one --
it holds `SELECT` on `api_keys` and nothing else, and nothing at all on `tenants`.

None of this means anything from a superuser connection, since a superuser bypasses
privilege checks entirely -- so `tests/integration/permissions.test.ts` asserts that
`DATABASE_URL` is not one before asserting anything else.

## Reconciliation

```bash
npm run reconcile
```

Seven checks, read-only, against the ledger as it stands. Exit `0` if it reconciles, `2` if
it does not, `1` if the job itself could not run -- "the books are wrong" and "the auditor is
broken" being different incidents.

Every check runs inside one `repeatable read read only` transaction, so all of them observe
a single snapshot. Under the default isolation level each statement takes its own, and a
transaction committing partway through leaves the checks describing two different ledgers.
Snapshot isolation does not prevent write skew, which is why the write path uses row locks
instead; this job never writes, so the anomaly it cannot prevent is not one it can cause.

Three of the checks are worth singling out:

- **Per currency.** A transaction with a 100 USD debit and a 100 JPY credit sums to zero in
  raw minor units and passes as balanced. Comparing money that was never comparable is the
  error a single total cannot see.
- **Accounts below zero.** The only rule here with no database backstop at all: nothing but
  a check inside the write lock enforces it, so nothing but this would notice a write that
  went around it. It judges the normal balance, not the raw stored sum, using the same
  `normal_balance()` the write path applies — stored sums are debit-positive, so a revenue
  account doing exactly what revenue does carries a negative one, and an auditor reading it
  by raw sign would flag every healthy income account in the ledger.
- **Reversal integrity.** A reversal that is not the exact mirror of its original balances
  perfectly on its own, so every other check passes it. Only the comparison against what it
  claims to undo exposes it — and a correction that does not correct is worse than none,
  because the ledger then reads as settled with the error still in force.

Proving the job detects anything means creating corruption the schema exists to prevent.
The tests write it inside a transaction and audit it on the same connection without ever
committing: the constraint triggers are deferred, so they fire at `COMMIT` and a
transaction that never commits never fires them.

## HTTP API

```bash
npm run issue-key -- my-client   # prints a token, once
npm run serve                    # PORT comes from the environment
```

Six routes, one content type, no framework. `node:http` with a router and a parser written
here, and no new runtime dependency — at five or six routes a framework buys routing, and
routing is a list of at most four path segments compared for equality. The parts it would
also have brought are written out instead, and they are the parts worth reading: a byte
ceiling on the request body, explicit request and header timeouts, and an exhaustive
mapping from every rejection the core can produce to a status code.

| Route | |
|---|---|
| `POST /v1/accounts` | opens an account |
| `POST /v1/transactions` | posts a transaction |
| `GET /v1/transactions/{id}` | reads one back |
| `POST /v1/transactions/{id}/reversal` | corrects one |
| `GET /v1/accounts/{id}/balance` | the account's normal balance |
| `GET /health` | answers only while the database does |

Reversal is a sub-resource rather than `POST /v1/reversals` with the id in the body, so what
is being undone is stated by the URL, and a second attempt is a conflict over that resource
rather than a disagreement about a payload. `/v1` is in the path because a URL is a key to
stored data in the same way an id is: version it late and clients break.

**Every route except `/health` requires `Authorization: Bearer <token>`.** A token is
`lgr_<keyId>.<secret>`: the key id travels in front so that verifying one is a single lookup
by primary key rather than a scan hashing the presented secret against every row, and the
prefix is what makes a leaked secret findable by a fixed string. Only a SHA-256 digest of
the secret is stored — a plain one, and deliberately, because slow password hashes exist to
make guessing expensive for secrets a human chose and this one is 32 bytes of cryptographic
randomness that no dictionary reaches.

Credentials are rows, not an environment variable, and the three things that buys are the
reason: every request log line names the caller, a key carries a scope, and `revoke-key`
stops one working on the next request without restarting anything.

| Scope | May call |
|---|---|
| `read` | the `GET` routes |
| `write` | every route |

`write` covers `read` rather than excluding it, because the `Location` header of a caller's
own `201` points at a route that requires `read`. Too narrow a scope is answered with `403`
and a `detail` saying which scope was held and which was needed — a caller learns only what
its own credential is, which it already knew.

**Every account belongs to a tenant, and the credential decides which.** The owner of a new
account is taken from the token and never from the body — the parser refuses any field it
was not told about, so a request naming `tenantId` is answered with `400` rather than
quietly ignored.

Reaching for another tenant's data is answered exactly as reaching for data that does not
exist: `404` for an account or a transaction, `UNKNOWN_ACCOUNT` for one named inside a
posting. That is not a decision taken in each handler — the tenant is part of the `where`
clause, so nothing comes back and every caller lands in the branch it already had for a
missing row. The distinction is not hidden, it is never made, which is what keeps it from
leaking. The real reason is in the log next to the request id.

This is deliberately not a `403`. A `403` would confirm that the id names something, and
"that account exists but is not yours" is an answer about somebody else's ledger.

**Writes require an `Idempotency-Key` header**, quoted or bare — the IETF draft asks for a
Structured Header, the industry sends it plain, and rejecting half the clients over
punctuation would serve nobody. The draft's 409 for "a request with this key is still in
flight" is not implemented, because it cannot happen here: two identical POSTs at once are
serialised by the unique index, the second blocking on it until the first commits and then
losing the insert with `23505`, which is a replay. There is no retry loop and no
check-then-insert anywhere on that path.

`occurredAt` is required in the body, and the reason is easy to get wrong. The request
fingerprint includes it, so defaulting it to the current time would give a client's retry a
different timestamp, a different hash, and therefore a rejection for reusing its key —
breaking idempotency for exactly the caller relying on it.

**Amounts travel as strings of minor units** (`"50000"`), with `currency` and `minorUnit`
beside them. A JSON number loses precision above 2^53, a decimal string puts rounding back
into runtime, and a bigint cannot be serialised at all — `JSON.stringify` throws on one.
Balances are presented as the account's normal balance, so a revenue account holding 500
reads as `"50000"` and not as the debit-positive `-50000` the column stores.

Errors are [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem documents, and the
core's rejection codes are part of the public contract:

```json
{
  "type": "urn:ledger-core:error:insufficient-funds",
  "title": "Insufficient funds",
  "status": 422,
  "detail": "account 0198... would go to -4000 (balance 46000, type asset)",
  "code": "INSUFFICIENT_FUNDS"
}
```

A client told `{"error": "internal"}` when it was short of funds cannot tell "fix the
request" from "retry later", so refusals travel with their own code while anything
unexpected collapses to a 500 carrying a request id, with the stack going to the log. The
table that maps code to status is a `Record` over the union of every rejection code in the
core, which means adding one without deciding what it means over HTTP fails `npm run
typecheck` rather than quietly falling through to a 500.

`UNKNOWN_ACCOUNT` is a 422 and not a 404 on purpose: `POST /v1/transactions` does exist, and
what is missing is an account named inside the body. `UNKNOWN_TRANSACTION` on the reversal
route is a 404, because there the id is the URL.

One thing about running it in production: **start it as `node src/entry/serve.ts`, not
through `npm run serve`.** npm does not forward `SIGTERM` to the process it spawned, so the
graceful shutdown never runs and in-flight requests are cut off. Measured: through npm the
process dies on the signal; directly, it logs `shutdown.started`, drains, and exits 0.

## Design notes

**Money is `bigint` in minor units.** Floating point is excluded for the obvious reason.
Decimals are excluded because they can represent amounts that cannot exist, such as
0.00001 USD, and push rounding into runtime. `currencies.minor_unit` carries the scale, so
JPY with no decimal places is not a special case.

**Entries store a direction and a positive amount**, not a signed one. A credit of -50 is
not a thing, and the schema should not be able to say it. A generated column
`signed_amount` provides the single arithmetic convention: a balance is a sum, and a
balanced transaction sums to zero.

**Order comes from a sequence, never a timestamp.** `now()` returns the transaction's start
time, so two concurrent writers can commit in the opposite order to their `recorded_at`.

**Transactions carry both `occurred_at` and `recorded_at`** -- when it happened and when the
system learned of it -- so a late arrival is recorded today with yesterday's date instead of
rewriting history.

**Identifiers are UUIDv7 generated in the application**, not by the database, so the whole
transaction can be assembled in memory before anything is written and the generator can be
seeded in tests.

## Requirements

- Node.js 22.18 or newer. There is no build step: Node runs the TypeScript directly by
  stripping types, and `tsc` is used only to typecheck.
- Docker, for PostgreSQL 18.

## Running it

```bash
docker compose up -d
cp .env.example .env
npm install
npm run migrate      # schema, the roles' privileges, currencies, the default tenant
npm run provision    # lets the roles the connection strings name actually log in
npm run issue-key -- my-client    # mints an API credential and prints it once
npm run demo
npm run reconcile
npm run serve        # the HTTP surface, on PORT
```

`provision` runs after `migrate` and not before: the groups its logins join have to exist
first. Both are idempotent, so running either again does nothing.

`issue-key` runs after `migrate` too, and needs no arguments beyond a name: the migration
seeds a default tenant so there is nothing to invent between having a database and having a
credential. It takes `--scope read` for a credential that may only read, and prints the
token exactly once — only the digest is stored, so a lost token is replaced rather than
recovered. `npm run revoke-key -- <key-id>` ends one; the id is printed at issue time and
appears on every request line the server logs.

`migrate` also seeds the currencies the ledger knows: USD, EUR and GBP with two minor units,
JPY with none, KWD with three. `accounts.currency` is a foreign key into that table, so a
database with no rows in it refuses every account and therefore every transaction. The set is
deliberately not all two-decimal — seeding only those would restate the "everything is cents"
assumption `minor_unit` exists to break. Another currency is another migration.

`npm run demo` walks the whole path against the real database: it opens accounts, funds
one, transfers between two, replays the transfer as a retry would send it, then shows the
same key with a different payload, an unbalanced transaction and an overdraft all being
refused, and finally reverses the transfer and watches a second reversal be turned away.

## Testing

```bash
npm test          # unit tests always; integration tests when DATABASE_URL is set
npm run typecheck
```

Unit tests cover the pure domain rules and need nothing running. Integration tests run
against a real PostgreSQL instance and skip themselves when `DATABASE_URL` is absent -- and
refuse to skip when `CI` is set, because a green run that proved nothing is worse than a red
one. CI runs both against a `postgres:18` service container using these same migration
files, then reconciles the ledger the suite left behind.

## Layout

```
migrations/       versioned SQL; an applied migration is never edited
src/domain/       entities, ownership vocabulary, and the pure double-entry rules. No I/O.
src/application/  use cases and the ports they depend on
src/adapters/     PostgreSQL, the HTTP surface, id generation
src/entry/        composition roots: migrate, provision, issue-key, demo, reconcile, serve
tests/unit/       pure rules
tests/integration/what the database refuses, the concurrency proofs, the audit
```

Dependencies point inwards: `src/domain` does not know PostgreSQL exists.

## Not built yet

Multi-currency transactions with FX, and balance snapshots for accounts too large to sum.
Balance snapshots are deliberately absent: caching a balance before measuring that summing is
too slow would be optimising a problem nobody has shown exists.

Creating an account is not idempotent. The core has no key for it — `POST /v1/accounts`
takes no `Idempotency-Key`, and a retried request opens a second account. Making it
idempotent needs the same unique-key mechanism transactions have, which is a migration, and
requiring a header that the route would then ignore would be worse than saying this.

Appending a *balanced* pair of entries to an already-committed transaction used to be
refused by nothing, and it is worth keeping the reason in view: **the reconciliation job
cannot catch that one**. The result balances by every check the job makes -- per
transaction, per currency, globally -- because it genuinely does balance. It is a history
that was rewritten, not a sum that stopped adding up, and no amount of summing
distinguishes the two.

Privileges cannot express it either. The application must hold `INSERT` on `entries` in
order to write at all, and a `GRANT` has no way of saying "only into the transaction you
are creating right now". So it is a trigger, and the question it asks is `xmin`: if the
header was written by some earlier transaction rather than by this one, the insert is an
append and it is refused. `tests/integration/invariants.test.ts` makes the attempt the way
the adapter writes a posting, and removing the trigger turns that test red.

What no trigger can defend against is the database owner, who can drop it -- or, with
`session_replication_role = 'replica'`, step around every trigger at once. That is not a
hole in this mechanism so much as the shape of the trust boundary: the owner runs the
migrations, so nothing inside the schema can be authoritative against them.

## License

MIT
