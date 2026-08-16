-- Normal balance: what an account holds, read in the direction that account grows.

-- Stored sums are debit-positive everywhere in this schema, which is what lets
-- sum(signed_amount) = 0 mean "this transaction balances". The cost is that a liability,
-- equity or revenue account read at face value reports the negative of what it holds, so a
-- rule written against the raw sum says the opposite of what it means for three of the five
-- account types. `allows_negative = false` on a revenue account used to read as "may never
-- be credited on net", which nobody would ever want to say.
--
-- The rule lives here as well as in the domain for the same reason flip_direction does: the
-- audit query needs it server-side and the write path needs it in Node, and two hand-written
-- CASE expressions are two places for one rule to drift apart. The duplication is tolerable
-- because the two halves check each other -- the auditor judges with this version what was
-- written with the TypeScript one -- so a divergence surfaces as a NEGATIVE_BALANCE finding
-- rather than as silence.
create function normal_balance(type account_type, signed_sum bigint) returns bigint
language sql immutable strict as $$
  select case when type in ('asset', 'expense') then signed_sum else -signed_sum end;
$$;

comment on column accounts.allows_negative is
  'When false, normal_balance(type, sum(signed_amount)) may never go below zero. Stated in '
  'normal-balance terms, not raw sign, so it means the same thing for all five account '
  'types. Reversals are exempt: a correction that cannot be afforded still has to be made.';
