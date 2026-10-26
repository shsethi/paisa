import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exportLedgerSnapshot } from "./ledger_snapshot_export";

test("prefixes numeric security identifiers so Ledger can parse the commodity", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-ledger-export-"));
  const originalPath = "investments/example/holdings.csv";
  const contentSha256 = "a".repeat(64);
  const sourceType = "kuvera_holdings";
  const importId = createHash("sha256")
    .update(`${sourceType}\n${originalPath}\n${contentSha256}`)
    .digest("hex");
  const directory = path.join(root, "extracted", "imports", sourceType, importId);
  mkdirSync(path.join(root, "imports"), { recursive: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      record_type: "import_manifest",
      import_id: importId,
      source_type: sourceType,
      original_path: originalPath,
      content_sha256: contentSha256,
      imported_at: "2026-10-25T00:00:00Z",
      status: "succeeded"
    })
  );
  writeFileSync(
    path.join(directory, "holdings.json"),
    JSON.stringify([
      {
        record_type: "holding",
        source_id: "b".repeat(64),
        current_value: "2500",
        units: "10",
        currency: "INR",
        as_of_date: "2026-10-24",
        security: { name: "Example Fund", identifier: "123456789" },
        source: {
          import_id: importId,
          original_path: originalPath,
          content_sha256: contentSha256,
          record_locator: "row:2"
        }
      },
      {
        record_type: "holding",
        source_id: "c".repeat(64),
        current_value: "1000",
        units: "5",
        currency: "INR",
        as_of_date: "2026-10-24",
        security: { name: "Example Bond", identifier: "BOND1", category: "Dynamic Bond" },
        source: {
          import_id: importId,
          original_path: originalPath,
          content_sha256: contentSha256,
          record_locator: "row:3"
        }
      }
    ])
  );

  const result = exportLedgerSnapshot({ root });
  assert.equal(result.included, 2);
  const output = readFileSync(result.output, "utf8");
  assert.match(output, /Assets:Equity:Investments:Example_Fund_/);
  assert.match(output, /10 "SEC_123456789" @ 250 INR/);
  assert.match(output, /Assets:Debt:Dynamic_Bond:Example_Bond_/);
  assert.doesNotMatch(output, /Assets:Imported/);
});

test("keeps the newer Kuvera folio and removes the older overlapping CAS row", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-ledger-export-"));
  mkdirSync(path.join(root, "imports"), { recursive: true });

  const addImport = (sourceType: string, originalPath: string, rows: unknown[]) => {
    const contentSha256 = sourceType.repeat(64).slice(0, 64);
    const importId = createHash("sha256")
      .update(`${sourceType}\n${originalPath}\n${contentSha256}`)
      .digest("hex");
    const directory = path.join(root, "extracted", "imports", sourceType, importId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        record_type: "import_manifest",
        import_id: importId,
        source_type: sourceType,
        original_path: originalPath,
        content_sha256: contentSha256,
        imported_at: "2026-10-25T00:00:00Z",
        status: "succeeded"
      })
    );
    writeFileSync(
      path.join(directory, "holdings.json"),
      JSON.stringify(
        rows.map((row) => ({
          ...(row as object),
          source: {
            import_id: importId,
            original_path: originalPath,
            content_sha256: contentSha256,
            record_locator: "row:2"
          }
        }))
      )
    );
  };

  addImport("kuvera_holdings", "investments/kuvera/holdings.csv", [
    {
      record_type: "holding",
      source_id: "k".repeat(64),
      current_value: "1000",
      units: "10",
      currency: "INR",
      as_of_date: "2026-10-24",
      security: {
        name: "Canara Robeco Small Cap Growth Direct Plan",
        identifier: "12345678",
        category: "Small Cap Fund"
      }
    }
  ]);
  addImport("nsdl_cas_holdings", "investments/cas/statement.pdf", [
    {
      record_type: "holding",
      source_id: "c".repeat(64),
      current_value: "1100",
      units: "10",
      currency: "INR",
      as_of_date: "2026-09-30",
      security: {
        name: "Canara Robeco Small Cap Fund - Direct",
        identifier: "INF760K01JC6:12345678",
        category: "mutual_fund_folio"
      }
    }
  ]);

  const result = exportLedgerSnapshot({ root });
  assert.equal(result.included, 1);
  const output = readFileSync(result.output, "utf8");
  assert.match(output, /10 "SEC_12345678" @ 100 INR/);
  assert.doesNotMatch(output, /INF760K01JC6/);
});

