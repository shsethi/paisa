<script lang="ts">
  import { onMount } from "svelte";
  import {
    ajax,
    type LocalICICIImport,
    type LocalImportedBankTransaction
  } from "$lib/utils";

  let transactions: LocalImportedBankTransaction[] = [];
  let imports: LocalICICIImport[] = [];
  let warnings: string[] = [];
  let search = "";
  let categoryFilter = "all";
  let reviewFilter = "all";
  let loading = true;
  let loadError = "";

  async function loadTransactions() {
    loading = true;
    loadError = "";
    try {
      const result = await ajax("/api/finance/icici/transactions");
      transactions = result.transactions;
      imports = result.imports;
      warnings = result.warnings;
    } catch {
      loadError = "Could not load local imported transactions.";
    } finally {
      loading = false;
    }
  }

  onMount(loadTransactions);

  $: categoryOptions = Array.from(
    new Set(transactions.map((transaction) => transaction.category || "uncategorized"))
  ).sort();

  $: filteredTransactions = transactions.filter((transaction) => {
    const category = transaction.category || "uncategorized";
    const matchesCategory = categoryFilter === "all" || category === categoryFilter;
    const matchesReview = reviewFilter === "all" || transaction.review_status === reviewFilter;
    const query = search.trim().toLocaleLowerCase();
    const matchesSearch =
      !query ||
      transaction.description.toLocaleLowerCase().includes(query) ||
      transaction.source.original_path.toLocaleLowerCase().includes(query) ||
      transaction.source.record_locator.toLocaleLowerCase().includes(query);
    return matchesCategory && matchesReview && matchesSearch;
  });

  function decimalScale(value: string): number {
    return value.split(".")[1]?.length || 0;
  }

  function decimalUnits(value: string, scale: number): bigint {
    const negative = value.startsWith("-");
    const unsigned = negative ? value.slice(1) : value;
    const [whole, fraction = ""] = unsigned.split(".");
    const units = BigInt(`${whole}${fraction.padEnd(scale, "0")}`);
    return negative ? -units : units;
  }

  function formatUnits(units: bigint, scale: number): string {
    const negative = units < 0n;
    const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
    const whole = scale ? digits.slice(0, -scale) : digits;
    const fraction = scale ? digits.slice(-scale) : "";
    const grouped = BigInt(whole).toLocaleString("en-IN");
    return `₹${negative ? "−" : ""}${grouped}${scale ? `.${fraction}` : ""}`;
  }

  function sumAmounts(values: string[]): string {
    const scale = values.reduce((max, value) => Math.max(max, decimalScale(value)), 0);
    const total = values.reduce((sum, value) => sum + decimalUnits(value, scale), 0n);
    return formatUnits(total, scale);
  }

  function categoryTotal(classification: string, side: "debit" | "credit" | "either") {
    const values = transactions
      .filter((transaction) => transaction.classification === classification)
      .map((transaction) => {
        if (side === "debit") return transaction.debit;
        if (side === "credit") return transaction.credit;
        return transaction.debit ?? transaction.credit;
      })
      .filter((value): value is string => value !== null);
    return sumAmounts(values);
  }

  $: totals = [
    { label: "Income", value: categoryTotal("income", "credit") },
    { label: "Spending", value: categoryTotal("spending", "debit") },
    { label: "Transfers", value: categoryTotal("transfer", "either") },
    { label: "Investments", value: categoryTotal("investment", "either") }
  ];

  function formatAmount(value: string | null, currency: string): string {
    if (value === null) return "—";
    const scale = decimalScale(value);
    const formatted = formatUnits(decimalUnits(value, scale), scale);
    return currency === "INR" ? formatted : `${value} ${currency}`;
  }

  function categoryLabel(transaction: LocalImportedBankTransaction): string {
    return (transaction.category || "Uncategorized").replaceAll("_", " ");
  }
</script>

<svelte:head>
  <title>Imported transactions - Paisa</title>
</svelte:head>

