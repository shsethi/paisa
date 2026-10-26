<script lang="ts">
  import { onMount } from "svelte";
  import { ajax, type LocalFinancePortfolio, type LocalFinanceRecord, type PublicMarketPrice } from "$lib/utils";
  import { calculateAllocation, type AllocationResult } from "$lib/allocation_service";
  import {
    defaultAllocationConfig,
    emptyAllocationConfig,
    loadAllocationConfig,
    saveAllocationConfig,
    type AllocationConfigStorage,
    type HoldingsAllocationConfig
  } from "$lib/holdings_allocation_config";

  type CurrencyAllocation = { currency: string; result: AllocationResult };
  type MappingField = "holdingType" | "security" | "assetClass";

  let data: LocalFinancePortfolio = { holdings: [], balances: [], imports: [], warnings: [] };
  let holdings: LocalFinanceRecord[] = [];
  let allocationByCurrency: CurrencyAllocation[] = [];
  let config: HoldingsAllocationConfig = emptyAllocationConfig();
  let loading = true;
  let error = "";
  let configSaved = false;
  let marketPrices: PublicMarketPrice[] = [];
  let priceLoading: Record<string, boolean> = {};
  let priceMessages: Record<string, string> = {};

  function marketIdentifier(holding: LocalFinanceRecord): { symbol: string; asset_type: string } | null {
    const symbol = holding.security?.symbol || holding.security?.identifier;
    const category = holding.security?.category?.toLowerCase() || "";
    if (!symbol || !/(stock|equity|etf)/.test(category)) return null;
    return { symbol, asset_type: category.includes("etf") ? "etf" : "stock" };
  }

  function marketKey(identifier: { symbol: string; asset_type?: string }): string {
    return `${identifier.symbol.toUpperCase()}@#${identifier.asset_type || ""}`;
  }

  function cachedPrice(holding: LocalFinanceRecord): PublicMarketPrice | undefined {
    const identifier = marketIdentifier(holding);
    return identifier ? marketPrices.find((price) => marketKey(price.identifier) === marketKey(identifier)) : undefined;
  }

  async function refreshMarketPrice(holding: LocalFinanceRecord) {
    const identifier = marketIdentifier(holding);
    if (!identifier) return;
    const key = marketKey(identifier);
    priceLoading = { ...priceLoading, [key]: true };
    priceMessages = { ...priceMessages, [key]: "" };
    try {
      const result = await ajax("/api/price/public/refresh", { method: "POST", body: JSON.stringify(identifier) });
      if (result.price) marketPrices = [...marketPrices.filter((price) => marketKey(price.identifier) !== key), result.price];
      priceMessages = { ...priceMessages, [key]: result.error || "" };
    } catch {
      priceMessages = { ...priceMessages, [key]: "Price refresh failed." };
    } finally {
      priceLoading = { ...priceLoading, [key]: false };
    }
  }

  function validValue(value: string | null | undefined): boolean {
    return (
      value !== null &&
      value !== undefined &&
      value.trim() !== "" &&
      Number.isFinite(Number(value.replaceAll(",", "").trim()))
    );
  }

  function effectiveMappings() {
    return config.mappings.filter((mapping) => {
      return Boolean(
        mapping.assetClass?.trim() && (mapping.holdingType?.trim() || mapping.security?.trim())
      );
    });
  }

  function rebuildAllocation() {
    const currencies = [
      ...new Set(
        holdings
          .map((holding) => holding.currency)
          .filter((currency): currency is string => Boolean(currency))
      )
    ].sort();
    allocationByCurrency = currencies.map((currency) => {
      const currencyHoldings = holdings.filter(
        (holding) => holding.currency === currency && validValue(holding.current_value)
      );
      return {
        currency,
        result: calculateAllocation({
          holdings: currencyHoldings.map((holding) => ({
            id: holding.source_id,
            security:
              holding.security?.symbol || holding.security?.identifier || holding.security?.name,
            holdingType: holding.security?.category || "",
            value: holding.current_value!
          })),
          mappings: effectiveMappings(),
          targets: config.targets
        })
      };
    });
  }

  function browserStorage(): AllocationConfigStorage | undefined {
    if (typeof window === "undefined") return undefined;
    try {
      return window.localStorage;
    } catch {
      return undefined;
    }
  }

  function persistConfig() {
    configSaved = saveAllocationConfig(browserStorage(), config);
    rebuildAllocation();
  }

  function inputValue(event: Event): string {
    return (event.currentTarget as HTMLInputElement).value;
  }

  function updateMapping(index: number, field: MappingField, event: Event) {
    const value = inputValue(event);
    config = {
      ...config,
      mappings: config.mappings.map((mapping, mappingIndex) =>
        mappingIndex === index ? { ...mapping, [field]: value } : mapping
      )
    };
    persistConfig();
  }

  function addMapping() {
    config = {
      ...config,
      mappings: [...config.mappings, { holdingType: "", security: "", assetClass: "" }]
    };
    persistConfig();
  }

  function removeMapping(index: number) {
    config = {
      ...config,
      mappings: config.mappings.filter((_mapping, mappingIndex) => mappingIndex !== index)
    };
    persistConfig();
  }

  function updateTarget(index: number, field: "assetClass" | "target", event: Event) {
    const value = inputValue(event);
    config = {
      ...config,
      targets: config.targets.map((target, targetIndex) =>
        targetIndex === index
          ? { ...target, [field]: field === "target" ? Number(value) : value }
          : target
      )
    };
    persistConfig();
  }

  function addTarget() {
    config = { ...config, targets: [...config.targets, { assetClass: "", target: 0 }] };
    persistConfig();
  }

  function removeTarget(index: number) {
    config = {
      ...config,
      targets: config.targets.filter((_target, targetIndex) => targetIndex !== index)
    };
    persistConfig();
  }

  function resetConfig() {
    const categories = holdings.map((holding) => holding.security?.category || "");
    config = defaultAllocationConfig(categories);
    persistConfig();
  }

  async function load() {
    loading = true;
    error = "";
    try {
      data = await ajax("/api/finance/portfolio");
      holdings = data.holdings.filter((record) => record.record_type === "holding");
      try { marketPrices = (await ajax("/api/price/public")).prices; } catch { marketPrices = []; }
      const stored = loadAllocationConfig(browserStorage());
      config =
        stored ??
        defaultAllocationConfig(holdings.map((holding) => holding.security?.category || ""));
      configSaved = stored !== null;
      rebuildAllocation();
    } catch {
      error = "Could not load imported portfolio holdings.";
    } finally {
      loading = false;
    }
  }

  function number(value: string | null | undefined): number | null {
    if (!validValue(value)) return null;
    const parsed = Number(value!.replaceAll(",", "").trim());
    return Number.isFinite(parsed) ? parsed : null;
  }

  function formatMoney(value: string | number | null | undefined, currency: string | null | undefined): string {
    if (value === null || value === undefined || !currency) return "—";
    const parsed = typeof value === "number" ? value : number(value);
    if (parsed === null) return "—";
    try {
      return new Intl.NumberFormat("en-IN", {
        style: "currency",
        currency,
        maximumFractionDigits: 2
      }).format(parsed);
    } catch {
      return `${parsed} ${currency}`;
    }
  }

  function formatPercent(value: number | null): string {
    return value === null ? "—" : `${value.toFixed(1)}%`;
  }

  function gain(holding: LocalFinanceRecord): number | null {
    const cost = number(holding.cost_basis);
    const value = number(holding.current_value);
    return cost === null || value === null ? null : value - cost;
  }

  function securityName(holding: LocalFinanceRecord): string {
    return (
      holding.security?.name ||
      holding.security?.symbol ||
      holding.security?.identifier ||
      "Unnamed holding"
    );
  }

  function sourceText(holding: LocalFinanceRecord): string {
    return `${holding.source.original_path} · ${holding.source.record_locator}`;
  }

  $: unclassified = allocationByCurrency.flatMap((item) =>
    item.result.unclassifiedHoldings.map((holding) => ({ currency: item.currency, id: holding.id }))
  );
  $: noValueHoldings = holdings.filter((holding) => !validValue(holding.current_value));
  onMount(load);