test("writes liabilities as credits and excludes real assets", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-ledger-export-"));
  const sourceType = "manual_balances",
    originalPath = "manual/assets-liabilities/balances.csv",
    contentSha256 = "d".repeat(64);
  const importId = createHash("sha256")
    .update(`${sourceType}\n${originalPath}\n${contentSha256}`)
    .digest("hex");
  const directory = path.join(root, "extracted", "imports", sourceType, importId);
  mkdirSync(path.join(root, "imports"), { recursive: true });
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      record_type: "import_manifest",
      import_id: importId,
      source_type: sourceType,
      original_path: originalPath,
      content_sha256: contentSha256,
      imported_at: "2026-10-25T00:00:00Z",
      status: "succeeded"
    })
  );
  const source = {
    import_id: importId,
    original_path: originalPath,
    content_sha256: contentSha256,
    record_locator: "row:2"
  };
  writeFileSync(
    path.join(directory, "balances.json"),
    JSON.stringify([
      {
        record_type: "manual_balance",
        source_id: "l".repeat(64),
        balance_type: "liability",
        amount: "2500",
        currency: "INR",
        as_of_date: "2026-08-01",
        category: "loan",
        label: "Home Loan",
        source
      },
      {
        record_type: "manual_balance",
        source_id: "r".repeat(64),
        balance_type: "asset",
        amount: "5000",
        currency: "INR",
        as_of_date: "2026-08-01",
        category: "real_asset",
        label: "House",
        source: { ...source, record_locator: "row:3" }
      }
    ])
  );

  const result = exportLedgerSnapshot({ root });
  assert.equal(result.included, 1);
  const output = readFileSync(result.output, "utf8");
  assert.match(output, /Liabilities:loan:Home_Loan\s+-2500 INR/);
  assert.doesNotMatch(output, /House/);
});

test("uses imported trades for cost basis and adds only the unmatched holding units", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-ledger-export-"));
  mkdirSync(path.join(root, "imports"), { recursive: true });
  const add = (sourceType: string, originalPath: string, dataFile: string, rows: unknown[]) => {
    const contentSha256 = sourceType[0].repeat(64),
      importId = createHash("sha256")
        .update(`${sourceType}\n${originalPath}\n${contentSha256}`)
        .digest("hex"),
      directory = path.join(root, "extracted", "imports", sourceType, importId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        record_type: "import_manifest",
        import_id: importId,
        source_type: sourceType,
        original_path: originalPath,
        content_sha256: contentSha256,
        imported_at: "2026-10-25T00:00:00Z",
        status: "succeeded"
      })
    );
    writeFileSync(
      path.join(directory, dataFile),
      JSON.stringify(
        rows.map((row) => ({
          ...(row as object),
          source: {
            import_id: importId,
            original_path: originalPath,
            content_sha256: contentSha256,
            record_locator: "row:2"
          }
        }))
      )
    );
  };
  add("kuvera_holdings", "investments/kuvera/holdings.csv", "holdings.json", [
    {
      record_type: "holding",
      source_id: "h".repeat(64),
      current_value: "240",
      units: "10",
      currency: "INR",
      as_of_date: "2026-10-24",
      security: { name: "Example Fund", identifier: "123456789", category: "Index Fund" }
    }
  ]);
  add("kuvera_transactions", "investments/kuvera/transactions.csv", "transactions.json", [
    {
      record_type: "kuvera_transaction",
      source_id: "t".repeat(64),
      trade_date: "2026-01-10",
      instrument: "Example Fund",
      folio: "123456789",
      side: "buy",
      quantity: "8",
      price: "20",
      currency: "INR"
    }
  ]);
  const result = exportLedgerSnapshot({ root });
  assert.equal(result.included, 2);
  const output = readFileSync(result.output, "utf8");
  assert.match(output, /P 2026-10-24 "SEC_123456789" 24 INR/);
  assert.match(output, /2026-01-10 Imported buy/);
  assert.match(output, /8 "SEC_123456789" @ 20 INR/);
  assert.match(output, /2 "SEC_123456789" @ 24 INR/);
});

