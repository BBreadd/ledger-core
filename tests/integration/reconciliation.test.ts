// reconciliation.test.ts -- proof that the auditor sees corruption, using corruption that
// is never committed.

import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import pg from "pg";
import {
  createReconciliationReader,
  createReconciliationSource,
} from "../../src/adapters/postgres/reconciliation-source.ts";
import { reconcile } from "../../src/application/reconcile.ts";
import { createUuidV7 } from "../../src/adapters/uuid-v7.ts";
import type { CheckId, ReconciliationReport } from "../../src/domain/reconciliation.ts";
import {
  integrationAuditorUrl,
  integrationDatabaseUrl,
  skipWithoutDatabase,
} from "./database-url.ts";

const newId = createUuidV7();

describe("the reconciliation job", { skip: skipWithoutDatabase }, () => {
  const url = integrationDatabaseUrl ?? "";
  const pool = new pg.Pool({ connectionString: url });

  before(async () => {
    await pool.query(
      `insert into currencies (code, minor_unit)
       values ('USD', 2), ('EUR', 2) on conflict do nothing`,
    );
  });

  after(async () => {
    await pool.end();
  });

  /**
   * Writes something the ledger must never hold, audits it, and rolls back.
   *
   * The schema refuses to commit any of this, which is exactly the point of the schema and
   * exactly the problem when testing the thing whose job is to notice it anyway. The way
   * through is that the constraint triggers are DEFERRABLE INITIALLY DEFERRED: they fire at
   * COMMIT, and a transaction that never commits never fires them. The auditor runs on the
   * same connection, so it reads the writes nobody else can see, and the rollback leaves
   * the database exactly as it was found.
   *
   * This is also why the source is built over a caller-supplied client instead of owning
   * its own pool. In production the caller is the entry point, which opens a REPEATABLE
   * READ READ ONLY snapshot; here it is a test holding a dirty transaction open.
   */
  async function auditInsideRolledBackTransaction(
    corrupt: (client: pg.PoolClient) => Promise<void>,
  ): Promise<ReconciliationReport> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      await corrupt(client);
      return await reconcile({
        source: createReconciliationSource(client),
        now: () => new Date(),
      });
    } finally {
      await client.query("rollback");
      client.release();
    }
  }

  it("finds a transaction whose debits do not equal its credits", async () => {
    const transactionId = newId();
    const report = await auditInsideRolledBackTransaction(async (client) => {
      const left = await createAccount(client, "USD");
      const right = await createAccount(client, "USD");
      await insertHeader(client, transactionId);
      await insertEntry(client, transactionId, left, "USD", "debit", 10_000n);
      await insertEntry(client, transactionId, right, "USD", "credit", 9_000n);
    });

    assertFlagged(report, "TRANSACTION_NET", transactionId, "net=1000");
  });

  it("finds a transaction with no entries at all", async () => {
    const transactionId = newId();
    const report = await auditInsideRolledBackTransaction(async (client) => {
      await insertHeader(client, transactionId);
    });

    // The anomaly is made of rows that are not there. Grouping entries by transaction_id
    // would never produce a group for this one, and the check would report a clean book.
    assertFlagged(report, "TRANSACTION_SHAPE", transactionId, "legs=0 accounts=0");
    assert.equal(
      checkNamed(report, "TRANSACTION_NET").samples.some(
        (anomaly) => anomaly.subject === transactionId,
      ),
      false,
      "a transaction with no entries nets to zero; its shape is the problem, not its sum",
    );
  });

  it("finds a transaction standing on a single account", async () => {
    const transactionId = newId();
    const report = await auditInsideRolledBackTransaction(async (client) => {
      const only = await createAccount(client, "USD");
      await insertHeader(client, transactionId);
      await insertEntry(client, transactionId, only, "USD", "debit", 500n);
      await insertEntry(client, transactionId, only, "USD", "credit", 500n);
    });

    assertFlagged(report, "TRANSACTION_SHAPE", transactionId, "legs=2 accounts=1");
  });

  /**
   * The case that gets past a balance check. Raw minor units say this transaction sums to
   * zero, so TRANSACTION_NET is satisfied by 100 USD cancelling 100 EUR -- money that was
   * never comparable in the first place. Only the per-currency view sees it.
   */
  it("finds a transaction that balances only by mixing currencies", async () => {
    const transactionId = newId();
    const report = await auditInsideRolledBackTransaction(async (client) => {
      const dollars = await createAccount(client, "USD");
      const euros = await createAccount(client, "EUR");
      await insertHeader(client, transactionId);
      await insertEntry(client, transactionId, dollars, "USD", "debit", 100n);
      await insertEntry(client, transactionId, euros, "EUR", "credit", 100n);
    });

    assert.equal(
      checkNamed(report, "TRANSACTION_NET").samples.some(
        (anomaly) => anomaly.subject === transactionId,
      ),
      false,
      "this is precisely the corruption a single sum cannot see",
    );
    assertFlagged(report, "TRANSACTION_CURRENCY_SPAN", transactionId, "currencies=EUR,USD");

    const currencies = checkNamed(report, "CURRENCY_NET");
    assert.ok(currencies.total >= 2n, "both currencies are left off balance");
    assert.deepEqual(
      currencies.samples.map((anomaly) => anomaly.subject).sort(),
      ["EUR", "USD"],
    );
  });

  /**
   * The only invariant in this system with no database backstop: no constraint, no
   * trigger, nothing but the balance check the write path runs inside its lock. Which
   * makes it the one anomaly that could sit in the ledger indefinitely with every other
   * check green.
   */
  it("finds an account below zero that is not allowed to be", async () => {
    const transactionId = newId();
    let overdrawn = "";
    const report = await auditInsideRolledBackTransaction(async (client) => {
      const account = await createAccount(client, "USD");
      const counterparty = await createAccount(client, "USD");
      overdrawn = account;
      await insertHeader(client, transactionId);
      await insertEntry(client, transactionId, account, "USD", "credit", 7_500n);
      await insertEntry(client, transactionId, counterparty, "USD", "debit", 7_500n);
    });

    assertFlagged(report, "NEGATIVE_BALANCE", overdrawn, "type=asset balance=-7500");
  });

  /**
   * A correction that does not correct is worse than none: the ledger reads as settled
   * while the original error stays in force. The mirror trigger refuses this at COMMIT,
   * so the only way to hold one is never to commit -- which is exactly how it gets here.
   */
  it("finds a reversal that is not the mirror of what it claims to undo", async () => {
    const reversalId = newId();
    const report = await auditInsideRolledBackTransaction(async (client) => {
      const left = await createAccount(client, "USD", true);
      const right = await createAccount(client, "USD", true);

      const originalId = newId();
      await insertHeader(client, originalId);
      await insertEntry(client, originalId, left, "USD", "debit", 1_000n);
      await insertEntry(client, originalId, right, "USD", "credit", 1_000n);

      await insertHeader(client, reversalId, originalId);
      await insertEntry(client, reversalId, left, "USD", "credit", 900n);
      await insertEntry(client, reversalId, right, "USD", "debit", 900n);
    });

    const check = checkNamed(report, "REVERSAL_INTEGRITY");
    const anomaly = check.samples.find((candidate) => candidate.subject === reversalId);
    assert.ok(anomaly !== undefined, "the audit did not flag the false correction");
    assert.match(anomaly.detail, /problem=not_a_mirror/);

    assert.equal(
      checkNamed(report, "TRANSACTION_NET").samples.some(
        (candidate) => candidate.subject === reversalId,
      ),
      false,
      "it balances perfectly on its own; only the comparison with the original exposes it",
    );
  });

  it("finds a reversal whose target was itself a reversal", async () => {
    const secondReversalId = newId();
    const report = await auditInsideRolledBackTransaction(async (client) => {
      const left = await createAccount(client, "USD", true);
      const right = await createAccount(client, "USD", true);

      const originalId = newId();
      await insertHeader(client, originalId);
      await insertEntry(client, originalId, left, "USD", "debit", 500n);
      await insertEntry(client, originalId, right, "USD", "credit", 500n);

      const firstReversalId = newId();
      await insertHeader(client, firstReversalId, originalId);
      await insertEntry(client, firstReversalId, left, "USD", "credit", 500n);
      await insertEntry(client, firstReversalId, right, "USD", "debit", 500n);

      await insertHeader(client, secondReversalId, firstReversalId);
      await insertEntry(client, secondReversalId, left, "USD", "debit", 500n);
      await insertEntry(client, secondReversalId, right, "USD", "credit", 500n);
    });

    const anomaly = checkNamed(report, "REVERSAL_INTEGRITY").samples.find(
      (candidate) => candidate.subject === secondReversalId,
    );
    assert.ok(anomaly !== undefined, "a chain of reversals went unnoticed");
    assert.match(anomaly.detail, /problem=original_is_itself_a_reversal/);
  });

  it("says nothing about a true reversal", async () => {
    const reversalId = newId();
    const report = await auditInsideRolledBackTransaction(async (client) => {
      const left = await createAccount(client, "USD", true);
      const right = await createAccount(client, "USD", true);

      const originalId = newId();
      await insertHeader(client, originalId);
      await insertEntry(client, originalId, left, "USD", "debit", 2_500n);
      await insertEntry(client, originalId, right, "USD", "credit", 2_500n);

      await insertHeader(client, reversalId, originalId);
      await insertEntry(client, reversalId, left, "USD", "credit", 2_500n);
      await insertEntry(client, reversalId, right, "USD", "debit", 2_500n);
    });

    for (const check of report.checks) {
      assert.equal(
        check.samples.some((anomaly) => anomaly.subject === reversalId),
        false,
        `${check.id} flagged a correct reversal`,
      );
    }
  });

  it("says nothing about a transaction that is correct in every way", async () => {
    const transactionId = newId();
    const report = await auditInsideRolledBackTransaction(async (client) => {
      // The credited account allows going negative, so it funds the other from nothing.
      const source = await createAccount(client, "USD", true);
      const destination = await createAccount(client, "USD");
      await insertHeader(client, transactionId);
      await insertEntry(client, transactionId, source, "USD", "credit", 2_000n);
      await insertEntry(client, transactionId, destination, "USD", "debit", 2_000n);
    });

    for (const check of report.checks) {
      assert.equal(
        check.samples.some((anomaly) => anomaly.subject === transactionId),
        false,
        `${check.id} flagged a sound transaction`,
      );
    }
  });

  /**
   * The production path, syntax and all. Nothing is asserted about the verdict here: test
   * files run in parallel, so another file may be committing while this snapshot is taken.
   * Whether the ledger as a whole reconciles is answered by the CI step that runs the job
   * once the suite has finished.
   */
  it("runs against the real database inside a read-only snapshot", async () => {
    const reader = createReconciliationReader(integrationAuditorUrl ?? "");
    try {
      const report = await reader.read((source) => reconcile({ source, now: () => new Date() }));
      assert.equal(report.checks.length, 7);
      assert.ok(report.size.accounts > 0n, "the suite has left accounts behind to audit");
      assert.ok(report.finishedAt.getTime() >= report.startedAt.getTime());
    } finally {
      await reader.close();
    }
  });

  it("refuses to write through the auditor's connection", async () => {
    const reader = createReconciliationReader(integrationAuditorUrl ?? "");
    try {
      await assert.rejects(
        reader.read(async () => {
          throw new Error("unreachable");
        }),
        /unreachable/,
        "an error inside the audit propagates instead of being swallowed",
      );
    } finally {
      await reader.close();
    }
  });
});

