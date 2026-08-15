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
| Postings are never updated or deleted | Corrections are reversing entries, not edits |
| A balance is never a stored, authoritative value | It is `sum(signed_amount)`; there is no balance column |
| A retry with the same idempotency key posts once | `unique (idempotency_key)` |
| The same key with a different payload is an error, not a replay | A stored fingerprint of the request |
| An entry cannot be in a currency its account does not hold | Composite foreign key `(account_id, currency)` |
| Amounts are strictly positive | `check (amount > 0)` |
| An account marked non-negative never goes below zero | Checked inside a row lock |

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

## Reconciliation

```bash
npm run reconcile
```

Six checks, read-only, against the ledger as it stands. Exit `0` if it reconciles, `2` if it
does not, `1` if the job itself could not run -- "the books are wrong" and "the auditor is
broken" being different incidents.

Every check runs inside one `repeatable read read only` transaction, so all of them observe
a single snapshot. Under the default isolation level each statement takes its own, and a
transaction committing partway through leaves the checks describing two different ledgers.
Snapshot isolation does not prevent write skew, which is why the write path uses row locks
instead; this job never writes, so the anomaly it cannot prevent is not one it can cause.

Two of the checks are worth singling out:

- **Per currency.** A transaction with a 100 USD debit and a 100 JPY credit sums to zero in
  raw minor units and passes as balanced. Comparing money that was never comparable is the
  error a single total cannot see.
- **Accounts below zero.** The only rule here with no database backstop at all: nothing but
  a check inside the write lock enforces it, so nothing but this would notice a write that
  went around it.

Proving the job detects anything means creating corruption the schema exists to prevent.
The tests write it inside a transaction and audit it on the same connection without ever
committing: the constraint triggers are deferred, so they fire at `COMMIT` and a
transaction that never commits never fires them.

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
npm run migrate
npm run demo
npm run reconcile
```

`npm run demo` walks the whole path against the real database: it opens accounts, funds
one, transfers between two, replays the transfer as a retry would send it, then shows the
same key with a different payload, an unbalanced transaction and an overdraft all being
refused.

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
src/domain/       entities and the pure double-entry rules. No I/O.
src/application/  use cases and the ports they depend on
src/adapters/     PostgreSQL, id generation
src/entry/        composition roots: migrate, demo, reconcile
tests/unit/       pure rules
tests/integration/what the database refuses, the concurrency proofs, the audit
```

Dependencies point inwards: `src/domain` does not know PostgreSQL exists.

## Not built yet

An HTTP surface, multi-currency transactions with FX, and balance snapshots for accounts
too large to sum. Balance snapshots are deliberately absent: caching a balance before
measuring that summing is too slow would be optimising a problem nobody has shown exists.

One known gap, stated precisely because the obvious guess about it is wrong: appending a
*balanced* pair of entries to an already-committed transaction is refused by nothing in the
schema, and **the reconciliation job cannot catch it either**. The result balances by every
check the job makes -- per transaction, per currency, globally -- because it genuinely does
balance. It is a history that was rewritten, not a sum that stopped adding up, and no
amount of summing distinguishes the two. Closing it means taking away the right to insert
into a transaction that already exists, which is a question about roles and permissions
rather than about arithmetic.

## License

MIT
