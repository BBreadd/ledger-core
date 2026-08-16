// reconciliation-source.ts -- the audit queries. Depends on: ports, domain, pg.

import pg from "pg";
import type { ClientBase } from "pg";
import type { ReconciliationReader, ReconciliationSource } from "../../application/ports.ts";
import type { Anomaly, CheckFindings, LedgerSize } from "../../domain/reconciliation.ts";

/**
 * Opens a connection whose reads all see one snapshot, and hands the auditor to `work`.
 *
 * The isolation level is the whole point. Under READ COMMITTED each statement takes its
 * own snapshot, so a transaction committing between the second check and the fifth makes
 * the report describe two different ledgers, and its counts stop being comparable to each
 * other. REPEATABLE READ takes the snapshot once and every check reads the same book.
 *
 * Snapshot isolation famously does not prevent write skew, which is why the write path
 * uses row locks instead of leaning on it. That warning is about writers. This never
 * writes, so the anomaly it fails to prevent is not one this can commit -- the same
 * feature is the wrong tool there and the right one here.
 *
 * READ ONLY is not decoration either: it makes the intent something PostgreSQL enforces
 * rather than something a comment claims.
 *
 * Discarded -- SERIALIZABLE READ ONLY DEFERRABLE: the textbook instrument for long
 * reports, since it waits for a snapshot in which no serialization anomaly is possible,
 * then never aborts and never blocks writers. It buys nothing over REPEATABLE READ when
 * the job only reads already-committed rows, and it can wait indefinitely for that
 * snapshot. Noted here in case this ever grows into something that needs it.
 */
