// ledger-store.ts -- the PostgreSQL implementation of the LedgerStore port. Depends on: ports, pg.

import pg from "pg";
import type { PoolClient, QueryResultRow } from "pg";
import type {
  LedgerStore,
  LockedAccount,
  NewAccount,
  StoredEntry,
  StoredTransaction,
  TransactionToInsert,
  UnitOfWork,
} from "../../application/ports.ts";
import { DuplicateIdempotencyKeyError } from "../../application/ports.ts";
import type { AccountType } from "../../domain/account.ts";
import type { Direction } from "../../domain/money.ts";

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

const UNIQUE_VIOLATION = "23505";
const IDEMPOTENCY_KEY_CONSTRAINT = "transactions_idempotency_key_key";

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
        `insert into accounts (id, name, type, currency, allows_negative)
         values ($1, $2, $3, $4, $5)`,
        [account.id, account.name, account.type, account.currency, account.allowsNegative],
      );
    },

    async balanceOf(accountId: string): Promise<bigint> {
      const result = await pool.query<{ balance: unknown }>(
        `select coalesce(sum(signed_amount), 0)::bigint as balance
           from entries
          where account_id = $1`,
        [accountId],
      );
      const row = result.rows[0];
      return row === undefined ? 0n : toBigInt(row.balance, "balance");
    },

    findByIdempotencyKey(key: string): Promise<StoredTransaction | null> {
      return loadByIdempotencyKey(pool, key);
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

function unitOfWork(client: PoolClient): UnitOfWork {
  return {
    async lockAccounts(accountIds: readonly string[]): Promise<readonly LockedAccount[]> {
      // Locked one at a time, in sorted id order, on purpose. A single
      // `where id = any($1) order by id for update` reads as if it locked in order, but
      // the order of lock acquisition is whatever the plan happens to produce -- a bitmap
      // scan locks in physical order and sorts afterwards. Deadlock freedom here is meant
      // to hold by construction, not by whichever plan the planner picked today.
      const sorted = [...accountIds].sort();
      for (const id of sorted) {
        await client.query("select 1 from accounts where id = $1 for update", [id]);
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
          group by a.id, a.type, a.currency, a.allows_negative`,
        [sorted],
      );

      return result.rows.map((row) => ({
        id: row.id,
        type: row.type,
        currency: row.currency.trim(),
        allowsNegative: row.allows_negative,
        balance: toBigInt(row.balance, "balance"),
      }));
    },

    async insertTransaction(transaction: TransactionToInsert): Promise<StoredTransaction> {
      const header = await client.query<{ seq: unknown; recorded_at: Date }>(
        `insert into transactions
           (id, idempotency_key, request_hash, description, occurred_at)
         values ($1, $2, $3, $4, $5)
         returning seq, recorded_at`,
        [
          transaction.id,
          transaction.idempotencyKey,
          transaction.requestHash,
          transaction.description,
          transaction.occurredAt,
        ],
      );

      await client.query(
        `insert into entries (id, transaction_id, account_id, currency, direction, amount)
         select *
           from unnest($1::uuid[], $2::uuid[], $3::uuid[], $4::bpchar[],
                       $5::entry_direction[], $6::bigint[])`,
        [
          transaction.entries.map((entry) => entry.id),
          transaction.entries.map(() => transaction.id),
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
        entries: transaction.entries.map(
          (entry): StoredEntry => ({
            id: entry.id,
            accountId: entry.accountId,
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

type TransactionRow = QueryResultRow & {
  id: string;
  seq: unknown;
  idempotency_key: string;
  request_hash: string;
  description: string;
  occurred_at: Date;
  recorded_at: Date;
};

type EntryRow = QueryResultRow & {
  id: string;
  account_id: string;
  direction: Direction;
  amount: unknown;
};

async function loadByIdempotencyKey(
  queryable: pg.Pool,
  key: string,
): Promise<StoredTransaction | null> {
  const header = await queryable.query<TransactionRow>(
    `select id, seq, idempotency_key, request_hash, description, occurred_at, recorded_at
       from transactions
      where idempotency_key = $1`,
    [key],
  );

  const row = header.rows[0];
  if (row === undefined) {
    return null;
  }

  const entries = await queryable.query<EntryRow>(
    "select id, account_id, direction, amount from entries where transaction_id = $1 order by id",
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
    entries: entries.rows.map((entry) => ({
      id: entry.id,
      accountId: entry.account_id,
      direction: entry.direction,
      amount: toBigInt(entry.amount, "amount"),
    })),
  };
}

/**
 * Turns the one database error that is part of the contract into a domain-level error,
 * and leaves every other error alone so real bugs stay loud.
 */
function translate(error: unknown): unknown {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === UNIQUE_VIOLATION &&
    "constraint" in error &&
    error.constraint === IDEMPOTENCY_KEY_CONSTRAINT
  ) {
    return new DuplicateIdempotencyKeyError("detail" in error ? String(error.detail) : "unknown");
  }
  return error;
}
