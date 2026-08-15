-- Reversing entries: the only way to correct a posting, now that editing one is impossible.

-- A self-referencing nullable column rather than a table of its own, because a zero-or-one
-- relationship back to the same row is a column. It also makes "is this a correction, and
-- of what" a question a query can answer instead of a convention someone has to honour.
alter table transactions
  add column reverses_transaction_id uuid references transactions (id);

-- Once, and only once. NULLs are distinct in a unique index, so every ordinary transaction
-- still coexists happily. The index is the check: asking whether a transaction is already
-- reversed and then inserting is the same race that idempotency_key exists to avoid.
create unique index transactions_reverses_once on transactions (reverses_transaction_id);

alter table transactions
  add constraint transactions_no_self_reversal
    check (reverses_transaction_id is null or reverses_transaction_id <> id);

-- The flip lives in the database as well as in the domain because the trigger below and
-- the audit query both need it, and two hand-written CASE expressions are two places for
-- one rule to drift apart.
create function flip_direction(direction entry_direction) returns entry_direction
language sql immutable strict as $$
  select case when direction = 'debit' then 'credit'::entry_direction
              else 'debit'::entry_direction end;
$$;

-- No GRANT EXECUTE follows, on purpose: PostgreSQL grants EXECUTE on functions to PUBLIC
-- by default, so writing one would be a statement that changes nothing while reading like
-- a decision. Same reasoning as the absent REVOKEs in 0002.

-- Everything else about a reversal spans at least two rows, so it lives in a trigger
-- rather than a CHECK -- the same reason the balance invariants do in 0001.
create function assert_reversal_mirrors_original() returns trigger
language plpgsql as $$
declare
  original_is_reversal boolean;
  differences          integer;
begin
  if new.reverses_transaction_id is null then
    return null;
  end if;

  select t.reverses_transaction_id is not null
    into original_is_reversal
    from transactions t
   where t.id = new.reverses_transaction_id;

  -- Reversing a reversal of A is a roundabout way of posting A again, and saying it that
  -- way leaves a chain whose net effect depends on counting its length. Posting A again,
  -- with its own idempotency key, says the same thing and reads as what it is.
  if original_is_reversal then
    raise exception 'transaction % reverses %, which is itself a reversal',
      new.id, new.reverses_transaction_id
      using errcode = 'check_violation';
  end if;

  -- An exact mirror: same accounts, same currency, same amounts, every direction flipped.
  -- Compared with EXCEPT ALL in both directions so that multiplicity counts. A reversal
  -- carrying only one leg of an identical pair is not a mirror, and a plain set difference
  -- would call it one.
  select count(*)
    into differences
    from (
      (select account_id, currency, flip_direction(direction) as direction, amount
         from entries where transaction_id = new.id
       except all
       select account_id, currency, direction, amount
         from entries where transaction_id = new.reverses_transaction_id)
      union all
      (select account_id, currency, direction, amount
         from entries where transaction_id = new.reverses_transaction_id
       except all
       select account_id, currency, flip_direction(direction) as direction, amount
         from entries where transaction_id = new.id)
    ) as mismatched;

  if differences > 0 then
    raise exception 'transaction % is not an exact mirror of the transaction % it reverses',
      new.id, new.reverses_transaction_id
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

create constraint trigger transactions_reversal_mirror_check
  after insert on transactions
  deferrable initially deferred
  for each row
  execute function assert_reversal_mirrors_original();
