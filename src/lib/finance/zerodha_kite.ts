import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export const ZERODHA_KITE_SYNC_VERSION = "1.0.0";
const KITE_API_BASE = "https://api.kite.trade";

export type ZerodhaCredentials = { apiKey: string; apiSecret: string };
export type ZerodhaSnapshotData = {
  holdings: unknown[];
  positions: unknown;
  margins: unknown;
  orders: unknown[];
  trades: unknown[];
};
export type ZerodhaSnapshotResult = {
  directory: string;
  snapshot_path: string;
  manifest_path: string;
  already_saved: boolean;
  counts: { holdings: number; orders: number; trades: number };
};

type FetchResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<FetchResponse>;
type KiteEnvelope<T> = {
  status?: string;
  data?: T;
  error_type?: string;
  message?: string;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredValue(value: string | undefined, name: string): string {
  const result = value?.trim();
  if (!result) throw new Error(`Missing Zerodha ${name}.`);
  return result;
}

export function parseZerodhaCredentials(input: string): ZerodhaCredentials {
  const entries = new Map<string, string>();
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.search(/[:=]/);
    if (separator < 1) throw new Error("Zerodha credentials must use labelled key=value lines.");
    const label = line
      .slice(0, separator)
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, "");
    const value = line.slice(separator + 1).trim();
    if (!value) throw new Error(`Zerodha credential '${label}' has no value.`);
    entries.set(label, value);
  }
  return {
    apiKey: requiredValue(entries.get("key") ?? entries.get("apikey"), "API key"),
    apiSecret: requiredValue(entries.get("secret") ?? entries.get("apisecret"), "API secret")
  };
}

export function findZerodhaCredentialsFile(explicitPath?: string): string {
  const configured = explicitPath ?? process.env.ZERODHA_CREDENTIALS_FILE;
  if (configured) {
    const resolved = path.resolve(configured);
    if (!existsSync(resolved))
      throw new Error("Configured Zerodha credentials file was not found.");
    return resolved;
  }
  for (let directory = process.cwd(); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "zerodha.txt");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
  }
  throw new Error(
    "Could not find zerodha.txt; pass --credentials or set ZERODHA_CREDENTIALS_FILE."
  );
}

export function loadZerodhaCredentials(file?: string): ZerodhaCredentials {
  return parseZerodhaCredentials(readFileSync(findZerodhaCredentialsFile(file), "utf8"));
}

export function zerodhaLoginUrl(apiKey: string): string {
  const query = new URLSearchParams({ v: "3", api_key: apiKey });
  return `https://kite.zerodha.com/connect/login?${query.toString()}`;
}

export function extractRequestToken(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("A Zerodha request token is required.");
  try {
    const token = new URL(value).searchParams.get("request_token");
    if (token) return token;
  } catch {
    // A bare request token is also accepted.
  }
  if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
  throw new Error("Paste either the redirect URL or its request_token value.");
}

export function zerodhaSessionChecksum(
  apiKey: string,
  requestToken: string,
  apiSecret: string
): string {
  return sha256(`${apiKey}${requestToken}${apiSecret}`);
}

async function responseEnvelope<T>(response: FetchResponse, operation: string): Promise<T> {
  let envelope: KiteEnvelope<T>;
  try {
    envelope = (await response.json()) as KiteEnvelope<T>;
  } catch {
    throw new Error(`Zerodha ${operation} returned an unreadable response.`);
  }
  if (!response.ok || envelope.status !== "success" || envelope.data === undefined) {
    const kind = envelope.error_type ? ` (${envelope.error_type})` : "";
    throw new Error(`Zerodha ${operation} failed${kind}; HTTP ${response.status}.`);
  }
  return envelope.data;
}

