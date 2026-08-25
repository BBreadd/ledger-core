// ledger-store.ts -- the PostgreSQL implementation of the LedgerStore port. Depends on: ports, pg.

import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import type {
  AccountBalance,
  LedgerStore,
  LockedAccount,
  NewAccount,
  StoredEntry,
  StoredTransaction,
  TransactionToInsert,
  UnitOfWork,
} from "../../application/ports.ts";
import { AlreadyReversedError, DuplicateIdempotencyKeyError } from "../../application/ports.ts";
import type { AccountType } from "../../domain/account.ts";
import type { Currency, Direction } from "../../domain/money.ts";

// node-postgres hands back int8 as a string, because not every int8 fits in a JS number.
// Money lives in int8 columns, so the safe conversion is to bigint, never to number.
// Registered once, at module load, before any pool exists.
pg.types.setTypeParser(pg.types.builtins.INT8, BigInt);

/**
 * The type annotations on a query result are a promise this file makes, not something the
 * compiler can check: whatever the wire produces is whatever arrives. So every number that
 * matters is converted here, at the boundary, instead of being trusted.
 *
 * This is not hypothetical. sum(bigint) returns numeric in PostgreSQL, not bigint, so the
 * int8 parser above does not apply to it and a balance arrives as a string. JavaScript
 * then answers `"38000" + (-1000000n)` with the string "38000-1000000" instead of throwing,
 * and comparing that against 0n is quietly false -- an overdraft check that passes
 * everything. The aggregates below are cast to ::bigint for that reason.
 */
function toBigInt(value: unknown, column: string): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    return BigInt(value);
  }
  throw new TypeError(`column ${column} arrived as ${typeof value}, cannot read it as an integer`);
}

/** Same reasoning as toBigInt, for the one column that is small enough to be a number. */
function toSmallInt(value: unknown, column: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(parsed)) {
    throw new TypeError(`column ${column} arrived as ${typeof value}, cannot read it as an integer`);
  }
  return parsed;
}

const UNIQUE_VIOLATION = "23505";
// Named in migration 0008 rather than generated, and read back here. Scoping idempotency
// per tenant meant replacing the unique index, and a replacement PostgreSQL named for
// itself would have stopped matching this string silently: the duplicate would no longer
// translate into a replay, and an honest retry would come back a 500.
const IDEMPOTENCY_KEY_CONSTRAINT = "transactions_idempotency_key_per_tenant";
const REVERSES_ONCE_CONSTRAINT = "transactions_reverses_once";

const TRANSACTION_COLUMNS = `id, seq, idempotency_key, request_hash, description,
                             occurred_at, recorded_at, reverses_transaction_id`;
const ENTRY_COLUMNS = "id, account_id, currency, direction, amount";

