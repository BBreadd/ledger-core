// demo.ts -- entry point: walks the ledger end to end against a real database.
// Depends on: config, adapters, application, domain.

import { loadConfig } from "../config.ts";
import { createLedgerStore } from "../adapters/postgres/ledger-store.ts";
import { createUuidV7 } from "../adapters/uuid-v7.ts";
import { postTransaction } from "../application/post-transaction.ts";
import type { PostOutcome } from "../application/post-transaction.ts";
import { reverseTransaction } from "../application/reverse-transaction.ts";
import type { ReverseOutcome } from "../application/reverse-transaction.ts";
import type { LedgerStore } from "../application/ports.ts";
import { normalBalance } from "../domain/account.ts";
import { format } from "../domain/money.ts";
import type { Currency } from "../domain/money.ts";
import type { TransactionDraft } from "../domain/transaction.ts";

const USD: Currency = { code: "USD", minorUnit: 2 };

async function main(): Promise<void> {
  // Composition root: everything is constructed here and passed down. Nothing below
  // reads the environment or reaches for a global.
  const config = loadConfig();
  const store = createLedgerStore(config.databaseUrl);
  const newId = createUuidV7();
  const deps = { store, newId };

  try {
    await store.ensureCurrency(USD.code, USD.minorUnit);

    const run = newId().slice(0, 8);
    const checking = newId();
    const savings = newId();
    const revenue = newId();

    await store.createAccount({
      id: checking, name: `Checking ${run}`, type: "asset",
      currency: "USD", allowsNegative: false,
    });
    await store.createAccount({
      id: savings, name: `Savings ${run}`, type: "asset",
      currency: "USD", allowsNegative: false,
    });
    await store.createAccount({
      id: revenue, name: `Revenue ${run}`, type: "revenue",
      currency: "USD", allowsNegative: true,
    });

    console.log(`run ${run}\n`);

    step("1. Fund checking with 500.00 from revenue");
    await show(
      postTransaction(deps, {
        idempotencyKey: `${run}-funding`,
        description: "Opening deposit",
        occurredAt: new Date(),
        entries: [
          { accountId: checking, direction: "debit", amount: 50_000n },
          { accountId: revenue, direction: "credit", amount: 50_000n },
        ],
      }),
    );

    step("2. Transfer 120.00 from checking to savings");
    let transferId = "";
    const transfer: TransactionDraft = {
      idempotencyKey: `${run}-transfer`,
      description: "Move to savings",
      occurredAt: new Date(),
      entries: [
        { accountId: savings, direction: "debit", amount: 12_000n },
        { accountId: checking, direction: "credit", amount: 12_000n },
      ],
    };
    const transferOutcome = await postTransaction(deps, transfer);
    if (transferOutcome.status === "posted") {
      transferId = transferOutcome.transaction.id;
    }
    await show(Promise.resolve(transferOutcome));

    step("3. The exact same request again, as a retry would send it");
    await show(postTransaction(deps, transfer));

    step("4. Same idempotency key, different amount");
    await show(
      postTransaction(deps, {
        ...transfer,
        entries: [
          { accountId: savings, direction: "debit", amount: 12_100n },
          { accountId: checking, direction: "credit", amount: 12_100n },
        ],
      }),
    );

    step("5. Debits that do not equal credits");
    await show(
      postTransaction(deps, {
        idempotencyKey: `${run}-unbalanced`,
        description: "Should never reach the database",
        occurredAt: new Date(),
        entries: [
          { accountId: savings, direction: "debit", amount: 10_000n },
          { accountId: checking, direction: "credit", amount: 9_000n },
        ],
      }),
    );

    step("6. Withdraw more than checking holds");
    await show(
      postTransaction(deps, {
        idempotencyKey: `${run}-overdraft`,
        description: "Should be refused",
        occurredAt: new Date(),
        entries: [
          { accountId: savings, direction: "debit", amount: 1_000_000n },
          { accountId: checking, direction: "credit", amount: 1_000_000n },
        ],
      }),
    );

    step("7. Undo the transfer -- the only correction there is, since editing is impossible");
    await showReversal(
      reverseTransaction(deps, {
        transactionId: transferId,
        idempotencyKey: `${run}-undo-transfer`,
        description: "Transfer was made in error",
      }),
    );

    step("8. Undo it a second time");
    await showReversal(
      reverseTransaction(deps, {
        transactionId: transferId,
        idempotencyKey: `${run}-undo-again`,
        description: "Should be refused",
      }),
    );

    console.log("\nbalances");
    await printBalance(store, "checking", checking, "asset");
    await printBalance(store, "savings ", savings, "asset");
    await printBalance(store, "revenue ", revenue, "revenue");
  } finally {
    await store.close();
  }
}

function step(title: string): void {
  console.log(`\n${title}`);
}

async function show(outcome: Promise<PostOutcome>): Promise<void> {
  const result = await outcome;
  if (result.status === "rejected") {
    for (const rejection of result.rejections) {
      console.log(`   rejected  ${rejection.code}: ${rejection.message}`);
    }
    return;
  }
  console.log(`   ${result.status}  seq=${result.transaction.seq}  id=${result.transaction.id}`);
}

async function showReversal(outcome: Promise<ReverseOutcome>): Promise<void> {
  const result = await outcome;
  if (result.status === "rejected") {
    for (const rejection of result.rejections) {
      console.log(`   rejected  ${rejection.code}: ${rejection.message}`);
    }
    return;
  }
  console.log(
    `   ${result.status}  seq=${result.transaction.seq}  ` +
      `id=${result.transaction.id}  reverses=${result.transaction.reversesTransactionId}`,
  );
}

async function printBalance(
  store: LedgerStore,
  label: string,
  accountId: string,
  type: "asset" | "revenue",
): Promise<void> {
  const stored = await store.balanceOf(accountId);
  console.log(`   ${label}  ${format(normalBalance(type, stored), USD)}`);
}

await main();