export async function exchangeZerodhaRequestToken(
  credentials: ZerodhaCredentials,
  requestToken: string,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike
): Promise<string> {
  const body = new URLSearchParams({
    api_key: credentials.apiKey,
    request_token: requestToken,
    checksum: zerodhaSessionChecksum(credentials.apiKey, requestToken, credentials.apiSecret)
  });
  const response = await fetchImpl(`${KITE_API_BASE}/session/token`, {
    method: "POST",
    headers: {
      "X-Kite-Version": "3",
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: body.toString()
  });
  const data = await responseEnvelope<{ access_token?: string }>(response, "authentication");
  return requiredValue(data.access_token, "access token");
}

async function kiteGet<T>(
  route: string,
  apiKey: string,
  accessToken: string,
  fetchImpl: FetchLike
): Promise<T> {
  const response = await fetchImpl(`${KITE_API_BASE}${route}`, {
    headers: {
      "X-Kite-Version": "3",
      Authorization: `token ${apiKey}:${accessToken}`
    }
  });
  return responseEnvelope<T>(response, route);
}

export async function fetchZerodhaSnapshot(
  apiKey: string,
  accessToken: string,
  fetchImpl: FetchLike = globalThis.fetch as FetchLike
): Promise<ZerodhaSnapshotData> {
  const [holdings, positions, margins, orders, trades] = await Promise.all([
    kiteGet<unknown[]>("/portfolio/holdings", apiKey, accessToken, fetchImpl),
    kiteGet<unknown>("/portfolio/positions", apiKey, accessToken, fetchImpl),
    kiteGet<unknown>("/user/margins", apiKey, accessToken, fetchImpl),
    kiteGet<unknown[]>("/orders", apiKey, accessToken, fetchImpl),
    kiteGet<unknown[]>("/trades", apiKey, accessToken, fetchImpl)
  ]);
  return { holdings, positions, margins, orders, trades };
}

function financeRoot(rootOption?: string): string {
  const configured = rootOption ?? process.env.PAISA_FINANCE_ROOT;
  if (configured) {
    const root = path.resolve(configured);
    if (existsSync(path.join(root, "extracted"))) return root;
    throw new Error("Finance root does not contain an extracted folder.");
  }
  for (let directory = process.cwd(); ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "My Finance");
    if (existsSync(path.join(candidate, "extracted"))) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error("Could not find My Finance; pass --root or set PAISA_FINANCE_ROOT.");
  }
}

function dateInIndia(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function saveZerodhaSnapshot(options: {
  root?: string;
  data: ZerodhaSnapshotData;
  now?: Date;
}): ZerodhaSnapshotResult {
  const now = options.now ?? new Date();
  const fetchedAt = now.toISOString();
  const payload = `${JSON.stringify(options.data, null, 2)}\n`;
  const contentSha256 = sha256(payload);
  const stamp = fetchedAt.replace(/[:.]/g, "-");
  const directory = path.join(
    financeRoot(options.root),
    "extracted",
    "api",
    "zerodha",
    dateInIndia(now),
    `${stamp}-${contentSha256.slice(0, 12)}`
  );
  const snapshotPath = path.join(directory, "snapshot.json");
  const manifestPath = path.join(directory, "manifest.json");
  const counts = {
    holdings: options.data.holdings.length,
    orders: options.data.orders.length,
    trades: options.data.trades.length
  };
  if (existsSync(snapshotPath) && existsSync(manifestPath)) {
    return {
      directory,
      snapshot_path: snapshotPath,
      manifest_path: manifestPath,
      already_saved: true,
      counts
    };
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(snapshotPath, payload, { encoding: "utf8", mode: 0o600, flag: "wx" });
  const manifest = {
    record_type: "zerodha_kite_snapshot_manifest",
    fetched_at: fetchedAt,
    as_of_date: dateInIndia(now),
    source_type: "zerodha_kite_api",
    api_version: "3",
    sync_version: ZERODHA_KITE_SYNC_VERSION,
    content_sha256: contentSha256,
    endpoints: [
      "/portfolio/holdings",
      "/portfolio/positions",
      "/user/margins",
      "/orders",
      "/trades"
    ],
    counts
  };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx"
  });
  return {
    directory,
    snapshot_path: snapshotPath,
    manifest_path: manifestPath,
    already_saved: false,
    counts
  };
}