</script>

<svelte:head><title>Holdings and allocation - Paisa</title></svelte:head>

<section class="section">
  <div class="container is-fluid">
    <div class="level is-align-items-flex-start">
      <div>
        <h1 class="title is-4">Holdings and allocation</h1>
        <p class="subtitle is-6">
          Imported holdings, user-defined asset classes, and an informational rebalance report.
        </p>
      </div>
      <button class="button is-light" on:click={load} disabled={loading}>Refresh</button>
    </div>

    {#if error}<div class="notification is-danger is-light" role="alert">{error}</div>{/if}
    {#each data.warnings as warning}<div class="notification is-warning is-light" role="status">
        {warning}
      </div>{/each}
    {#if loading}
      <div class="box has-text-centered">Loading holdings…</div>
    {:else}
      {#if holdings.length === 0}
        <div class="box">
          <h2 class="title is-5">No imported holdings found</h2>
          <p>
            Import a holdings export to populate the report. Your local target and mapping
            configuration can still be prepared here.
          </p>
        </div>
      {/if}

      <div class="box">
        <div class="level is-align-items-flex-start">
          <div>
            <h2 class="title is-5 mb-1">Allocation configuration</h2>
            <p class="help">
              Saved only in this browser's local storage. Source categories are seeded as editable
              defaults the first time this page loads.
            </p>
          </div>
          <span class="tag is-light">{configSaved ? "Saved locally" : "Not saved yet"}</span>
        </div>

        <h3 class="title is-6 mt-4 mb-2">Mapping</h3>
        <p class="help mb-2">
          Map a source category, an optional exact security, or both to an asset class.
          More-specific security + category mappings take precedence.
        </p>
        <div class="table-container">
          <table class="table is-fullwidth is-striped">
            <thead
              ><tr
                ><th>Source category</th><th>Security (optional)</th><th>Asset class</th><th
                ></th></tr
              ></thead
            >
            <tbody>
              {#each config.mappings as mapping, index}
                <tr>
                  <td
                    ><input
                      class="input"
                      aria-label={`Source category mapping ${index + 1}`}
                      value={mapping.holdingType || ""}
                      on:input={(event) => updateMapping(index, "holdingType", event)}
                    /></td
                  >
                  <td
                    ><input
                      class="input"
                      aria-label={`Security mapping ${index + 1}`}
                      value={mapping.security || ""}
                      on:input={(event) => updateMapping(index, "security", event)}
                    /></td
                  >
                  <td
                    ><input
                      class="input"
                      aria-label={`Asset class mapping ${index + 1}`}
                      value={mapping.assetClass}
                      on:input={(event) => updateMapping(index, "assetClass", event)}
                    /></td
                  >
                  <td
                    ><button
                      class="button is-small is-light"
                      aria-label={`Remove mapping ${index + 1}`}
                      on:click={() => removeMapping(index)}>Remove</button
                    ></td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <button class="button is-small is-link is-light" on:click={addMapping}>Add mapping</button>

        <h3 class="title is-6 mt-5 mb-2">Target percentages</h3>
        <p class="help mb-2">
          Targets must total 100%. They are applied independently to each currency report.
        </p>
        <div class="table-container">
          <table class="table is-fullwidth is-striped">
            <thead
              ><tr><th>Asset class</th><th style="width: 12rem">Target %</th><th></th></tr></thead
            >
            <tbody>
              {#each config.targets as target, index}
                <tr>
                  <td
                    ><input
                      class="input"
                      aria-label={`Target asset class ${index + 1}`}
                      value={target.assetClass}
                      on:input={(event) => updateTarget(index, "assetClass", event)}
                    /></td
                  >
                  <td
                    ><input
                      class="input"
                      aria-label={`Target percentage ${index + 1}`}
                      type="number"
                      min="0"
                      step="0.1"
                      value={target.target}
                      on:input={(event) => updateTarget(index, "target", event)}
                    /></td
                  >
                  <td
                    ><button
                      class="button is-small is-light"
                      aria-label={`Remove target ${index + 1}`}
                      on:click={() => removeTarget(index)}>Remove</button
                    ></td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="buttons">
          <button class="button is-small is-link is-light" on:click={addTarget}>Add target</button>
          <button class="button is-small is-light" on:click={resetConfig}
            >Reset mappings to source categories</button
          >
        </div>
      </div>

      {#if holdings.length > 0}
        {#if noValueHoldings.length}<div class="notification is-info is-light">
            {noValueHoldings.length} holding row(s) have no usable current value and are omitted from
            allocation totals.
          </div>{/if}

        <div class="columns is-multiline">
          {#each allocationByCurrency as item}
            <div class="column is-12">
              <div class="box">
                <div class="level is-align-items-flex-start">
                  <div>
                    <h2 class="title is-6">Rebalancing report · {item.currency}</h2>
                    <p class="help">
                      Actual allocation uses all holdings with a usable value, including
                      unclassified holdings in the denominator.
                    </p>
                  </div>
                  <div class="has-text-right">
                    <div class="is-size-7">Portfolio value</div>
                    <strong>{formatMoney(item.result.totalValue, item.currency)}</strong>
                  </div>
                </div>
                {#if !item.result.targetValidation.valid}
                  <div class="notification is-warning is-light">
                    <strong>Targets need attention.</strong>
                    {item.result.targetValidation.errors.join(" ")}
                  </div>
                {:else if config.targets.length === 0}
                  <div class="notification is-info is-light">
                    Add target percentages to see drift and amount-to-target values.
                  </div>
                {/if}
                {#if item.result.allocations.length === 0}<p>
                    No mapped values or targets available.
                  </p>{/if}
                {#if item.result.allocations.length > 0}
                  <div class="table-container">
                    <table class="table is-fullwidth is-striped">
                      <thead
                        ><tr
                          ><th>Asset class</th><th class="has-text-right">Actual value</th><th
                            class="has-text-right">Actual %</th
                          ><th class="has-text-right">Target %</th><th class="has-text-right"
                            >Drift</th
                          ><th class="has-text-right">Amount to target</th></tr
                        ></thead
                      >
                      <tbody>
                        {#each item.result.allocations as row}
                          <tr>
                            <td>{row.assetClass}</td>
                            <td class="has-text-right"
                              >{formatMoney(row.currentValue, item.currency)}</td
                            >
                            <td class="has-text-right">{formatPercent(row.currentPercentage)}</td>
                            <td class="has-text-right">{formatPercent(row.targetPercentage)}</td>
                            <td class="has-text-right"
                              >{row.driftPercentagePoints === null
                                ? "—"
                                : `${
                                    row.driftPercentagePoints >= 0 ? "+" : ""
                                  }${row.driftPercentagePoints.toFixed(1)} pp`}</td
                            >
                            <td class="has-text-right"
                              >{row.amountToTarget === null
                                ? "—"
                                : `${row.amountToTarget >= 0 ? "Add " : "Reduce "}${formatMoney(
                                    Math.abs(row.amountToTarget),
                                    item.currency
                                  )}`}</td
                            >
                          </tr>
                        {/each}
                      </tbody>
                    </table>
                  </div>
                {/if}
                <p class="help">
                  Classified {formatMoney(item.result.classifiedValue, item.currency)} of {formatMoney(
                    item.result.totalValue,
                    item.currency
                  )}. Amount to target = (portfolio value × target %) − current value; positive
                  means more value would be needed.
                </p>
              </div>
            </div>
          {/each}
        </div>

        {#if unclassified.length}
          <div class="notification is-warning is-light">
            <strong>Unclassified holdings</strong>
            <p>
              These rows have no matching mapping and are excluded from asset-class values, but
              remain in the portfolio denominator.
            </p>
            <ul>
              {#each unclassified as row}<li>
                  {row.id || "Unnamed holding"} · {row.currency}
                </li>{/each}
            </ul>
          </div>
        {/if}

        <div class="box">
          <h2 class="title is-6">Holdings · {holdings.length} rows</h2>
          <div class="table-container">
            <table class="table is-striped is-hoverable is-fullwidth">
              <thead
                ><tr
                  ><th>Security</th><th>Source category</th><th>Units</th><th>Cost</th><th>Value</th
                  ><th>Gain</th><th>Market quote</th><th>Currency</th><th>As of</th><th>Source</th></tr
                ></thead
              >
              <tbody>
                {#each holdings as holding}
                  {@const holdingGain = gain(holding)}
                  {@const quote = cachedPrice(holding)}
                  {@const identifier = marketIdentifier(holding)}
                  <tr>
                    <td>{securityName(holding)}</td>
                    <td>{holding.security?.category || "Unclassified"}</td>
                    <td>{holding.units || "—"}</td>
                    <td>{formatMoney(holding.cost_basis, holding.currency)}</td>
                    <td>{formatMoney(holding.current_value, holding.currency)}</td>
                    <td
                      >{holdingGain === null
                        ? "—"
                        : formatMoney(
                            holdingGain,
                            holding.currency
                          )}{#if holding.total_returns_percent}
                        <span class="is-size-7">({holding.total_returns_percent}%)</span>{/if}</td
                    >
                    <td>
                      {#if quote}
                        <span>{formatMoney(quote.value, quote.currency)}</span>
                        <p class="help">{quote.provider} · as of {quote.as_of.slice(0, 10)} · refreshed {quote.refreshed_at.slice(0, 10)}</p>
                      {/if}
                      {#if identifier}
                        <button class="button is-small is-light mt-1" on:click={() => refreshMarketPrice(holding)} disabled={priceLoading[marketKey(identifier)]}>
                          {priceLoading[marketKey(identifier)] ? "Refreshing…" : "Refresh quote"}
                        </button>
                        {#if priceMessages[marketKey(identifier)]}<p class="help is-danger">{priceMessages[marketKey(identifier)]}</p>{/if}
                      {:else if !quote}<span class="help">Unsupported or missing public symbol</span>{/if}
                    </td>
                    <td>{holding.currency || "—"}</td>
                    <td>{holding.as_of_date || "Not supplied"}</td>
                    <td class="is-size-7">{sourceText(holding)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </div>
      {/if}
    {/if}
  </div>
</section>
