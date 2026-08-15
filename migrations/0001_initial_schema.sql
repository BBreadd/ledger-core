-- Core double-entry schema: immutable postings, derived balances, idempotent writes.

create type account_type as enum ('asset', 'liability', 'equity', 'revenue', 'expense');
create type entry_direction as enum ('debit', 'credit');

-- Minor unit per ISO 4217: USD has 2, JPY has 0, KWD has 3. Assuming "everything is
-- cents" is a bug waiting for the first non-decimal currency.
create table currencies (
  code       char(3) primary key,
  minor_unit smallint not null check (minor_unit between 0 and 4)
);

create table accounts (
  id              uuid primary key,
  name            text not null check (length(btrim(name)) > 0),
  type            account_type not null,
  currency        char(3) not null references currencies (code),
  allows_negative boolean not null default false,
  created_at      timestamptz not null default now(),

  -- Redundant as a key, but required as the target of the composite foreign key on
  -- entries. That key is what makes "an entry cannot be in a currency other than its
  -- own account's" structurally impossible rather than merely validated.
  unique (id, currency)
);

create table transactions (
  id              uuid primary key,

  -- The ordering authority. Never order the ledger by a timestamp: now() returns the
  -- transaction start time, so two concurrent writers can commit in the opposite order
  -- to their recorded_at.
  seq             bigint generated always as identity,

  -- A retry that arrives twice must not post twice. The unique index is the mechanism:
  -- the second insert loses with SQLSTATE 23505 and the caller replays the original.
  -- Checking for existence first would reintroduce the very race this prevents.
  idempotency_key text not null unique,

  -- Same key with a different payload is a client bug, not a retry. Storing the
  -- fingerprint is what lets us tell those two apart.
  request_hash    text not null,

  description     text not null,
  occurred_at     timestamptz not null,
  recorded_at     timestamptz not null default now(),

  unique (seq)
);

create table entries (
  id             uuid primary key,
  transaction_id uuid not null references transactions (id),
  account_id     uuid not null,
  currency       char(3) not null,
  direction      entry_direction not null,
  amount         bigint not null check (amount > 0),

  -- One convention for arithmetic (debit positive), while the rows keep the domain's
  -- vocabulary. A balance is sum(signed_amount); a balanced transaction sums to zero.
  signed_amount  bigint generated always as
                   (case when direction = 'debit' then amount else -amount end) stored,

  foreign key (account_id, currency) references accounts (id, currency)
);

create index entries_account_id_idx on entries (account_id);
create index entries_transaction_id_idx on entries (transaction_id);

-- Invariants that span more than one row, so a CHECK constraint cannot express them.
-- Enforced by a deferred constraint trigger, which runs at COMMIT once every entry of
-- the transaction is present.
create function assert_transaction_is_well_formed() returns trigger
language plpgsql as $$
declare
  leg_count      integer;
  account_count  integer;
  currency_count integer;
  net            bigint;
begin
  select count(*),
         count(distinct account_id),
         count(distinct currency),
         coalesce(sum(signed_amount), 0)
    into leg_count, account_count, currency_count, net
    from entries
   where transaction_id = new.id;

  if leg_count < 2 then
    raise exception 'transaction % has % entries; double-entry requires at least two',
      new.id, leg_count
      using errcode = 'check_violation';
  end if;

  if account_count < 2 then
    raise exception 'transaction % touches only % distinct account(s)',
      new.id, account_count
      using errcode = 'check_violation';
  end if;

  if currency_count <> 1 then
    raise exception 'transaction % spans % currencies; single-currency transactions only',
      new.id, currency_count
      using errcode = 'check_violation';
  end if;

  if net <> 0 then
    raise exception 'transaction % does not balance: debits minus credits = %',
      new.id, net
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

-- Placed on transactions rather than on entries so it runs exactly once per
-- transaction instead of once per leg, and so a transaction inserted with no entries
-- at all is still caught.
create constraint trigger transactions_well_formed_check
  after insert on transactions
  deferrable initially deferred
  for each row
  execute function assert_transaction_is_well_formed();

-- Second line of defence, for entries appended to an already-committed transaction:
-- the trigger above has fired by then and will not fire again.
create function assert_entry_keeps_transaction_balanced() returns trigger
language plpgsql as $$
declare
  net bigint;
begin
  select coalesce(sum(signed_amount), 0) into net
    from entries
   where transaction_id = new.transaction_id;

  if net <> 0 then
    raise exception 'transaction % does not balance: debits minus credits = %',
      new.transaction_id, net
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create constraint trigger entries_balance_check
  after insert on entries
  deferrable initially deferred
  for each row
  execute function assert_entry_keeps_transaction_balanced();
