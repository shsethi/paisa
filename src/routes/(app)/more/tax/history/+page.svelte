<script lang="ts">
  import { onMount } from "svelte";
  import { ajax, type LocalTaxHistory, type LocalTaxReturn } from "$lib/utils";

  let data: LocalTaxHistory = { returns: [], ais: [], annual_tax_credits: [], form16: [], form26as: [], imports: [], warnings: [] };
  let loading = true;
  let error = "";

  async function load() {
    loading = true;
    try { data = await ajax("/api/finance/tax/history"); }
    catch { error = "Could not load local tax summaries."; }
    finally { loading = false; }
  }
  function amount(value: number): string {
    return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 }).format(value);
  }
  function year(record: LocalTaxReturn): string {
    return record.record.identity.financialYear?.value || "Financial year not supplied";
  }
  $: years = [...new Set(data.returns.map(year))].sort((a, b) => b.localeCompare(a));
  $: coverage = (() => {
    const rows = new Map<string, { financialYear: string; returns: number; aisFacts: number }>();
    const add = (financialYear: string) => {
      if (!rows.has(financialYear)) rows.set(financialYear, { financialYear, returns: 0, aisFacts: 0 });
      return rows.get(financialYear)!;
    };
    data.returns.forEach((item) => { const financialYear = year(item); if (financialYear !== "Financial year not supplied") add(financialYear).returns += 1; });
    data.ais.forEach((item) => { const financialYear = item.record.identity.financialYear?.value; if (financialYear) add(financialYear).aisFacts += item.record.facts.length; });
    return [...rows.values()].sort((a, b) => a.financialYear.localeCompare(b.financialYear));
  })();
  $: maximumAisFacts = Math.max(1, ...coverage.map((row) => row.aisFacts));
  $: latestReturns = (() => {
    const latest = new Map<string, LocalTaxReturn>();
    for (const item of data.returns) {
      const financialYear = year(item);
      if (financialYear === "Financial year not supplied") continue;
      const previous = latest.get(financialYear);
      if (!previous || item.imported_at > previous.imported_at) latest.set(financialYear, item);
    }
    return [...latest.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([financialYear, item]) => ({ financialYear, item }));
  })();
  $: incomeAndTax = latestReturns.map(({ financialYear, item }) => ({
      financialYear,
      income: item.record.incomeHeads.find((row) => row.key === "totalIncome")?.value ?? null,
      taxPaid: item.record.taxes.find((row) => row.key === "totalTaxesPaid")?.value ?? null
    })).filter((row) => row.income !== null || row.taxPaid !== null);
  $: maximumIncomeOrTax = Math.max(1, ...incomeAndTax.flatMap((row) => [row.income ?? 0, row.taxPaid ?? 0]));
  $: combinedSummary = (() => {
    const sum = (selector: (item: LocalTaxReturn) => number | undefined) => {
      const available = latestReturns.map(({ item }) => selector(item)).filter((value): value is number => value !== undefined);
      return { value: available.reduce((total, value) => total + value, 0), count: available.length };
    };
    const income = (key: string) => sum((item) => item.record.incomeHeads.find((row) => row.key === key)?.value);
    const tax = (key: string) => sum((item) => item.record.taxes.find((row) => row.key === key)?.value);
    // The normalized ITR parsers expose the overall gains figure in income
    // heads. The capital-gains group contains schedule-level detail and is
    // not present in older returns.
    const gains = income("capitalGains");
    return [
      { label: "Total income", ...income("totalIncome") },
      { label: "Salary income", ...income("salary") },
      { label: "Capital gains", ...gains },
      { label: "Tax paid", ...tax("totalTaxesPaid") },
      { label: "TDS", ...tax("tds") },
      { label: "Refund claimed", ...tax("refundDue") }
    ];
  })();
  onMount(load);
</script>

<svelte:head><title>Tax history - Paisa</title></svelte:head>

