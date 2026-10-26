<script lang="ts">
  import { onMount } from "svelte";
  import { ajax, type LocalFinancePortfolio } from "$lib/utils";
  import { calculateNetWorth, type NetWorthInput, type NetWorthResult } from "$lib/finance/networth_service";

  let data: LocalFinancePortfolio = { holdings: [], balances: [], imports: [], warnings: [] };
  let result: NetWorthResult | null = null;
  let asOfDate = new Date().toLocaleDateString("en-CA");
  let loading = true;
  let error = "";

  const exclusionLabels: Record<string, string> = {
    missing_as_of_date: "missing as-of date",
    invalid_as_of_date: "invalid as-of date",
    after_selected_date: "after selected date",
    missing_amount: "missing amount",
    missing_currency: "missing currency",
    cash_flow_record: "cash-flow record",
    superseded_overlap: "superseded by a newer overlapping snapshot",
    unresolved_overlap: "unresolved overlap"
  };

  function recalculate() {
    const input: NetWorthInput = {
      asOfDate,
      holdings: data.holdings.filter((record) => record.record_type === "holding" && record.current_value !== undefined).map((record) => ({
        record_type: "holding", source_id: record.source_id, current_value: record.current_value!,
        currency: record.currency ?? "", as_of_date: record.as_of_date ?? null, source: record.source, security: record.security
      })),
      manualBalances: data.balances.filter((record) => record.record_type === "manual_balance" && record.category !== "real_asset").map((record) => ({
        record_type: "manual_balance", source_id: record.source_id, balance_type: record.balance_type ?? "asset",
        amount: record.amount ?? null, currency: record.currency ?? null, as_of_date: record.as_of_date ?? "",
        source: record.source, category: record.category, label: record.label,
        owner: record.owner, account_label: record.account_label
      }))
    };
    try { result = calculateNetWorth(input); error = ""; }
    catch { result = null; error = "The selected date or imported balance values are invalid."; }
  }

  async function load() {
    loading = true;
    error = "";
    try {
      data = await ajax("/api/finance/portfolio");
      recalculate();
    } catch {
      error = "Could not load local portfolio imports.";
    } finally { loading = false; }
  }

  function format(value: string, currency: string): string {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    try { return new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 2 }).format(number); }
    catch { return `${value} ${currency}`; }
  }

  function sourceLabel(source: { original_path: string; record_locator: string }): string {
    return `${source.original_path} · ${source.record_locator}`;
  }

  $: undatedHoldings = data.holdings.filter((holding) => holding.record_type === "holding" && !holding.as_of_date);
  onMount(load);
</script>

<svelte:head><title>Personal net worth - Paisa</title></svelte:head>

<section class="section">
  <div class="container is-fluid">
    <div class="level is-align-items-flex-start">
      <div class="level-left"><div><h1 class="title is-4">Personal net worth</h1><p class="subtitle is-6">Local snapshots and holdings, with source freshness and row references.</p></div></div>
      <div class="level-right">
        <div class="field is-horizontal mr-3">
          <label class="label mr-3" for="as-of-date">As of</label>
          <input id="as-of-date" class="input" type="date" bind:value={asOfDate} on:change={recalculate} />
        </div>
        <button class="button is-light" on:click={load} disabled={loading}>Refresh</button>
      </div>
    </div>

    {#if error}<div class="notification is-danger is-light" role="alert">{error}</div>{/if}
    {#each data.warnings as warning}<div class="notification is-warning is-light" role="status">{warning}</div>{/each}
    {#if loading}
      <div class="box has-text-centered">Loading local balances…</div>
    {:else if result}
      {#if Object.keys(result.currencies).length === 0}
        <div class="box"><h2 class="title is-5">No dated balances available</h2><p>No assets or liabilities can be valued on or before {result.asOfDate}. Add a dated holdings or manual-balance import, then refresh.</p><p class="help">Rows without a date, amount, or currency are intentionally excluded from totals.</p></div>
      {:else}
        <div class="columns is-multiline">
          {#each Object.entries(result.currencies) as [currency, totals]}
            <div class="column is-12-mobile is-4-tablet">
              <div class="box">
                <p class="heading">{currency} · as of {result.asOfDate}</p>
                <p class="title is-4">{format(totals.netWorth, currency)}</p>
                <p><span class="has-text-grey">Assets</span> {format(totals.assets, currency)}</p>
                <p><span class="has-text-grey">Liabilities</span> {format(totals.liabilities, currency)}</p>
                <p class="help mt-2">Net worth = assets − liabilities</p>
              </div>
            </div>
          {/each}
        </div>
      {/if}
      {#if undatedHoldings.length}
        <div class="notification is-info is-light">{undatedHoldings.length} holding rows have no as-of date and are excluded from the selected-date totals.</div>
      {/if}
      {#if result.overlaps.length}
        <div class="notification is-warning is-light">{result.overlaps.length} unresolved overlap groups are shown separately and excluded from totals.</div>
        <div class="box"><h2 class="title is-6">Overlap records for review</h2>
          {#each result.overlaps as overlap}
            <div class="mb-3"><strong>{overlap.key}</strong>
              {#each overlap.records as line}<p class="is-size-7">{line.source.original_path} · {line.source.record_locator} · {line.amount} {line.currency}</p>{/each}
            </div>
          {/each}
        </div>
      {/if}
      <div class="box">
        <h2 class="title is-6">Included source rows</h2>
        {#if result.assets.length === 0 && result.liabilities.length === 0}
          <p>No dated rows are included in the selected-date totals.</p>
        {:else}
          <div class="table-container">
            <table class="table is-striped is-fullwidth is-size-7">
              <thead><tr><th>Type</th><th>Label / ID</th><th class="has-text-right">Amount</th><th>As of</th><th>Source</th></tr></thead>
              <tbody>
                {#each [...result.assets, ...result.liabilities] as line}
                  <tr>
                    <td>{line.kind === "manual_balance" && result.liabilities.some((item) => item.source_id === line.source_id) ? "Liability" : "Asset"}</td>
                    <td>{line.label || line.source_id}</td>
                    <td class="has-text-right">{format(line.amount, line.currency)}</td>
                    <td>{line.as_of_date}</td>
                    <td>{sourceLabel(line.source)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      </div>
      {#if result.excludedRecords.length}
        <div class="box">
          <h2 class="title is-6">Excluded rows · {result.excludedRecords.length}</h2>
          <p class="help mb-2">These records are not included in the selected-date totals.</p>
          {#each result.excludedRecords as excluded}
            <p class="is-size-7">{excluded.source_id} · {exclusionLabels[excluded.reason] || excluded.reason}</p>
          {/each}
        </div>
    {/if}
    {/if}

    <div class="box">
      <h2 class="title is-6">Import freshness</h2>
      {#if data.imports.length === 0}<p>No local holdings or manual-balance imports found.</p>{/if}
      {#each data.imports as item}
        <p class="is-size-7">{item.source_type} · {item.original_path} · {item.status} · {item.source_current ? "source current" : "source stale or unavailable"} · {item.error_count} {item.error_count === 1 ? "error" : "errors"}</p>
      {/each}
    </div>
  </div>
</section>