export function createReconciliationReader(databaseUrl: string): ReconciliationReader {
  const pool = new pg.Pool({ connectionString: databaseUrl });

  return {
    async read<T>(work: (source: ReconciliationSource) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("begin transaction isolation level repeatable read, read only");
        const result = await work(createReconciliationSource(client));
        await client.query("commit");
        return result;
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}

/**
 * Built over a caller-supplied connection rather than owning one, so the auditor can be
 * pointed at a transaction that is already open. Tests need that: the only way to check
 * that this detects corruption is to create some, the schema makes corruption impossible
 * to commit, and the way out is to write it and audit it on the same connection without
 * ever committing.
 */
export function createReconciliationSource(client: ClientBase): ReconciliationSource {
  return {
    async size(): Promise<LedgerSize> {
      const result = await client.query<Record<string, unknown>>(
        `select (select count(*) from accounts)     as accounts,
                (select count(*) from transactions) as transactions,
                (select count(*) from entries)      as entries`,
      );
      const row = result.rows[0] ?? {};
      return {
        accounts: toBigInt(row["accounts"], "accounts"),
        transactions: toBigInt(row["transactions"], "transactions"),
        entries: toBigInt(row["entries"], "entries"),
      };
    },

    async globalNet(): Promise<bigint> {
      const result = await client.query<{ net: unknown }>(
        "select coalesce(sum(signed_amount), 0)::bigint as net from entries",
      );
      return toBigInt(result.rows[0]?.net, "net");
    },

    /**
     * Driven from transactions outward, not from entries inward. A GROUP BY over entries
     * cannot produce a group for a transaction that has none, and "a transaction with no
     * entries" is an anomaly made of absent rows. The left join is what makes those rows
     * visible -- to this check as a zero net, and to the next one as a leg count of zero.
     */
    unbalancedTransactions(limit: number): Promise<CheckFindings> {
      return findings(
        client,
        `select t.id::text                                 as subject,
                coalesce(sum(e.signed_amount), 0)::bigint  as net,
                count(*) over ()                           as anomaly_total
           from transactions t
           left join entries e on e.transaction_id = t.id
          group by t.id
         having coalesce(sum(e.signed_amount), 0) <> 0
          order by t.id
          limit $1`,
        [limit],
        (row) => `net=${toBigInt(row["net"], "net")}`,
      );
    },

    malformedTransactions(limit: number): Promise<CheckFindings> {
      return findings(
        client,
        `select t.id::text                       as subject,
                count(e.id)                      as leg_count,
                count(distinct e.account_id)     as account_count,
                count(*) over ()                 as anomaly_total
           from transactions t
           left join entries e on e.transaction_id = t.id
          group by t.id
         having count(e.id) < 2 or count(distinct e.account_id) < 2
          order by t.id
          limit $1`,
        [limit],
        (row) =>
          `legs=${toBigInt(row["leg_count"], "leg_count")} ` +
          `accounts=${toBigInt(row["account_count"], "account_count")}`,
      );
    },

    unbalancedCurrencies(limit: number): Promise<CheckFindings> {
      return findings(
        client,
        `select btrim(e.currency)          as subject,
                sum(e.signed_amount)::bigint as net,
                count(*) over ()             as anomaly_total
           from entries e
          group by e.currency
         having sum(e.signed_amount) <> 0
          order by e.currency
          limit $1`,
        [limit],
        (row) => `net=${toBigInt(row["net"], "net")}`,
      );
    },

    multiCurrencyTransactions(limit: number): Promise<CheckFindings> {
      return findings(
        client,
        `select t.id::text                                                       as subject,
                string_agg(distinct btrim(e.currency), ',' order by btrim(e.currency))
                                                                                 as currencies,
                count(*) over ()                                                 as anomaly_total
           from transactions t
           join entries e on e.transaction_id = t.id
          group by t.id
         having count(distinct e.currency) > 1
          order by t.id
          limit $1`,
        [limit],
        (row) => `currencies=${String(row["currencies"])}`,
      );
    },

    /**
     * The predicate is normal_balance(), deliberately identical to the one the write path
     * applies inside its lock. An auditor that judges by a different rule than the enforcer
     * reports failures nobody can cause and misses the ones they can, which is worse than
     * either rule alone -- so this query and accountsLeftOverdrawn change together or not
     * at all.
     *
     * Both the reported balance and the predicate are in normal-balance terms, because a
     * finding that says balance=-50000 about an account holding 50000 is a lie even when
     * the row it points at is the right one.
     */
    overdrawnAccounts(limit: number): Promise<CheckFindings> {
      return findings(
        client,
        `select a.id::text as subject,
                a.type::text as type,
                normal_balance(a.type, coalesce(sum(e.signed_amount), 0)::bigint) as balance,
                count(*) over () as anomaly_total
           from accounts a
           left join entries e on e.account_id = a.id
          where not a.allows_negative
          group by a.id, a.type
         having normal_balance(a.type, coalesce(sum(e.signed_amount), 0)::bigint) < 0
          order by a.id
          limit $1`,
        [limit],
        (row) =>
          `type=${String(row["type"])} balance=${toBigInt(row["balance"], "balance")}`,
      );
    },

    /**
     * Two ways a correction can be a lie, asked as one question because the answer a
     * person wants is "can I trust the corrections".
     *
     * The mirror comparison uses EXCEPT ALL in both directions, which counts multiplicity:
     * a reversal that brings back one leg of an identical pair is not a mirror, and a
     * plain set difference would say it was. flip_direction() is the same function the
     * write-time trigger uses, so the audit cannot disagree with the gate about what the
     * opposite of a debit is.
     */
    brokenReversals(limit: number): Promise<CheckFindings> {
      return findings(
        client,
        `with reversals as (
           select r.id, r.reverses_transaction_id as original_id,
                  o.reverses_transaction_id is not null as original_is_reversal
             from transactions r
             join transactions o on o.id = r.reverses_transaction_id
            where r.reverses_transaction_id is not null
         ),
         mismatches as (
           select v.id,
                  (select count(*) from (
                     (select account_id, currency, flip_direction(direction) as direction, amount
                        from entries where transaction_id = v.id
                      except all
                      select account_id, currency, direction, amount
                        from entries where transaction_id = v.original_id)
                     union all
                     (select account_id, currency, direction, amount
                        from entries where transaction_id = v.original_id
                      except all
                      select account_id, currency, flip_direction(direction) as direction, amount
                        from entries where transaction_id = v.id)
                   ) as d) as differing_legs,
                  v.original_is_reversal,
                  v.original_id
             from reversals v
         )
         select id::text          as subject,
                original_id::text as original,
                differing_legs,
                original_is_reversal,
                count(*) over ()  as anomaly_total
           from mismatches
          where differing_legs > 0 or original_is_reversal
          order by id
          limit $1`,
        [limit],
        (row) =>
          row["original_is_reversal"] === true
            ? `reverses=${String(row["original"])} problem=original_is_itself_a_reversal`
            : `reverses=${String(row["original"])} ` +
              `problem=not_a_mirror legs=${toBigInt(row["differing_legs"], "differing_legs")}`,
      );
    },
  };
}

/**
 * Runs one anomaly query and splits its result into "how many" and "which ones".
 *
 * The total rides along on every row as `count(*) over ()`, which is evaluated after
 * HAVING and before LIMIT, so it counts every anomaly while the rows themselves stop at
 * the sample size. Asking a second query for the count would let the two disagree
 * whenever the ledger changed in between.
 */
async function findings(
  client: ClientBase,
  sql: string,
  values: readonly unknown[],
  describe: (row: Record<string, unknown>) => string,
): Promise<CheckFindings> {
  const result = await client.query<Record<string, unknown>>(sql, [...values]);
  const first = result.rows[0];
  if (first === undefined) {
    return { total: 0n, samples: [] };
  }

  const samples: readonly Anomaly[] = result.rows.map((row) => ({
    subject: String(row["subject"]),
    detail: describe(row),
  }));

  return { total: toBigInt(first["anomaly_total"], "anomaly_total"), samples };
}

/**
 * Same boundary conversion the write adapter makes, and for the same reason: a type
 * annotation on a driver row is a promise, not a check. count() and sum() both come back
 * as values this file did not choose the representation of.
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