test("consolidates NSDL mutual-fund folios and maps their trades to the ISIN account", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-ledger-export-"));
  mkdirSync(path.join(root, "imports"), { recursive: true });
  const add = (sourceType: string, originalPath: string, dataFile: string, rows: unknown[]) => {
    const contentSha256 = sourceType[0].repeat(64),
      importId = createHash("sha256")
        .update(`${sourceType}\n${originalPath}\n${contentSha256}`)
        .digest("hex"),
      directory = path.join(root, "extracted", "imports", sourceType, importId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        record_type: "import_manifest",
        import_id: importId,
        source_type: sourceType,
        original_path: originalPath,
        content_sha256: contentSha256,
        imported_at: "2026-10-25T00:00:00Z",
        status: "succeeded"
      })
    );
    writeFileSync(
      path.join(directory, dataFile),
      JSON.stringify(
        rows.map((row, index) => ({
          ...(row as object),
          source: {
            import_id: importId,
            original_path: originalPath,
            content_sha256: contentSha256,
            record_locator: `row:${index + 2}`
          }
        }))
      )
    );
  };
  add("nsdl_cas_holdings", "investments/cas/statement.pdf", "holdings.json", [
    {
      record_type: "holding",
      source_id: "a".repeat(64),
      current_value: "600",
      units: "12",
      currency: "INR",
      as_of_date: "2026-09-30",
      security: {
        name: "Example Small Cap Fund - Direct",
        identifier: "INF000000001:11111",
        category: "mutual_fund_folio"
      }
    },
    {
      record_type: "holding",
      source_id: "b".repeat(64),
      current_value: "400",
      units: "8",
      currency: "INR",
      as_of_date: "2026-09-30",
      security: {
        name: "Example Small Cap Fund - Direct",
        identifier: "INF000000001:22222",
        category: "mutual_fund_folio"
      }
    }
  ]);
  add("kuvera_transactions", "investments/kuvera/transactions.csv", "transactions.json", [
    {
      record_type: "kuvera_transaction",
      source_id: "c".repeat(64),
      trade_date: "2026-01-10",
      instrument: "Example Small Cap Fund Growth Direct Plan",
      folio: "11111",
      side: "buy",
      quantity: "10",
      price: "40",
      currency: "INR"
    },
    {
      record_type: "kuvera_transaction",
      source_id: "d".repeat(64),
      trade_date: "2026-01-11",
      instrument: "Example Small Cap Fund Growth Direct Plan",
      folio: "22222",
      side: "buy",
      quantity: "5",
      price: "42",
      currency: "INR"
    },
    {
      record_type: "kuvera_transaction",
      source_id: "e".repeat(64),
      trade_date: "2025-12-01",
      instrument: "Example Small Cap Growth Direct Plan",
      folio: "33333",
      side: "buy",
      quantity: "1",
      price: "38",
      currency: "INR"
    }
  ]);

  exportLedgerSnapshot({ root });
  const output = readFileSync(
    path.join(root, "generated", "paisa-imported-balances.ledger"),
    "utf8"
  );
  const accounts = [...output.matchAll(/^    (Assets:Equity:mutual_fund_folio:[^ ]+)/gm)].map(
    (match) => match[1]
  );
  assert.equal(new Set(accounts).size, 1);
  assert.match(accounts[0], /Example_Small_Cap_Fund_-_Direct_INF000000001$/);
  assert.equal((output.match(/"INF000000001"/g) ?? []).length, 7);
  assert.match(output, /1 "INF000000001" @ 38 INR/);
  assert.equal((output.match(/2 "INF000000001" @ 50 INR/g) ?? []).length, 2);
  assert.doesNotMatch(output, /Assets:Equity:Investments:Example_Small_Cap_Fund/);
});

test("imports byte-identical tradebook exports only once", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-ledger-export-"));
  mkdirSync(path.join(root, "imports", "investments", "zerodha"), { recursive: true });
  const sourceType = "zerodha_tradebook",
    contentSha256 = "f".repeat(64),
    rows = [
      {
        record_type: "zerodha_trade",
        source_id: "t".repeat(64),
        trade_date: "2026-01-10",
        instrument: "Example Fund - Direct Plan",
        isin: "INF000000001",
        side: "buy",
        quantity: "10",
        price: "20",
        currency: "INR"
      }
    ];
  for (const originalPath of [
    "investments/zerodha/tradebook.csv",
    "investments/zerodha/tradebook (1).csv"
  ]) {
    const importId = createHash("sha256")
        .update(`${sourceType}\n${originalPath}\n${contentSha256}`)
        .digest("hex"),
      directory = path.join(root, "extracted", "imports", sourceType, importId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        record_type: "import_manifest",
        import_id: importId,
        source_type: sourceType,
        original_path: originalPath,
        content_sha256: contentSha256,
        imported_at: "2026-10-25T00:00:00Z",
        status: "succeeded"
      })
    );
    writeFileSync(
      path.join(directory, "trades.json"),
      JSON.stringify(
        rows.map((row) => ({
          ...row,
          source: {
            import_id: importId,
            original_path: originalPath,
            content_sha256: contentSha256,
            record_locator: "row:2"
          }
        }))
      )
    );
  }

  const result = exportLedgerSnapshot({ root });
  assert.equal(result.included, 1);
  const output = readFileSync(result.output, "utf8");
  assert.equal((output.match(/Imported buy/g) ?? []).length, 1);
});

