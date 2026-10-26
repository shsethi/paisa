import { execFile } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  exchangeZerodhaRequestToken,
  extractRequestToken,
  fetchZerodhaSnapshot,
  loadZerodhaCredentials,
  saveZerodhaSnapshot,
  zerodhaLoginUrl
} from "../src/lib/finance/zerodha_kite";

function parseArgs(args: string[]): { root?: string; credentials?: string; dryRun: boolean } {
  const result: { root?: string; credentials?: string; dryRun: boolean } = { dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--dry-run") {
      result.dryRun = true;
      continue;
    }
    if (option !== "--root" && option !== "--credentials")
      throw new Error(`Unsupported option: ${option}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
    if (option === "--root") result.root = value;
    else result.credentials = value;
  }
  return result;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(
      'Usage: npm run finance:sync-zerodha -- [--root "/path/to/My Finance"] [--credentials "/path/to/zerodha.txt"] [--dry-run]\n\n' +
        "Credentials may instead be provided as ZERODHA_API_KEY and ZERODHA_API_SECRET.\n" +
        "A current ZERODHA_ACCESS_TOKEN skips interactive login. Secrets and tokens are never saved.\n"
    );
    return;
  }
  const options = parseArgs(args);
  const credentials =
    process.env.ZERODHA_API_KEY && process.env.ZERODHA_API_SECRET
      ? { apiKey: process.env.ZERODHA_API_KEY, apiSecret: process.env.ZERODHA_API_SECRET }
      : loadZerodhaCredentials(options.credentials);
  let accessToken = process.env.ZERODHA_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    const loginUrl = zerodhaLoginUrl(credentials.apiKey);
    stdout.write("Open this Zerodha login URL in your browser:\n");
    stdout.write(`${loginUrl}\n\n`);
    if (process.platform === "darwin") {
      execFile("open", [loginUrl], () => undefined);
    }
    const reader = createInterface({ input: stdin, output: stdout });
    try {
      const redirect = await reader.question("Paste the redirect URL or request_token: ");
      accessToken = await exchangeZerodhaRequestToken(credentials, extractRequestToken(redirect));
    } finally {
      reader.close();
    }
  }
  const data = await fetchZerodhaSnapshot(credentials.apiKey, accessToken);
  const counts = {
    holdings: data.holdings.length,
    orders: data.orders.length,
    trades: data.trades.length
  };
  if (options.dryRun) {
    stdout.write(`${JSON.stringify({ status: "ok", dry_run: true, counts }, null, 2)}\n`);
    return;
  }
  const saved = saveZerodhaSnapshot({ root: options.root, data });
  stdout.write(
    `${JSON.stringify(
      {
        status: "ok",
        dry_run: false,
        already_saved: saved.already_saved,
        directory: saved.directory,
        counts: saved.counts
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Zerodha sync failed."}\n`);
  process.exitCode = 1;
});