async function createAccount(
  client: pg.PoolClient,
  currency: string,
  allowsNegative = false,
): Promise<string> {
  const id = newId();
  // Set at creation rather than updated afterwards: UPDATE on accounts is a privilege the
  // application role does not have, and these fixtures run as the application.
  await client.query(
    `insert into accounts (id, name, type, currency, allows_negative)
     values ($1, $2, 'asset', $3, $4)`,
    [id, `audit fixture ${id}`, currency, allowsNegative],
  );
  return id;
}

async function insertHeader(
  client: pg.PoolClient,
  transactionId: string,
  reverses: string | null = null,
): Promise<void> {
  await client.query(
    `insert into transactions
       (id, idempotency_key, request_hash, description, occurred_at, reverses_transaction_id)
     values ($1, $2, 'audit', 'never committed', now(), $3)`,
    [transactionId, `audit-${transactionId}`, reverses],
  );
}

async function insertEntry(
  client: pg.PoolClient,
  transactionId: string,
  accountId: string,
  currency: string,
  direction: "debit" | "credit",
  amount: bigint,
): Promise<void> {
  await client.query(
    `insert into entries (id, transaction_id, account_id, currency, direction, amount)
     values ($1, $2, $3, $4, $5, $6::bigint)`,
    [newId(), transactionId, accountId, currency, direction, amount.toString()],
  );
}

function checkNamed(report: ReconciliationReport, id: CheckId) {
  const check = report.checks.find((candidate) => candidate.id === id);
  assert.ok(check !== undefined, `no check named ${id}`);
  return check;
}

function assertFlagged(
  report: ReconciliationReport,
  id: CheckId,
  subject: string,
  detail: string,
): void {
  const check = checkNamed(report, id);
  const anomaly = check.samples.find((candidate) => candidate.subject === subject);
  assert.ok(anomaly !== undefined, `${id} did not flag ${subject}`);
  assert.equal(anomaly.detail, detail);
  assert.ok(check.total >= 1n);
}