export function createLedgerStore(databaseUrl: string): LedgerStore {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  return {
    async inTransaction<T>(work: (uow: UnitOfWork) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const result = await work(unitOfWork(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw translate(error);
      } finally {
        client.release();
      }
    },

    async ensureCurrency(code: string, minorUnit: number): Promise<void> {
      await pool.query(
        "insert into currencies (code, minor_unit) values ($1, $2) on conflict (code) do nothing",
        [code, minorUnit],
      );
    },

    async createAccount(account: NewAccount): Promise<void> {
      await pool.query(
        `insert into accounts (id, tenant_id, name, type, currency, allows_negative)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          account.id,
          account.tenantId,
          account.name,
          account.type,
          account.currency,
          account.allowsNegative,
        ],
      );
    },

    async findAccountBalance(accountId: string, tenantId: string): Promise<AccountBalance | null> {
      // Driven from accounts with a LEFT JOIN rather than aggregating entries, so that an
      // account with no entries yet comes back as zero while an id that was never created
      // comes back as nothing. Aggregating entries alone answers both with zero.
      const result = await pool.query<AccountBalanceRow>(
        `select a.id,
                a.type,
                a.currency,
                coalesce(sum(e.signed_amount), 0)::bigint as balance
           from accounts a
           left join entries e on e.account_id = a.id
          where a.id = $1
            and a.tenant_id = $2
          group by a.id, a.type, a.currency`,
        [accountId, tenantId],
      );

      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }

      return {
        id: row.id,
        type: row.type,
        currency: row.currency.trim(),
        balance: toBigInt(row.balance, "balance"),
      };
    },

    findByIdempotencyKey(tenantId: string, key: string): Promise<StoredTransaction | null> {
      return loadTransaction(pool, "idempotency_key", key, tenantId);
    },

    findTransaction(id: string, tenantId: string): Promise<StoredTransaction | null> {
      return loadTransaction(pool, "id", id, tenantId);
    },

    async findCurrency(code: string): Promise<Currency | null> {
      const result = await pool.query<CurrencyRow>(
        "select code, minor_unit from currencies where code = $1",
        [code],
      );

      const row = result.rows[0];
      if (row === undefined) {
        return null;
      }

      return { code: row.code.trim(), minorUnit: toSmallInt(row.minor_unit, "minor_unit") };
    },

    async ping(): Promise<void> {
      await pool.query("select 1");
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

function unitOfWork(client: PoolClient): UnitOfWork {
  return {
    async lockAccounts(
      accountIds: readonly string[],
      tenantId: string,
    ): Promise<readonly LockedAccount[]> {
      // Locked one at a time, in sorted id order, on purpose. A single
      // `where id = any($1) order by id for update` reads as if it locked in order, but
      // the order of lock acquisition is whatever the plan happens to produce -- a bitmap
      // scan locks in physical order and sorts afterwards. Deadlock freedom here is meant
      // to hold by construction, not by whichever plan the planner picked today.
      // The tenant is part of the predicate here and not only of the read below, so an
      // account belonging to somebody else is never locked at all. Locking first and
      // filtering afterwards would hold a stranger's row for the length of the
      // transaction, which is a way to interfere with a tenant whose data you cannot see.
      const sorted = [...accountIds].sort();
      for (const id of sorted) {
        await client.query("select 1 from accounts where id = $1 and tenant_id = $2 for update", [
          id,
          tenantId,
        ]);
      }

      const result = await client.query<AccountRow>(
        `select a.id,
                a.type,
                a.currency,
                a.allows_negative,
                coalesce(sum(e.signed_amount), 0)::bigint as balance
           from accounts a
           left join entries e on e.account_id = a.id
          where a.id = any($1::uuid[])
            and a.tenant_id = $2
          group by a.id, a.type, a.currency, a.allows_negative`,
        [sorted, tenantId],
      );

      return result.rows.map((row) => ({
        id: row.id,
        type: row.type,
        currency: row.currency.trim(),
        allowsNegative: row.allows_negative,
        balance: toBigInt(row.balance, "balance"),
      }));
    },

    findTransaction(id: string, tenantId: string): Promise<StoredTransaction | null> {
      return loadTransaction(client, "id", id, tenantId);
    },

    async insertTransaction(transaction: TransactionToInsert): Promise<StoredTransaction> {
      const header = await client.query<{ seq: unknown; recorded_at: Date }>(
        `insert into transactions
           (id, tenant_id, idempotency_key, request_hash, description, occurred_at,
            reverses_transaction_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning seq, recorded_at`,
        [
          transaction.id,
          transaction.tenantId,
          transaction.idempotencyKey,
          transaction.requestHash,
          transaction.description,
          transaction.occurredAt,
          transaction.reversesTransactionId,
        ],
      );

      // The tenant is written onto every leg rather than joined for. It is what the two
      // composite foreign keys check against, and the value used is the transaction's own,
      // so an account belonging to anybody else fails the key instead of quietly recording
      // a leg under the wrong owner.
      await client.query(
        `insert into entries
           (id, transaction_id, tenant_id, account_id, currency, direction, amount)
         select *
           from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::uuid[], $5::bpchar[],
                       $6::entry_direction[], $7::bigint[])`,
        [
          transaction.entries.map((entry) => entry.id),
          transaction.entries.map(() => transaction.id),
          transaction.entries.map(() => transaction.tenantId),
          transaction.entries.map((entry) => entry.accountId),
          transaction.entries.map((entry) => entry.currency),
          transaction.entries.map((entry) => entry.direction),
          transaction.entries.map((entry) => entry.amount.toString()),
        ],
      );

      const row = header.rows[0];
      if (row === undefined) {
        throw new Error("insert into transactions returned no row");
      }

      return {
        id: transaction.id,
        seq: toBigInt(row.seq, "seq"),
        idempotencyKey: transaction.idempotencyKey,
        requestHash: transaction.requestHash,
        description: transaction.description,
        occurredAt: transaction.occurredAt,
        recordedAt: row.recorded_at,
        reversesTransactionId: transaction.reversesTransactionId,
        entries: transaction.entries.map(
          (entry): StoredEntry => ({
            id: entry.id,
            accountId: entry.accountId,
            currency: entry.currency,
            direction: entry.direction,
            amount: entry.amount,
          }),
        ),
      };
    },
  };
}

// `unknown` on every integer column is deliberate: it forces the conversion through
// toBigInt instead of letting an annotation stand in for a check.
type AccountRow = {
  id: string;
  type: AccountType;
  currency: string;
  allows_negative: boolean;
  balance: unknown;
};

type CurrencyRow = QueryResultRow & {
  code: string;
  minor_unit: unknown;
};

type AccountBalanceRow = QueryResultRow & {
  id: string;
  type: AccountType;
  currency: string;
  balance: unknown;
};

type TransactionRow = QueryResultRow & {
  id: string;
  seq: unknown;
  idempotency_key: string;
  request_hash: string;
  description: string;
  occurred_at: Date;
  recorded_at: Date;
  reverses_transaction_id: string | null;
};

type EntryRow = QueryResultRow & {
  id: string;
  account_id: string;
  currency: string;
  direction: Direction;
  amount: unknown;
};

type Queryable = {
  query<R extends QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<pg.QueryResult<R>>;
};

/** Rebuilds a transaction and its entries from whatever connection is handed in. */
async function loadTransaction(
  queryable: Queryable,
  where: string,
  value: string,
  tenantId: string,
): Promise<StoredTransaction | null> {
  // The tenant is in the where clause and not in a check afterwards. A transaction that
  // belongs to somebody else does not come back, so every caller already has the branch it
  // needs -- the one it wrote for a transaction that does not exist -- and cannot answer
  // the two differently.
  const header = await queryable.query<TransactionRow>(
    `select ${TRANSACTION_COLUMNS} from transactions where ${where} = $1 and tenant_id = $2`,
    [value, tenantId],
  );

  const row = header.rows[0];
  if (row === undefined) {
    return null;
  }

  const entries = await queryable.query<EntryRow>(
    `select ${ENTRY_COLUMNS} from entries where transaction_id = $1 order by id`,
    [row.id],
  );

  return {
    id: row.id,
    seq: toBigInt(row.seq, "seq"),
    idempotencyKey: row.idempotency_key,
    requestHash: row.request_hash,
    description: row.description,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
    reversesTransactionId: row.reverses_transaction_id,
    entries: entries.rows.map((entry) => ({
      id: entry.id,
      accountId: entry.account_id,
      currency: entry.currency.trim(),
      direction: entry.direction,
      amount: toBigInt(entry.amount, "amount"),
    })),
  };
}

/**
 * Turns the database errors that are part of the contract into domain-level errors, and
 * leaves every other error alone so real bugs stay loud.
 *
 * Matched on the constraint name rather than on SQLSTATE, because two unique indexes on
 * transactions both report 23505 and they mean entirely different things: "this request
 * already happened" and "this transaction was already reversed". Reading the code alone
 * would answer a retry with the wrong story.
 */
function translate(error: unknown): unknown {
  if (
    !(error instanceof Error) ||
    !("code" in error) ||
    error.code !== UNIQUE_VIOLATION ||
    !("constraint" in error)
  ) {
    return error;
  }

  const detail = "detail" in error ? String(error.detail) : "unknown";

  if (error.constraint === IDEMPOTENCY_KEY_CONSTRAINT) {
    return new DuplicateIdempotencyKeyError(detail);
  }
  if (error.constraint === REVERSES_ONCE_CONSTRAINT) {
    return new AlreadyReversedError(detail);
  }
  return error;
}
