<script lang="ts">
  import { onMount } from "svelte";
  import { ajax } from "$lib/utils";

  type NewsKind = "ticker" | "sector";
  type NewsItem = {
    headline: string;
    source: string;
    publishedAt: string;
    link: string;
    relatedIdentifier: { kind: string; value: string };
    relatedCategory: string;
    relevanceNote: string;
  };
  type NewsStatus = { configured: boolean; provider: string; premium: boolean };

  let status: NewsStatus = { configured: false, provider: "Alpha Vantage NEWS_SENTIMENT", premium: true };
  let items: NewsItem[] = [];
  let kind: NewsKind = "ticker";
  let value = "";
  let loading = true;
  let searching = false;
  let error = "";

  async function load() {
    loading = true;
    error = "";
    try {
      status = await ajax("/api/news/status");
      const response = await ajax("/api/news");
      items = response.items || [];
    } catch {
      error = "Could not load public news status.";
    } finally {
      loading = false;
    }
  }

  async function search() {
    const trimmed = value.trim();
    if (!trimmed || !status.configured) return;
    searching = true;
    error = "";
    try {
      const response = await ajax("/api/news/search", {
        method: "POST",
        body: JSON.stringify({ kind, value: trimmed })
      });
      if (response.error) {
        error = response.error;
        return;
      }
      items = response.items || [];
    } catch {
      error = "Public news lookup failed. Check the identifier and provider configuration.";
    } finally {
      searching = false;
    }
  }

  onMount(load);
</script>

<svelte:head><title>Public news - Paisa</title></svelte:head>

<section class="section">
  <div class="container is-fluid">
    <div class="level">
      <div>
        <h1 class="title is-4">Public investment news</h1>
        <p class="subtitle is-6">Search by a public ticker or supported sector only.</p>
      </div>
      <button class="button is-light" on:click={load} disabled={loading}>Refresh</button>
    </div>

    {#if error}<div class="notification is-danger is-light" role="alert">{error}</div>{/if}
    {#if !status.configured}
      <div class="notification is-warning is-light" role="status">
        Public news is disabled. Set <code>ALPHAVANTAGE_API_KEY</code> to enable Alpha Vantage NEWS_SENTIMENT.
        This endpoint is premium and optional; no network request is made while it is unconfigured.
      </div>
    {/if}

    <div class="box">
      <h2 class="title is-6">Lookup</h2>
      <div class="field is-grouped is-align-items-flex-end">
        <div class="control">
          <label class="label" for="news-kind">Identifier type</label>
          <div class="select">
            <select id="news-kind" bind:value={kind} disabled={!status.configured || searching}>
              <option value="ticker">Ticker</option>
              <option value="sector">Sector</option>
            </select>
          </div>
        </div>
        <div class="control is-expanded">
          <label class="label" for="news-value">Public identifier</label>
          <input id="news-value" class="input" bind:value type="text" placeholder={kind === "ticker" ? "IBM" : "technology"} disabled={!status.configured || searching} />
        </div>
        <div class="control">
          <button class="button is-primary" on:click={search} disabled={!status.configured || searching || !value.trim()}>{searching ? "Searching…" : "Search"}</button>
        </div>
      </div>
      <p class="help">Only kind/value are submitted. Do not enter account names, amounts, balances, units, or holdings.</p>
    </div>

    {#if loading}
      <div class="box has-text-centered">Loading news…</div>
    {:else if items.length === 0}
      <div class="box"><h2 class="title is-5">No public news results</h2><p>Search for a ticker or supported sector after configuring the optional provider.</p></div>
    {:else}
      <div class="box">
        <h2 class="title is-6">Results · {items.length}</h2>
        <div class="table-container">
          <table class="table is-striped is-hoverable is-fullwidth">
            <thead><tr><th>Headline</th><th>Source</th><th>Publication date</th><th>Related identifier</th><th>Relevance</th></tr></thead>
            <tbody>
              {#each items as item}
                <tr>
                  <td><a href={item.link} target="_blank" rel="noreferrer">{item.headline}</a></td>
                  <td>{item.source}</td>
                  <td>{item.publishedAt ? new Date(item.publishedAt).toLocaleString() : "—"}</td>
                  <td>{item.relatedIdentifier?.kind}: {item.relatedIdentifier?.value}</td>
                  <td>{item.relevanceNote}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  </div>
</section>
