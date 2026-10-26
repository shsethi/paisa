package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// AlphaVantageNewsProvider implements Alpha Vantage's NEWS_SENTIMENT endpoint.
// NEWS_SENTIMENT is a premium endpoint; callers must opt in by constructing
// this provider with an API key. The provider accepts only ticker and sector
// identifiers because those map directly to the endpoint's public `tickers`
// and `topics` parameters.
type AlphaVantageNewsProvider struct {
	APIKey  string
	BaseURL string
	Client  *http.Client
	Limit   int
}

// NewAlphaVantageNewsProvider creates an optional provider. It does not make a
// request; Search is the only method that performs network I/O.
func NewAlphaVantageNewsProvider(apiKey string) *AlphaVantageNewsProvider {
	return &AlphaVantageNewsProvider{
		APIKey:  strings.TrimSpace(apiKey),
		BaseURL: "https://www.alphavantage.co/query",
		Client:  http.DefaultClient,
		Limit:   50,
	}
}

// Supports reports whether this provider can map the identifier to the
// documented NEWS_SENTIMENT parameters.
func (p *AlphaVantageNewsProvider) Supports(identifier PublicNewsIdentifier) bool {
	if identifier.Validate() != nil {
		return false
	}
	switch identifier.Kind {
	case IdentifierTicker:
		return true
	case IdentifierSector:
		_, ok := alphaVantageTopic(identifier.Value)
		return ok
	default:
		return false
	}
}

// Search performs a NEWS_SENTIMENT request using only a public ticker or
// supported public sector topic. No local portfolio fields are available in
// Query or used to construct the URL.
func (p *AlphaVantageNewsProvider) Search(ctx context.Context, query Query) ([]ProviderArticle, error) {
	validated, err := NewQuery(query.Identifier)
	if err != nil {
		return nil, err
	}
	if !p.Supports(validated.Identifier) {
		return nil, ErrUnsupportedNewsIdentifier
	}
	if strings.TrimSpace(p.APIKey) == "" {
		return nil, ErrProviderUnavailable
	}
	endpoint := strings.TrimSpace(p.BaseURL)
	if endpoint == "" {
		endpoint = "https://www.alphavantage.co/query"
	}
	parameters := url.Values{}
	parameters.Set("function", "NEWS_SENTIMENT")
	parameters.Set("apikey", p.APIKey)
	limit := p.Limit
	if limit <= 0 || limit > 1000 {
		limit = 50
	}
	parameters.Set("limit", fmt.Sprintf("%d", limit))
	switch validated.Identifier.Kind {
	case IdentifierTicker:
		parameters.Set("tickers", validated.Identifier.Value)
	case IdentifierSector:
		topic, _ := alphaVantageTopic(validated.Identifier.Value)
		parameters.Set("topics", topic)
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint+"?"+parameters.Encode(), nil)
	if err != nil {
		return nil, err
	}
	client := p.Client
	if client == nil {
		client = http.DefaultClient
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 4<<20))
	if err != nil {
		return nil, err
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		return nil, fmt.Errorf("Alpha Vantage NEWS_SENTIMENT returned HTTP %d", response.StatusCode)
	}
	var payload alphaVantageNewsResponse
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("decode Alpha Vantage NEWS_SENTIMENT: %w", err)
	}
	if message := payload.errorMessage(); message != "" {
		return nil, errors.New(message)
	}
	articles := make([]ProviderArticle, 0, len(payload.Feed))
	for _, item := range payload.Feed {
		published, err := parseAlphaVantagePublicationTime(item.TimePublished)
		if err != nil {
			continue
		}
		if strings.TrimSpace(item.Title) == "" || strings.TrimSpace(item.URL) == "" || strings.TrimSpace(item.Source) == "" {
			continue
		}
		note := "Public news match for the selected identifier."
		if label := strings.TrimSpace(item.OverallSentimentLabel); label != "" {
			note = "Public news match; Alpha Vantage sentiment: " + label + "."
		}
		articles = append(articles, ProviderArticle{
			Headline:      item.Title,
			Source:        item.Source,
			PublishedAt:   published,
			Link:          item.URL,
			RelevanceNote: note,
		})
	}
	return articles, nil
}

func parseAlphaVantagePublicationTime(value string) (time.Time, error) {
	value = strings.TrimSpace(value)
	for _, layout := range []string{"20060102T150405", "20060102T1504"} {
		if parsed, err := time.ParseInLocation(layout, value, time.UTC); err == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("invalid Alpha Vantage publication time")
}

type alphaVantageNewsResponse struct {
	Feed []struct {
		Title                 string `json:"title"`
		URL                   string `json:"url"`
		TimePublished         string `json:"time_published"`
		Source                string `json:"source"`
		OverallSentimentLabel string `json:"overall_sentiment_label"`
	} `json:"feed"`
	Note        string `json:"Note"`
	Information string `json:"Information"`
	Error       string `json:"Error Message"`
}

func (p alphaVantageNewsResponse) errorMessage() string {
	if p.Error != "" {
		return p.Error
	}
	if p.Information != "" {
		return p.Information
	}
	return p.Note
}

// Alpha Vantage documents the following topic slugs for NEWS_SENTIMENT.
// Friendly title-case values are accepted locally and normalized to these
// slugs before being sent.
var alphaVantageTopics = map[string]string{
	"blockchain":                   "blockchain",
	"earnings":                     "earnings",
	"ipo":                          "ipo",
	"mergers & acquisitions":       "mergers_and_acquisitions",
	"mergers and acquisitions":     "mergers_and_acquisitions",
	"financial markets":            "financial_markets",
	"economy - fiscal policy":      "economy_fiscal",
	"economy fiscal policy":        "economy_fiscal",
	"economy - monetary policy":    "economy_monetary",
	"economy monetary policy":      "economy_monetary",
	"economy - macro/overall":      "economy_macro",
	"economy macro/overall":        "economy_macro",
	"energy & transportation":      "energy_transportation",
	"energy and transportation":    "energy_transportation",
	"finance":                      "finance",
	"life sciences":                "life_sciences",
	"manufacturing":                "manufacturing",
	"real estate & construction":   "real_estate",
	"real estate and construction": "real_estate",
	"retail & wholesale":           "retail_wholesale",
	"retail and wholesale":         "retail_wholesale",
	"technology":                   "technology",
}

func alphaVantageTopic(value string) (string, bool) {
	key := strings.ToLower(strings.TrimSpace(value))
	if topic, ok := alphaVantageTopics[key]; ok {
		return topic, true
	}
	for _, topic := range alphaVantageTopics {
		if key == topic {
			return topic, true
		}
	}
	return "", false
}