test("prefers Zerodha when a Kuvera transaction is an exact cross-source match", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-ledger-export-"));
  mkdirSync(path.join(root, "imports"), { recursive: true });
  const add = (sourceType: string, originalPath: string, row: object) => {
    const contentSha256 = sourceType[0].repeat(64),
      importId = createHash("sha256")
        .update(`${sourceType}\n${originalPath}\n${contentSha256}`)
        .digest("hex"),
      directory = path.join(root, "extracted", "imports", sourceType, importId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, "manifest.json"),
      JSON.stringify({
        record_type: "import_manifest",
        import_id: importId,
        source_type: sourceType,
        original_path: originalPath,
        content_sha256: contentSha256,
        imported_at: "2026-10-25T00:00:00Z",
        status: "succeeded"
      })
    );
    writeFileSync(
      path.join(
        directory,
        sourceType === "kuvera_transactions" ? "transactions.json" : "trades.json"
      ),
      JSON.stringify([
        {
          ...row,
          source: {
            import_id: importId,
            original_path: originalPath,
            content_sha256: contentSha256,
            record_locator: "row:2"
          }
        }
      ])
    );
  };
  add("kuvera_transactions", "investments/kuvera/transactions.csv", {
    record_type: "kuvera_transaction",
    source_id: "k".repeat(64),
    trade_date: "2026-01-10",
    instrument: "Example Liquid Growth Direct Plan",
    folio: "123456789",
    side: "buy",
    quantity: "10",
    price: "20.25",
    currency: "INR"
  });
  add("zerodha_tradebook", "investments/zerodha/tradebook.csv", {
    record_type: "zerodha_trade",
    source_id: "z".repeat(64),
    trade_date: "2026-01-10",
    instrument: "EXAMPLE LIQUID FUND - DIRECT PLAN",
    isin: "INF000000001",
    side: "buy",
    quantity: "10.000000",
    price: "20.2500",
    currency: "INR"
  });

  const result = exportLedgerSnapshot({ root });
  assert.equal(result.included, 1);
  const output = readFileSync(result.output, "utf8");
  assert.match(output, /investments\/zerodha\/tradebook\.csv/);
  assert.doesNotMatch(output, /investments\/kuvera\/transactions\.csv/);
});

test("uses the latest validated Kite snapshot as a terminal holding source", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "paisa-ledger-export-"));
  mkdirSync(path.join(root, "imports"), { recursive: true });
  const directory = path.join(root, "extracted", "api", "zerodha", "2026-10-26", "snapshot-1"),
    snapshot = JSON.stringify({
      holdings: [
        {
          tradingsymbol: "EXAMPLE",
          exchange: "NSE",
          isin: "INE000000001",
          quantity: 5,
          average_price: 100,
          last_price: 125
        }
      ],
      positions: {},
      margins: {},
      orders: [],
      trades: []
    }),
    contentSha256 = createHash("sha256").update(snapshot).digest("hex");
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, "snapshot.json"), snapshot);
  writeFileSync(
    path.join(directory, "manifest.json"),
    JSON.stringify({
      record_type: "zerodha_kite_snapshot_manifest",
      fetched_at: "2026-10-26T15:34:07.148Z",
      as_of_date: "2026-10-26",
      source_type: "zerodha_kite_api",
      api_version: "3",
      sync_version: "1.0.0",
      content_sha256: contentSha256,
      counts: { holdings: 1, orders: 0, trades: 0 }
    })
  );

  const result = exportLedgerSnapshot({ root });
  assert.equal(result.included, 1);
  const output = readFileSync(result.output, "utf8");
  assert.match(output, /P 2026-10-26 "INE000000001" 125 INR/);
  assert.match(output, /5 "INE000000001" @ 125 INR/);
  assert.match(output, /api\/zerodha\/2026-10-26:NSE:EXAMPLE/);
});