<section class="section">
  <div class="container is-fluid">
    <div class="level">
      <div><h1 class="title is-4">Tax history</h1><p class="subtitle is-6">ITR, AIS, and withholding facts from local imports, with source paths and no automatic source merging.</p></div>
      <button class="button is-light" on:click={load} disabled={loading}>Refresh</button>
    </div>
    {#if error}<div class="notification is-danger is-light" role="alert">{error}</div>{/if}
    {#each data.warnings as warning}<div class="notification is-warning is-light" role="status">{warning}</div>{/each}
    {#if !loading && coverage.length}
      {#if combinedSummary.length}
        <section class="box" aria-labelledby="combined-summary-title">
          <h2 id="combined-summary-title" class="title is-5">Combined ITR summary</h2>
          <p class="help mb-4">Totals use the latest imported ITR for each financial year; a metric is summed only where that return supplied it.</p>
          <div class="columns is-multiline">
            {#each combinedSummary as metric}
              <div class="column is-6-mobile is-4-tablet is-2-desktop">
                <div class="box is-shadowless has-background-light summary-metric">
                  <p class="heading">{metric.label}</p>
                  <p class="title is-6">₹{amount(metric.value)}</p>
                  <p class="help">{metric.count} of {latestReturns.length} years</p>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}
      {#if incomeAndTax.length}
        <section class="box tax-bars" aria-labelledby="income-tax-title">
          <h2 id="income-tax-title" class="title is-5">Income and tax paid</h2>
          <p class="help mb-4">Latest imported ITR per financial year. Income is total income; tax paid includes reported TDS, advance tax, and self-assessment tax.</p>
          <div class="bar-legend" aria-hidden="true"><span><i class="income-swatch"></i>Income</span><span><i class="tax-swatch"></i>Tax paid</span></div>
          <div class="tax-bar-chart" role="img" aria-label="Income and tax paid by financial year">
            {#each incomeAndTax as row}
              <div class="tax-bar-row">
                <span class="tax-bar-year">{row.financialYear}</span>
                <div class="tax-bar-measures">
                  <div class="tax-bar-measure"><span class="tax-bar-label">Income</span><div class="tax-bar-track"><div class="tax-bar income-bar" style={`width: ${((row.income ?? 0) / maximumIncomeOrTax) * 100}%`}></div></div><span class="tax-bar-value">{row.income === null ? "—" : `₹${amount(row.income)}`}</span></div>
                  <div class="tax-bar-measure"><span class="tax-bar-label">Tax paid</span><div class="tax-bar-track"><div class="tax-bar paid-bar" style={`width: ${((row.taxPaid ?? 0) / maximumIncomeOrTax) * 100}%`}></div></div><span class="tax-bar-value">{row.taxPaid === null ? "—" : `₹${amount(row.taxPaid)}`}</span></div>
                </div>
              </div>
            {/each}
          </div>
        </section>
      {/if}
      <section class="box tax-coverage" aria-labelledby="tax-coverage-title">
        <h2 id="tax-coverage-title" class="title is-5">Tax data coverage</h2>
        <p class="help mb-4">AIS fact counts show source coverage, not taxable income or tax due.</p>
        <div class="coverage-chart" role="img" aria-label="AIS import coverage by financial year">
          {#each coverage as row}
            <div class="coverage-row">
              <span class="coverage-year">{row.financialYear}</span>
              <div class="coverage-track" aria-hidden="true"><div class="coverage-bar" style={`width: ${(row.aisFacts / maximumAisFacts) * 100}%`}></div></div>
              <span class="coverage-value">{row.aisFacts} AIS facts</span>
              <span class:hasReturn={row.returns > 0} class="coverage-return">{row.returns ? "ITR imported" : "No ITR import"}</span>
            </div>
          {/each}
        </div>
      </section>
    {/if}
    {#if loading}
      <div class="box has-text-centered">Loading local tax records…</div>
    {:else if data.returns.length === 0}
      {#if data.annual_tax_credits.length === 0 && data.ais.length === 0}<div class="box"><h2 class="title is-5">No imported tax records</h2><p>Import an ITR JSON/XML return, AIS JSON file, or an Annual Tax Statement workbook.</p></div>{/if}
    {:else}
      {#each years as financialYear}
        <section class="box">
          <h2 class="title is-5">{financialYear}</h2>
          {#each data.returns.filter((record) => year(record) === financialYear) as item}
            <article class="box is-shadowless has-background-light">
              <div class="columns is-multiline is-mobile">
                <div class="column is-6"><p class="heading">Return source</p><p>{item.source_type.replace(/^itr(?:_return)?_/, "ITR ")}</p></div>
                <div class="column is-6"><p class="heading">Filing version</p><p>{item.record.identity.filingVersion}</p></div>
                <div class="column is-6"><p class="heading">Assessment year</p><p>{item.record.identity.assessmentYear?.value || "Not supplied"}</p></div>
                <div class="column is-6"><p class="heading">Tax regime</p><p>{item.record.identity.regime?.value || "Not supplied"}</p></div>
                <div class="column is-12"><p class="heading">Original source</p><p class="is-size-7">{item.original_path} · {item.status}</p></div>
              </div>
              {#each [
                { title: "Income", rows: item.record.incomeHeads },
                { title: "Deductions", rows: item.record.deductions },
                { title: "Tax paid / payable", rows: item.record.taxes },
                { title: "Capital gains", rows: item.record.capitalGains }
              ] as group}
                {#if group.rows.length}
                  <h3 class="title is-6 mt-4">{group.title}</h3>
                  <div class="table-container">
                    <table class="table is-narrow is-fullwidth">
                      <thead><tr><th>Field</th><th class="has-text-right">Source value (₹)</th><th>Source field path</th></tr></thead>
                      <tbody>{#each group.rows as row}<tr><td>{row.key}</td><td class="has-text-right">{amount(row.value)}</td><td class="is-size-7">{row.sourcePath}</td></tr>{/each}</tbody>
                    </table>
                  </div>
                {/if}
              {/each}
            </article>
          {/each}
        </section>
      {/each}
    {/if}
    {#if !loading && data.ais.length}
      <div class="box">
        <h2 class="title is-5">Annual Information Statement (AIS)</h2>
        <p class="help mb-3">AIS facts are independent source records for review and reconciliation; they do not change ITR totals.</p>
        {#each data.ais as item}
          <article class="box is-shadowless has-background-light">
            <p class="is-size-7 mb-3"><strong>{item.record.identity.financialYear?.value || "Financial year not supplied"}</strong> · Assessment year: {item.record.identity.assessmentYear?.value || "Not supplied"} · {item.original_path} · {item.status}</p>
            {#if item.record.facts.length}
              <div class="table-container"><table class="table is-striped is-narrow is-fullwidth">
                <thead><tr><th>Category</th><th>Description</th><th>Date</th><th class="has-text-right">Amount</th><th class="has-text-right">Tax deducted</th><th class="has-text-right">Tax collected</th><th>Source path</th></tr></thead>
                <tbody>{#each item.record.facts as fact}<tr>
                  <td>{fact.category}</td><td>{fact.description?.value || "—"}</td><td>{fact.date?.value || "—"}</td>
                  <td class="has-text-right">{fact.amount ? amount(fact.amount.value) : "—"}</td><td class="has-text-right">{fact.taxDeducted ? amount(fact.taxDeducted.value) : "—"}</td><td class="has-text-right">{fact.taxCollected ? amount(fact.taxCollected.value) : "—"}</td><td class="is-size-7">{fact.sourcePath}</td>
                </tr>{/each}</tbody>
              </table></div>
            {:else}<p>No usable AIS facts were emitted by this import.</p>{/if}
          </article>
        {/each}
      </div>
    {/if}
    {#if !loading && data.annual_tax_credits.length}
      <div class="box">
        <h2 class="title is-5">Annual Tax Statement credits</h2>
        <p class="help mb-3">These withholding credits remain separate from ITR figures. A blank value means the source did not supply it.</p>
        <div class="table-container"><table class="table is-striped is-narrow is-fullwidth">
          <thead><tr><th>Financial year</th><th>Section</th><th>Date</th><th class="has-text-right">Amount credited</th><th class="has-text-right">Tax deducted</th><th class="has-text-right">Tax deposited</th><th>Source row</th></tr></thead>
          <tbody>{#each data.annual_tax_credits as credit}<tr>
            <td>{credit.financial_year || credit.reported_period_label || "Not supplied"}</td><td>{credit.section_code || "Not supplied"}</td><td>{credit.transaction_date || "Not supplied"}</td>
            <td class="has-text-right">{credit.amount_credited === null ? "—" : `${amount(Number(credit.amount_credited))} ${credit.currency}`}</td>
            <td class="has-text-right">{credit.tax_deducted === null ? "—" : `${amount(Number(credit.tax_deducted))} ${credit.currency}`}</td>
            <td class="has-text-right">{credit.tax_deposited === null ? "—" : `${amount(Number(credit.tax_deposited))} ${credit.currency}`}</td>
            <td class="is-size-7">{credit.source.original_path} · {credit.source.record_locator}</td>
          </tr>{/each}</tbody>
        </table></div>
      </div>
    {/if}
    {#if !loading && data.form16.length}
      <div class="box">
        <h2 class="title is-5">Form 16 summaries</h2>
        <p class="help mb-3">Only reconciled Part B summary fields are shown. Values retain page-coordinate provenance.</p>
        {#each data.form16 as item}
          <h3 class="title is-6">{item.record.financial_year} · {item.original_path}</h3>
          <div class="table-container"><table class="table is-striped is-narrow is-fullwidth"><thead><tr><th>Field</th><th class="has-text-right">Value (INR)</th><th>Source</th></tr></thead><tbody>
            {#each item.record.fields as field}<tr><td>{field.label}</td><td class="has-text-right">{amount(Number(field.value))}</td><td class="is-size-7">page {field.source_page} · {field.record_locator}</td></tr>{/each}
          </tbody></table></div>
        {/each}
      </div>
    {/if}
    {#if !loading && data.form26as.length}
      <div class="box">
        <h2 class="title is-5">Historical Form 26AS summaries</h2>
        <p class="help mb-3">Deductor-level totals only; detailed PDF transaction rows are intentionally not inferred.</p>
        <div class="table-container"><table class="table is-striped is-narrow is-fullwidth"><thead><tr><th>Financial year</th><th class="has-text-right">Deductors</th><th class="has-text-right">Amount paid</th><th class="has-text-right">Tax deducted</th><th class="has-text-right">Tax deposited</th><th>Source</th></tr></thead><tbody>
          {#each data.form26as as item}<tr><td>{item.record.financial_year}</td><td class="has-text-right">{item.record.deductors.length}</td><td class="has-text-right">{amount(Number(item.record.totals.amount_paid))}</td><td class="has-text-right">{amount(Number(item.record.totals.tax_deducted))}</td><td class="has-text-right">{amount(Number(item.record.totals.tax_deposited))}</td><td class="is-size-7">{item.original_path}</td></tr>{/each}
        </tbody></table></div>
      </div>
    {/if}
    <div class="box">
      <h2 class="title is-6">Tax source freshness</h2>
      {#each data.imports as item}<p class="is-size-7">{item.source_type} · {item.original_path} · {item.status} · {item.source_current ? "source current" : "source stale or unavailable"}</p>{/each}
    </div>
  </div>
</section>

<style>
  .coverage-chart { display: grid; gap: 0.75rem; }
  .summary-metric { height: 100%; }
  .coverage-row { display: grid; grid-template-columns: 5.5rem minmax(5rem, 1fr) 6.5rem 6.5rem; gap: 0.75rem; align-items: center; }
  .coverage-year, .coverage-value, .coverage-return { font-variant-numeric: tabular-nums; }
  .coverage-track { height: 0.7rem; background: rgba(127, 127, 127, 0.2); border-radius: 999px; overflow: hidden; }
  .coverage-bar { height: 100%; min-width: 0.25rem; background: var(--primary); border-radius: inherit; }
  .coverage-return { color: var(--text-weak, #777); }
  .coverage-return.hasReturn { color: var(--success, #2e8b57); }
  .bar-legend { display: flex; gap: 1rem; margin-bottom: 0.75rem; font-size: 0.875rem; }
  .bar-legend span { display: inline-flex; align-items: center; gap: 0.35rem; }
  .bar-legend i { width: 0.7rem; height: 0.7rem; border-radius: 2px; }
  .income-swatch, .income-bar { background: var(--primary); }
  .tax-swatch, .paid-bar { background: var(--link, #485fc7); }
  .tax-bar-chart { display: grid; gap: 1rem; }
  .tax-bar-row { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); gap: 0.75rem; align-items: start; }
  .tax-bar-measures { display: grid; gap: 0.4rem; }
  .tax-bar-measure { display: grid; grid-template-columns: 4.5rem minmax(4rem, 1fr) 8rem; gap: 0.5rem; align-items: center; }
  .tax-bar-track { height: 0.7rem; background: rgba(127, 127, 127, 0.2); border-radius: 999px; overflow: hidden; }
  .tax-bar { height: 100%; min-width: 0; border-radius: inherit; }
  .tax-bar-value { text-align: right; font-variant-numeric: tabular-nums; }
  @media (max-width: 640px) {
    .coverage-row { grid-template-columns: 4.75rem minmax(4rem, 1fr); gap: 0.4rem 0.75rem; }
    .coverage-value, .coverage-return { grid-column: 2; }
    .tax-bar-row { grid-template-columns: 1fr; gap: 0.4rem; }
    .tax-bar-measure { grid-template-columns: 4.25rem minmax(3rem, 1fr); }
    .tax-bar-value { grid-column: 2; text-align: left; }
  }
</style>
