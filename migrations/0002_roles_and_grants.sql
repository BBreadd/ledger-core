-- Roles and privileges. Immutable postings stop being a convention here.

-- There is no REVOKE in this file, and that is the point rather than an omission. A
-- newly created role holds no privileges whatsoever, and PUBLIC holds none on these
-- tables either -- their relacl is null, which is PostgreSQL for "the owner and nobody
-- else". Immutability comes from never granting UPDATE or DELETE, not from taking them
-- back. Revoking a privilege nobody was ever given reads as protection while doing
-- nothing at all, which is worse than leaving it out.

do $$
begin
  -- Roles are cluster-wide, unlike every other object these migrations create, so a
  -- second database in the same cluster will find them already present.
  if not exists (select 1 from pg_roles where rolname = 'ledger_app') then
    create role ledger_app nologin;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'ledger_auditor') then
    create role ledger_auditor nologin;
  end if;
end
$$;

-- NOLOGIN, deliberately. This file settles what each role may do and never who is
-- allowed to become one: granting a password is a separate, explicit step. A database
-- that has only been migrated therefore has no new way into it.

grant usage on schema public to ledger_app, ledger_auditor;

-- The write path reads what it must to validate and appends what it is allowed to
-- append. What is absent matters more than what is here: no UPDATE and no DELETE on
-- entries or transactions, and nothing at all on schema_migrations.
--
-- transactions.seq is GENERATED ALWAYS AS IDENTITY, and an identity column's sequence
-- belongs to the column rather than standing on its own, so INSERT on the table covers
-- it. A `serial` column would have needed its own GRANT USAGE on the sequence.
grant select, insert on currencies, accounts, transactions, entries to ledger_app;

-- Paid reluctantly, and narrowly. The write path takes a row lock on every account a
-- transaction touches, using the row purely as an exclusion token and never modifying
-- it -- but PostgreSQL charges the UPDATE privilege for taking any row lock at all,
-- FOR SHARE and FOR KEY SHARE included. With SELECT alone, `select ... for update`
-- fails with 42501 and the defence against write skew cannot be mounted.
--
-- A column-level grant is the smallest thing that buys it. `name` is the only column
-- here with no invariant resting on it: allows_negative gates the balance floor,
-- currency is half of the composite foreign key that makes an entry's currency
-- structurally correct, type decides which way the balance reads, and id is identity.
-- Granting the table would put all of those within reach of a privilege the
-- application exists in order not to use.
--
-- What this does cost: the application could rename an account, and neither a
-- constraint nor the audit would notice. That is the residual, and it is the smallest
-- one available.
grant update (name) on accounts to ledger_app;

-- The auditor reads and does nothing else. Its port was kept separate from the write
-- store so that this could eventually be true of the connection and not only of the
-- types; this is the line that makes it true.
grant select on currencies, accounts, transactions, entries to ledger_auditor;
