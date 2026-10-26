package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"
)

type fakeNewsProvider struct {
	query   Query
	called  bool
	results []ProviderArticle
	err     error
}

func (p *fakeNewsProvider) Search(_ context.Context, query Query) ([]ProviderArticle, error) {
	p.called = true
	p.query = query
	return p.results, p.err
}

func TestNewPublicNewsIdentifierRejectsPrivatePortfolioData(t *testing.T) {
	tests := []struct {
		name  string
		kind  IdentifierKind
		value string
	}{
		{name: "account path", kind: IdentifierCompany, value: "Assets:Broker:Equity"},
		{name: "currency amount", kind: IdentifierCompany, value: "Acme ₹100000"},
		{name: "units", kind: IdentifierFund, value: "Acme Fund 12 units"},
		{name: "portfolio label", kind: IdentifierSector, value: "my portfolio"},
		{name: "numeric amount ticker", kind: IdentifierTicker, value: "100000"},
		{name: "unsupported kind", kind: IdentifierKind("account"), value: "ACME"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if _, err := NewPublicNewsIdentifier(tt.kind, tt.value); !errors.Is(err, ErrInvalidNewsIdentifier) {
				t.Fatalf("NewPublicNewsIdentifier(%q, %q) error = %v, want ErrInvalidNewsIdentifier", tt.kind, tt.value, err)
			}
		})
	}
}

func TestNewsServiceBuildsPrivacySafeQueryAndStoresDisplayFields(t *testing.T) {
	provider := &fakeNewsProvider{results: []ProviderArticle{{
		Headline:      "Acme announces a new public product",
		Source:        "Example News",
		PublishedAt:   time.Date(2026, time.October, 24, 12, 0, 0, 0, time.UTC),
		Link:          "https://news.example.test/acme-product",
		RelevanceNote: "May affect the company's outlook; review the primary source.",
	}}}
	service := NewNewsService(provider)
	identifier, err := NewPublicNewsIdentifier(IdentifierCompany, "Acme Corporation")
	if err != nil {
		t.Fatal(err)
	}

	items, err := service.Lookup(context.Background(), identifier)
	if err != nil {
		t.Fatal(err)
	}
	if !provider.called {
		t.Fatal("fake provider was not called")
	}
	if provider.query.Identifier != identifier {
		t.Fatalf("query identifier = %#v, want %#v", provider.query.Identifier, identifier)
	}
	// The query has no fields through which local quantities, amounts, or
	// account names could be passed.  Keep this assertion as a regression test
	// if the query shape is ever expanded.
	encodedQuery, err := json.Marshal(provider.query)
	if err != nil {
		t.Fatal(err)
	}
	for _, private := range []string{"100 units", "₹100", "Assets:Broker", "account"} {
		if strings.Contains(string(encodedQuery), private) {
			t.Fatalf("provider query leaked private value %q: %s", private, encodedQuery)
		}
	}

	if len(items) != 1 || len(service.List()) != 1 {
		t.Fatalf("stored items = %d, returned items = %d; want one", len(service.List()), len(items))
	}
	item := items[0]
	if item.Headline != "Acme announces a new public product" || item.Source != "Example News" || item.Link != "https://news.example.test/acme-product" {
		t.Fatalf("display fields not preserved: %#v", item)
	}
	if !item.PublishedAt.Equal(provider.results[0].PublishedAt) {
		t.Fatalf("publication date = %v, want %v", item.PublishedAt, provider.results[0].PublishedAt)
	}
	if item.RelatedIdentifier != identifier || item.RelatedCategory != IdentifierCompany || item.RelevanceNote == "" {
		t.Fatalf("related display metadata not populated: %#v", item)
	}
}

func TestNewsServiceDefaultsMissingRelevanceNote(t *testing.T) {
	provider := &fakeNewsProvider{results: []ProviderArticle{{
		Headline:    "A headline",
		Source:      "A source",
		PublishedAt: time.Date(2026, time.October, 24, 0, 0, 0, 0, time.UTC),
		Link:        "https://example.test/article",
	}}}
	identifier, err := NewPublicNewsIdentifier(IdentifierTicker, "ACME")
	if err != nil {
		t.Fatal(err)
	}
	items, err := NewNewsService(provider).Lookup(context.Background(), identifier)
	if err != nil {
		t.Fatal(err)
	}
	if items[0].RelevanceNote == "" {
		t.Fatal("missing relevance note was not defaulted")
	}
}

func TestNewsServiceRejectsMalformedProviderArticle(t *testing.T) {
	provider := &fakeNewsProvider{results: []ProviderArticle{{
		Headline:    "A headline",
		Source:      "A source",
		PublishedAt: time.Date(2026, time.October, 24, 0, 0, 0, 0, time.UTC),
		Link:        "javascript:alert(1)",
	}}}
	identifier, err := NewPublicNewsIdentifier(IdentifierTicker, "ACME")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewNewsService(provider).Lookup(context.Background(), identifier); !errors.Is(err, ErrInvalidArticle) {
		t.Fatalf("Lookup error = %v, want ErrInvalidArticle", err)
	}
}

func TestNoProviderDoesNotMakeImplicitNetworkRequest(t *testing.T) {
	identifier, err := NewPublicNewsIdentifier(IdentifierTicker, "ACME")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := NewNewsService(nil).Lookup(context.Background(), identifier); !errors.Is(err, ErrProviderUnavailable) {
		t.Fatalf("Lookup error = %v, want ErrProviderUnavailable", err)
	}
}

func TestNewQueryValidatesDirectProviderBoundary(t *testing.T) {
	_, err := NewQuery(PublicNewsIdentifier{Kind: IdentifierCompany, Value: "Assets:Broker"})
	if !errors.Is(err, ErrInvalidNewsIdentifier) {
		t.Fatalf("NewQuery error = %v, want ErrInvalidNewsIdentifier", err)
	}
}
