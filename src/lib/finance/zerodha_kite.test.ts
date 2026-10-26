import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  exchangeZerodhaRequestToken,
  extractRequestToken,
  fetchZerodhaSnapshot,
  parseZerodhaCredentials,
  saveZerodhaSnapshot,
  zerodhaSessionChecksum,
  type FetchLike,
  type ZerodhaSnapshotData
} from "./zerodha_kite";

test("parses labelled credentials without accepting ambiguous bare secrets", () => {
  assert.deepEqual(parseZerodhaCredentials("key = public-key\nsecret: private-secret\n"), {
    apiKey: "public-key",
    apiSecret: "private-secret"
  });
  assert.throws(() => parseZerodhaCredentials("public-key\nprivate-secret\n"), /labelled/);
});

test("extracts a request token from either a redirect URL or a bare token", () => {
  assert.equal(
    extractRequestToken("https://localhost/callback?status=success&request_token=abc_123"),
    "abc_123"
  );
  assert.equal(extractRequestToken("abc-123"), "abc-123");
});

test("computes and sends the documented session checksum", async () => {
  const expected = createHash("sha256").update("keytokensecret").digest("hex");
  assert.equal(zerodhaSessionChecksum("key", "token", "secret"), expected);
  const fetchImpl: FetchLike = async (url, init) => {
    assert.equal(url, "https://api.kite.trade/session/token");
    assert.match(init?.body ?? "", new RegExp(`checksum=${expected}`));
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: { access_token: "session-token" } })
    };
  };
  assert.equal(
    await exchangeZerodhaRequestToken({ apiKey: "key", apiSecret: "secret" }, "token", fetchImpl),
    "session-token"
  );
});

test("fetches only the configured read-only account endpoints", async () => {
  const seen: string[] = [];
  const values: Record<string, unknown> = {
    "/portfolio/holdings": [{ tradingsymbol: "TEST" }],
    "/portfolio/positions": { net: [], day: [] },
    "/user/margins": { equity: {}, commodity: {} },
    "/orders": [],
    "/trades": []
  };
  const fetchImpl: FetchLike = async (url, init) => {
    const route = new URL(url).pathname;
    seen.push(route);
    assert.equal(init?.method, undefined);
    assert.equal(init?.headers?.Authorization, "token api-key:access-token");
    return {
      ok: true,
      status: 200,
      json: async () => ({ status: "success", data: values[route] })
    };
  };
  const result = await fetchZerodhaSnapshot("api-key", "access-token", fetchImpl);
  assert.equal(result.holdings.length, 1);
  assert.deepEqual(seen.sort(), Object.keys(values).sort());
  assert.ok(seen.every((route) => !route.startsWith("/orders/regular")));
});

test("writes immutable private snapshots with provenance", () => {
  const root = mkdtempSync(path.join(tmpdir(), "paisa-zerodha-kite-"));
  mkdirSync(path.join(root, "extracted"));
  const data: ZerodhaSnapshotData = {
    holdings: [{ tradingsymbol: "TEST" }],
    positions: { net: [], day: [] },
    margins: { equity: {} },
    orders: [],
    trades: []
  };
  const now = new Date("2026-10-26T04:30:00.000Z");
  const first = saveZerodhaSnapshot({ root, data, now });
  const second = saveZerodhaSnapshot({ root, data, now });
  assert.equal(first.already_saved, false);
  assert.equal(second.already_saved, true);
  assert.equal(statSync(first.snapshot_path).mode & 0o777, 0o600);
  const manifest = JSON.parse(readFileSync(first.manifest_path, "utf8")) as {
    source_type: string;
    counts: { holdings: number };
  };
  assert.equal(manifest.source_type, "zerodha_kite_api");
  assert.equal(manifest.counts.holdings, 1);
  assert.doesNotMatch(readFileSync(first.manifest_path, "utf8"), /access-token|secret/);
});
