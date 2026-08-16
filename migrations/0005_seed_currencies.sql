-- The currencies the ledger knows. Reference data, seeded with the schema it belongs to.

-- accounts.currency is a foreign key into this table, so a database with no rows here
-- refuses every account and therefore every transaction. Until this migration the table was
-- filled only by ensureCurrency, which demo.ts and the tests call before anything else --
-- so the documented start-up path had never actually been walked without that help, and it
-- did not work.
--
-- These rows are a closed vocabulary from an external standard, not business data. They are
-- the same kind of thing as account_type and entry_direction, whose values ship inside a
-- migration without anyone calling that data; currencies is a table rather than an enum only
-- because ISO 4217 attaches a scale to each code and an enum cannot carry a column.
--
-- The set is the smallest one that exercises the reason minor_unit exists. Seeding nothing
-- but two-decimal currencies would restate the "everything is cents" assumption the column
-- was added to break, so a currency with no minor unit and one with three are here to be
-- used. Values are ISO 4217 Table A.1 as published by SIX, the maintenance agency, edition
-- 2026-01-01.
--
-- ON CONFLICT is not about this migration running twice -- the runner already prevents that.
-- It is for a database that has been used before this file existed, where ensureCurrency or
-- a hand-written insert already put some of these rows in.
insert into currencies (code, minor_unit) values
  ('USD', 2),
  ('EUR', 2),
  ('GBP', 2),
  ('JPY', 0), -- the yen has no subunit: an amount in JPY is a whole yen
  ('KWD', 3) -- the dinar divides into a thousand fils, not a hundred
on conflict (code) do nothing;
