<script lang="ts">
  import { onMount } from "svelte";
  import { ajax, type LocalFinancePortfolio } from "$lib/utils";
  import { calculateAllocation, type AllocationResult } from "$lib/allocation_service";

  type Holding = {
    record_type: "holding";
    source_id: string;
    security: { name?: string; identifier?: string; symbol?: string; category?: string };
    units?: string;
    cost_basis?: string;
    current_value: string;
    average_price?: string;
    nav?: string;
    average_nav?: string;
    total_returns_percent?: string;
    xirr_percent?: string;
    currency: string;
    as_of_date: string | null;
    source: { original_path: string; record_locator: string };
  };
  let response: LocalFinancePortfolio = { holdings: [], balances: [], imports: [], warnings: [] };
  let holdings: Holding[] = [];
  let allocationByCurrency: Array<{ currency: string; result: AllocationResult }> = [];
  let loading = true;
  let error = "";

  async function load() {
    loading = true;
    try {
      response = await ajax("/api/finance/portfolio");
      holdings = response.holdings
        .filter(
          (holding) =>
            holding.record_type === "holding" &&
            holding.current_value !== undefined &&
            holding.currency !== undefined
        )
        .map((holding) => ({
          record_type: "holding",
          source_id: holding.source_id,
          security: holding.security ?? {},
          units: holding.units,
          cost_basis: holding.cost_basis,
          current_value: holding.current_value!,
          average_price: holding.average_price,
          nav: holding.nav,
          average_nav: holding.average_nav,
          total_returns_percent: holding.total_returns_percent,
          xirr_percent: holding.xirr_percent,
          currency: holding.currency!,
          as_of_date: holding.as_of_date ?? null,
          source: {
            original_path: holding.source.original_path,
            record_locator: holding.source.record_locator
          }
        }));
      allocationByCurrency = [...new Set(holdings.map((holding) => holding.currency))]
        .sort()
        .map((currency) => {
          const currencyHoldings = holdings.filter((holding) => holding.currency === currency);
          const classes = [
            ...new Set(
              currencyHoldings.map((holding) => holding.security.category || "Unclassified")
            )
          ];
          const mappings = classes.map((assetClass) => ({ holdingType: assetClass, assetClass }));
          return {
            currency,
            result: calculateAllocation({
              holdings: currencyHoldings.map((holding) => ({
                id: holding.source_id,
                security:
                  holding.security.symbol || holding.security.identifier || holding.security.name,
                holdingType: holding.security.category || "Unclassified",
                value: holding.current_value
              })),
              mappings
            })
          };
        });
    } catch {
      error = "Could not load local portfolio imports.";
    } finally {
      loading = false;
    }
  }

  function format(value: string | number, currency: string): string {
    const number = Number(value);
    if (!Number.isFinite(number)) return "—";
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency,
        maximumFractionDigits: 2
      }).format(number);
    } catch {
      return `${value} ${currency}`;
    }
  }
  $: totalRows = holdings.length;
  onMount(load);
</script>

<svelte:head><title>Imported portfolio - Paisa</title></svelte:head>

<section class="section">
  <div class="container is-fluid">
    <div class="level">
      <div>
        <h1 class="title is-4">Local portfolio</h1>
        <p class="subtitle is-6">
          Imported and verified API holdings with category breakdowns and source provenance.
        </p>
      </div>
      <button class="button is-light" on:click={load} disabled={loading}>Refresh</button>
    </div>
    {#if error}<div class="notification is-danger is-light" role="alert">{error}</div>{/if}
    {#each response.warnings as warning}<div class="notification is-warning is-light" role="status">
        {warning}
      </div>{/each}
    {#if loading}
      <div class="box has-text-centered">Loading imported holdings…</div>
    {:else if totalRows === 0}
      <div class="box">
        <h2 class="title is-5">No holdings found</h2>
        <p>Import a provider export or run the Zerodha Kite sync to populate this view.</p>
      </div>
    {:else}
      {#each allocationByCurrency as item}
        <div class="box">
          <h2 class="title is-6">Category breakdown · {item.currency}</h2>
          {#each item.result.allocations as row}
            <div class="columns is-mobile is-vcentered mb-1">
              <div class="column">{row.assetClass}</div>
              <div class="column has-text-right">{format(row.currentValue, item.currency)}</div>
              <div class="column is-2 has-text-right">{row.currentPercentage.toFixed(1)}%</div>
            </div>
          {/each}
          <p class="help">
            Groups use the provider's category field. Figures are not converted across currencies.
          </p>
        </div>
      {/each}
      <div class="box">
        <h2 class="title is-6">Holdings · {totalRows} rows</h2>
        <div class="table-container">
          <table class="table is-striped is-hoverable is-fullwidth">
            <thead
              ><tr
                ><th>Security</th><th>Category</th><th>Units</th><th>Cost / average price</th><th
                  >Current value</th
                ><th>NAV / return</th><th>As of</th><th>Source</th></tr
              ></thead
            >
            <tbody>
              {#each holdings as holding}
                <tr>
                  <td
                    >{holding.security.name ||
                      holding.security.symbol ||
                      holding.security.identifier ||
                      "—"}</td
                  >
                  <td>{holding.security.category || "—"}</td>
                  <td>{holding.units || "—"}</td>
                  <td
                    >{#if holding.cost_basis}{format(
                        holding.cost_basis,
                        holding.currency
                      )}{:else if holding.average_price}{holding.average_price}
                      {holding.currency} / unit{:else}—{/if}</td
                  >
                  <td>{format(holding.current_value, holding.currency)}</td>
                  <td
                    >{holding.nav || "—"}{#if holding.total_returns_percent}
                      · {holding.total_returns_percent}%{/if}{#if holding.xirr_percent}
                      · XIRR {holding.xirr_percent}%{/if}</td
                  >
                  <td>{holding.as_of_date || "Not supplied"}</td>
                  <td class="is-size-7"
                    >{holding.source.original_path}<br />{holding.source.record_locator}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
    <div class="box">
      <h2 class="title is-6">Source freshness</h2>
      {#if response.imports.length === 0}<p>No local holding imports found.</p>{/if}
      {#each response.imports as item}<p class="is-size-7">
          {item.source_type} · {item.original_path} · {item.status} · {item.source_current
            ? "source current"
            : "source stale or unavailable"} · {item.error_count} errors
        </p>{/each}
    </div>
  </div>
</section>
