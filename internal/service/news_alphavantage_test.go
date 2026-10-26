package service

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
)

func TestAlphaVantageNewsProviderUsesOnlyTickerOrTopic(t *testing.T) {
	provider := NewAlphaVantageNewsProvider("test-key")
	if !provider.Supports(PublicNewsIdentifier{Kind: IdentifierTicker, Value: "IBM"}) {
		t.Fatal("ticker should be supported")
	}
	if !provider.Supports(PublicNewsIdentifier{Kind: IdentifierSector, Value: "Technology"}) {
		t.Fatal("supported sector should be supported")
	}
	if provider.Supports(PublicNewsIdentifier{Kind: IdentifierCompany, Value: "IBM"}) || provider.Supports(PublicNewsIdentifier{Kind: IdentifierFund, Value: "Example Fund"}) {
		t.Fatal("company and fund values must not be sent to Alpha Vantage NEWS_SENTIMENT")
	}

	provider.Client = newsResponseClient(func(r *http.Request) string {
		query := r.URL.Query()
		if query.Get("function") != "NEWS_SENTIMENT" || query.Get("apikey") != "test-key" || query.Get("tickers") != "IBM" || query.Get("topics") != "" {
			t.Fatalf("unexpected ticker query: %s", r.URL.String())
		}
		if query.Get("units") != "" || query.Get("amount") != "" || query.Get("account") != "" {
			t.Fatalf("private query parameter leaked: %s", r.URL.String())
		}
		return `{"feed":[{"title":"IBM public update","url":"https://news.example.test/ibm","time_published":"20261024T120000","source":"Example News","overall_sentiment_label":"Neutral"}]}`
	})
	provider.BaseURL = "https://provider.invalid/query"

	identifier, err := NewPublicNewsIdentifier(IdentifierTicker, "IBM")
	if err != nil {
		t.Fatal(err)
	}
	articles, err := provider.Search(context.Background(), Query{Identifier: identifier})
	if err != nil {
		t.Fatal(err)
	}
	if len(articles) != 1 || articles[0].Source != "Example News" || articles[0].PublishedAt.IsZero() {
		t.Fatalf("unexpected provider response: %#v", articles)
	}
}

func TestAlphaVantageNewsProviderMapsSectorTopic(t *testing.T) {
	provider := NewAlphaVantageNewsProvider("test-key")
	provider.Client = newsResponseClient(func(r *http.Request) string {
		query := r.URL.Query()
		if query.Get("topics") != "real_estate" || query.Get("tickers") != "" {
			t.Fatalf("unexpected sector query: %s", r.URL.String())
		}
		return `{"feed":[]}`
	})
	provider.BaseURL = "https://provider.invalid/query"
	identifier, err := NewPublicNewsIdentifier(IdentifierSector, "Real Estate & Construction")
	if err != nil {
		t.Fatal(err)
	}
	articles, err := provider.Search(context.Background(), Query{Identifier: identifier})
	if err != nil || len(articles) != 0 {
		t.Fatalf("sector search = %#v, %v", articles, err)
	}
}

func TestAlphaVantageNewsProviderDoesNotCallWithoutKey(t *testing.T) {
	provider := NewAlphaVantageNewsProvider("")
	called := false
	provider.Client = &http.Client{Transport: roundTripNewsFunc(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, errors.New("unexpected network call")
	})}
	identifier, err := NewPublicNewsIdentifier(IdentifierTicker, "IBM")
	if err != nil {
		t.Fatal(err)
	}
	_, err = provider.Search(context.Background(), Query{Identifier: identifier})
	if !errors.Is(err, ErrProviderUnavailable) || called {
		t.Fatalf("missing key error = %v, network called = %v", err, called)
	}
}

func TestAlphaVantageNewsProviderRejectsProviderErrorPayload(t *testing.T) {
	provider := NewAlphaVantageNewsProvider("test-key")
	provider.Client = newsResponseClient(func(*http.Request) string { return `{"Information":"premium function"}` })
	provider.BaseURL = "https://provider.invalid/query"
	identifier, err := NewPublicNewsIdentifier(IdentifierTicker, "IBM")
	if err != nil {
		t.Fatal(err)
	}
	_, err = provider.Search(context.Background(), Query{Identifier: identifier})
	if err == nil || !strings.Contains(err.Error(), "premium function") {
		t.Fatalf("error = %v, want provider payload error", err)
	}
}

func TestAlphaVantageNewsResponseShapeRemainsPublic(t *testing.T) {
	request := Query{Identifier: PublicNewsIdentifier{Kind: IdentifierTicker, Value: "IBM"}}
	encoded, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(encoded), "amount") || strings.Contains(string(encoded), "units") || strings.Contains(string(encoded), "account") {
		t.Fatalf("private fields present in request: %s", encoded)
	}
}

type roundTripNewsFunc func(*http.Request) (*http.Response, error)

func (f roundTripNewsFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return f(request)
}

func newsResponseClient(response func(*http.Request) string) *http.Client {
	return &http.Client{Transport: roundTripNewsFunc(func(request *http.Request) (*http.Response, error) {
		return &http.Response{
			StatusCode: http.StatusOK,
			Header:     make(http.Header),
			Body:       io.NopCloser(strings.NewReader(response(request))),
			Request:    request,
		}, nil
	})}
}
