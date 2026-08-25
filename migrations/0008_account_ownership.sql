-- Accounts belong to a tenant, and a transaction cannot leave one.

-- Until now any valid credential reached every account in the ledger. What follows is not
-- a check bolted on top of that: it is the same trick that made an entry's currency
-- impossible to get wrong, applied a second time.
--
-- entries.currency is denormalised for exactly one reason -- it makes the composite
-- foreign key (account_id, currency) -> accounts (id, currency) possible, and with it an
-- entry in a different currency to its own account is not something the application
-- declines to write, it is something that cannot be written. tenant_id is denormalised
-- onto entries for the same reason and buys the same kind of guarantee: with a composite
-- key to accounts and another to transactions, an entry can only exist where its account
-- and its transaction agree on whose it is. A transaction spanning two tenants is not
-- refused. It is unrepresentable.
--
-- The cost of choosing structure over a check, stated rather than discovered later: an
-- account can never change tenant, and value can never move between two tenants in one
-- transaction. The first is right for a ledger -- an account with history does not change
-- hands, a new one is opened. The second is a real product limit: a platform moving money
-- between its customers does that through a clearing account on each side, which is two
-- transactions and a design of its own. If that day comes, these foreign keys are what has
-- to be taken apart, and that is the honest price of them being this strong.

-- Backfilled to the tenant migration 0007 seeded. Three steps rather than one because the
-- column lands on a table that already has rows: add it nullable, fill it, and only then
-- refuse nulls. A NOT NULL column added to a populated table with no default is rejected
-- outright, and a default would leave the value written into the schema instead of into
-- the rows.
alter table accounts add column tenant_id uuid;
update accounts set tenant_id = '00000000-0000-0000-0000-000000000001' where tenant_id is null;
alter table accounts alter column tenant_id set not null;
alter table accounts add constraint accounts_tenant_fk foreign key (tenant_id) references tenants (id);

-- A unique constraint on (id, tenant_id) so entries can reference the pair. Redundant
-- against the primary key on its own, and required all the same: a foreign key must name
-- a set of columns that is exactly some unique constraint, and no partial match will do.
-- accounts already carries (id, currency) for this same reason.
alter table accounts add constraint accounts_id_tenant_key unique (id, tenant_id);

-- A transaction carries its tenant rather than deriving it from its entries, and that is
-- forced rather than chosen. The idempotency key has to become unique per tenant instead
-- of globally, a unique index can only span columns of its own row, and the derivation
-- lives one table away. Once the column is here it also gives the transaction-level
-- foreign key below something to point at.
--
-- Existing rows take the tenant of the accounts they touch, which after the backfill above
-- is the default tenant for all of them. Written as a lookup rather than as the same
-- constant twice, so that the two columns cannot be filled from different stories.
alter table transactions add column tenant_id uuid;
update transactions t
   set tenant_id = coalesce(
         (select a.tenant_id
            from entries e
            join accounts a on a.id = e.account_id
           where e.transaction_id = t.id
           limit 1),
         '00000000-0000-0000-0000-000000000001')
 where t.tenant_id is null;
alter table transactions alter column tenant_id set not null;
alter table transactions add constraint transactions_tenant_fk foreign key (tenant_id) references tenants (id);
alter table transactions add constraint transactions_id_tenant_key unique (id, tenant_id);

-- And the entries, which is where the two halves meet.
alter table entries add column tenant_id uuid;
update entries e set tenant_id = a.tenant_id from accounts a where a.id = e.account_id;
alter table entries alter column tenant_id set not null;

alter table entries add constraint entries_account_tenant_fk
  foreign key (account_id, tenant_id) references accounts (id, tenant_id);

alter table entries add constraint entries_transaction_tenant_fk
  foreign key (transaction_id, tenant_id) references transactions (id, tenant_id);

-- The plain foreign key on transaction_id is dropped because the composite one above
-- contains it: any row satisfying (transaction_id, tenant_id) satisfies transaction_id.
-- Two constraints checking one of them twice is not a second line of defence, it is a
-- second thing to keep in step. The (account_id, currency) key stays, because it enforces
-- something the tenant key says nothing about.
alter table entries drop constraint entries_transaction_id_fkey;

-- Idempotency becomes a promise made to one tenant rather than to the whole database, and
-- this is the security half of the migration rather than housekeeping.
--
-- With one global unique index, a second tenant reusing a key another had already used
-- receives the first tenant's answer: if it can reproduce the payload the retry path hands
-- back the original transaction in full, and if it cannot, IDEMPOTENCY_KEY_REUSED still
-- tells it the key is taken. Both are somebody else's business. Keys are chosen by callers
-- and tend to look like order-1234, so this is not a remote collision -- it is the obvious
-- one.
--
-- The constraint is named rather than left to PostgreSQL, because the adapter translates
-- 23505 by constraint name and not by SQLSTATE: two unique indexes on this table mean
-- different things and only the name separates "this request already happened" from "this
-- transaction was already reversed". A generated name here would silently stop matching,
-- the duplicate would stop being a replay, and a legitimate retry would become a 500.
alter table transactions drop constraint transactions_idempotency_key_key;
alter table transactions add constraint transactions_idempotency_key_per_tenant
  unique (tenant_id, idempotency_key);

-- No new grant. The privileges on these three tables are table-level, so they already
-- cover a column added afterwards, and the column-level grant on accounts.name is
-- unaffected. Nothing is granted on tenants for the reason 0007 gives: referential checks
-- run as the constraint's owner, so writing a row against a tenant foreign key needs no
-- read of the table it points at.

comment on column entries.tenant_id is
  'Denormalised from accounts so that (account_id, tenant_id) and (transaction_id, tenant_id) can both be foreign keys. Same device as entries.currency: it makes a cross-tenant entry unwritable rather than merely refused.';