<section class="section">
  <div class="container is-fluid">
    <div class="level is-align-items-flex-start">
      <div class="level-left">
        <div>
          <h1 class="title is-4">Imported transactions</h1>
          <p class="subtitle is-6">Local ICICI statement imports, linked to their original file and row.</p>
        </div>
      </div>
      <div class="level-right">
        <button class="button is-light" on:click={loadTransactions} disabled={loading}>
          <span class="icon"><i class="fas fa-rotate-right" aria-hidden="true" /></span>
          <span>Refresh</span>
        </button>
      </div>
    </div>

    {#if loadError}
      <div class="notification is-danger is-light" role="alert">{loadError}</div>
    {/if}

    {#each warnings as warning}
      <div class="notification is-warning is-light" role="status">{warning}</div>
    {/each}

    {#if loading}
      <div class="box has-text-centered">Loading local imports…</div>
    {:else if imports.length === 0}
      <div class="box">
        <h2 class="title is-5">No ICICI imports found</h2>
        <p>Import a statement from the workspace with:</p>
        <pre class="mt-3"><code>cd paisa &amp;&amp; npm run finance:import-icici -- --file "banking/icici/&lt;statement&gt;.xls"</code></pre>
      </div>
    {:else}
      <div class="columns is-multiline mb-2">
        <div class="column is-12">
          <div class="box py-3">
            <div class="columns is-mobile is-multiline is-vcentered">
              <div class="column is-12-mobile is-3-tablet">
                <p class="heading">Visible transactions</p>
                <p class="title is-5">{filteredTransactions.length}</p>
              </div>
              {#each totals as total}
                <div class="column is-6-mobile is-2-tablet">
                  <p class="heading">{total.label}</p>
                  <p class="title is-6">{total.value}</p>
                </div>
              {/each}
            </div>
            <p class="help">Totals include classified records only; uncategorized transactions are excluded.</p>
          </div>
        </div>
        <div class="column is-12">
          <div class="box py-3">
            <div class="columns is-multiline is-vcentered">
              <div class="column is-12-mobile is-5-tablet">
                <label class="label" for="transaction-search">Search</label>
                <input
                  id="transaction-search"
                  class="input"
                  type="search"
                  bind:value={search}
                  placeholder="Description, source file, or row"
                />
              </div>
              <div class="column is-6-mobile is-3-tablet">
                <label class="label" for="transaction-category">Category</label>
                <div class="select is-fullwidth">
                  <select id="transaction-category" bind:value={categoryFilter}>
                    <option value="all">All categories</option>
                    {#each categoryOptions as category}
                      <option value={category}>{category.replaceAll("_", " ")}</option>
                    {/each}
                  </select>
                </div>
              </div>
              <div class="column is-6-mobile is-3-tablet">
                <label class="label" for="transaction-review">Review state</label>
                <div class="select is-fullwidth">
                  <select id="transaction-review" bind:value={reviewFilter}>
                    <option value="all">All states</option>
                    <option value="needs_review">Needs review</option>
                    <option value="reviewed">Reviewed</option>
                  </select>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="box p-0" style="overflow-x: auto">
        <table class="table is-fullwidth is-hoverable mb-0">
          <thead>
            <tr>
              <th>Date</th>
              <th>Description</th>
              <th>Category</th>
              <th class="has-text-right">Debit</th>
              <th class="has-text-right">Credit</th>
              <th class="has-text-right">Balance</th>
              <th>Source</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {#each filteredTransactions as transaction, index (`${transaction.source.original_path}:${transaction.source.record_locator}:${index}`)}
              <tr>
                <td class="is-nowrap">{transaction.date}</td>
                <td class="description-cell">
                  <div>{transaction.description}</div>
                  <p class="help">{transaction.classification_detail.reason}</p>
                </td>
                <td>
                  <span class="tag is-light">{categoryLabel(transaction)}</span>
                  {#if transaction.classification_detail.review_needed}
                    <p class="help">Review classification</p>
                  {/if}
                </td>
                <td class="has-text-right is-nowrap">{formatAmount(transaction.debit, transaction.currency)}</td>
                <td class="has-text-right is-nowrap">{formatAmount(transaction.credit, transaction.currency)}</td>
                <td class="has-text-right is-nowrap">{formatAmount(transaction.balance, transaction.currency)}</td>
                <td>
                  <div>{transaction.source.original_path}</div>
                  <p class="help is-family-monospace">{transaction.source.record_locator}</p>
                </td>
                <td>
                  <span class="tag {transaction.review_status === 'needs_review' ? 'is-warning' : 'is-success'} is-light">
                    {transaction.review_status === "needs_review" ? "Needs review" : "Reviewed"}
                  </span>
                </td>
              </tr>
            {:else}
              <tr><td colspan="8" class="has-text-centered p-5">No transactions match these filters.</td></tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="content mt-5">
        <h2 class="title is-6">Imported sources</h2>
        <ul>
          {#each imports as importedSource}
            <li>
              <span class="is-family-monospace">{importedSource.original_path}</span>
              — {importedSource.row_counts.accepted} accepted,
              {importedSource.row_counts.rejected} rejected,
              {importedSource.row_counts.skipped} skipped
              ({importedSource.status.replaceAll("_", " ")})
              — imported {new Date(importedSource.imported_at).toLocaleString()}
              {#if !importedSource.source_current}<span class="tag is-warning is-light ml-2">Source changed</span>{/if}
              {#if importedSource.error_count > 0}<span class="tag is-danger is-light ml-2">{importedSource.error_count} import errors</span>{/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</section>

<style>
  .description-cell {
    min-width: 24rem;
    max-width: 42rem;
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .is-nowrap {
    white-space: nowrap;
  }

  pre {
    overflow-x: auto;
  }
</style>
