-- A posting's entries are fixed the moment it is written: nothing may join a transaction
-- that some earlier database transaction already committed.

-- The gap this closes is the price of keeping entries in a table of their own. The header
-- is immutable -- nobody holds UPDATE or DELETE on it -- but "which entries belong to it"
-- is not a property of that row, so appending a child never touches the parent and nothing
-- above notices. The deferred trigger on transactions fires once, at the COMMIT that
-- created the row, and never again. A balanced pair appended afterwards leaves a ledger
-- that reconciles perfectly, because it does reconcile: it is rewritten history rather
-- than arithmetic that stopped adding up, and no amount of summing tells those apart.
--
-- Privileges cannot express this one. The application must hold INSERT on entries in order
-- to write at all, and a GRANT has no way of saying "only into the transaction you are
-- creating right now".
--
-- xmin is the id of the transaction that wrote a row. If the header's xmin is not this
-- transaction's own id, the header was committed by somebody else at some earlier point,
-- and the insert is an append rather than a posting.
create function assert_entries_join_an_open_transaction() returns trigger
language plpgsql as $$
declare committed_transaction uuid;
begin
  -- Joined rather than tested row by row with NOT EXISTS, so that an entry pointing at a
  -- transaction which does not exist at all still produces the foreign key's error instead
  -- of this one.
  select t.id
    into committed_transaction
    from inserted i
    join transactions t on t.id = i.transaction_id
   where t.xmin <> pg_current_xact_id()::xid
   limit 1;

  if committed_transaction is not null then
    raise exception 'transaction % is already committed; entries cannot be appended to it',
      committed_transaction
      using errcode = 'check_violation';
  end if;

  return null;
end;
$$;

-- Per statement rather than per row, for the reason the transactions trigger is where it
-- is: the write path inserts every leg in one statement, so this runs once per posting.
--
-- Not a constraint trigger, and not deferred. A constraint trigger can only be FOR EACH
-- ROW, and deferring would buy nothing anyway: unlike the balance invariants, this verdict
-- does not depend on rows that have yet to arrive, so the error belongs to the statement
-- that caused it.
create trigger entries_no_append_after_commit
  after insert on entries
  referencing new table as inserted
  for each statement
  execute function assert_entries_join_an_open_transaction();

-- entries_balance_check existed for exactly this case and only ever caught half of it: an
-- appended leg that left the sum wrong. With appends refused outright it can no longer fire
-- on anything. Every entry now belongs to a header created in the same transaction, and
-- that header's deferred trigger already checks the net at COMMIT. A second trigger that
-- cannot reach a case of its own is dead weight carrying a comment that has become false.
drop trigger entries_balance_check on entries;
drop function assert_entry_keeps_transaction_balanced();
