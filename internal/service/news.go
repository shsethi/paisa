// Package service contains local business services used by the finance
// application.  This file intentionally contains only the boundary for news
// lookup: an application can inject a provider, but no network provider is
// enabled here.
package service

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

// IdentifierKind describes the public identifier used for a news search.
// These are the only kinds that may be sent to a news provider.
type IdentifierKind string

const (
	IdentifierTicker  IdentifierKind = "ticker"
	IdentifierCompany IdentifierKind = "company"
	IdentifierFund    IdentifierKind = "fund"
	IdentifierSector  IdentifierKind = "sector"
)

// PublicNewsIdentifier is deliberately limited to a public market identifier.
// It does not contain a holding quantity, account name, or invested amount.
type PublicNewsIdentifier struct {
	Kind  IdentifierKind `json:"kind"`
	Value string         `json:"value"`
}

// NewsIdentifier is a shorter alias for callers that already know the value
// is scoped to the public-news boundary.
type NewsIdentifier = PublicNewsIdentifier

var (
	// ErrInvalidNewsIdentifier is returned before a provider is called when the
	// proposed public identifier is empty, unsupported, or resembles private
	// portfolio data.
	ErrInvalidNewsIdentifier = errors.New("invalid public news identifier")
	// ErrProviderUnavailable is returned by NoProvider.  There is intentionally
	// no default network implementation until provider terms and API behavior
	// have been reviewed.
	ErrProviderUnavailable = errors.New("news provider is not configured")
	// ErrUnsupportedNewsIdentifier is returned when an optional provider cannot
	// map a public identifier to its documented query parameters.
	ErrUnsupportedNewsIdentifier = errors.New("news identifier is unsupported by provider")
	// ErrInvalidArticle is returned when a provider response cannot be displayed
	// safely as a news item.
	ErrInvalidArticle = errors.New("invalid news article")
)

var (
	tickerPattern       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$`)
	textIdentifier      = regexp.MustCompile(`^[\pL\pN][\pL\pN .,&'()/+\-]{0,119}$`)
	amountPattern       = regexp.MustCompile(`(?i)(?:[₹$€£]|\b(?:inr|usd|eur|gbp)\b)\s*\d`)
	quantityPattern     = regexp.MustCompile(`(?i)\b\d+(?:\.\d+)?\s*(?:units?|shares?|qty|quantity)\b`)
	privateTokenPattern = regexp.MustCompile(`(?i)(?:\b(?:my|our)\s+)?\b(?:account|acct|portfolio|balance|invested|holding|holdings|units?|shares?|quantity)\b`)
)

// NewPublicNewsIdentifier validates and normalizes an identifier before it can
// become a provider query.  The validation is intentionally conservative:
// private account-like labels and amount/quantity expressions are rejected
// instead of being silently forwarded.
func NewPublicNewsIdentifier(kind IdentifierKind, value string) (PublicNewsIdentifier, error) {
	identifier := PublicNewsIdentifier{Kind: kind, Value: strings.TrimSpace(value)}
	if err := identifier.Validate(); err != nil {
		return PublicNewsIdentifier{}, err
	}
	return identifier, nil
}

// NewNewsIdentifier is the concise constructor alias for
// NewPublicNewsIdentifier.
func NewNewsIdentifier(kind IdentifierKind, value string) (NewsIdentifier, error) {
	return NewPublicNewsIdentifier(kind, value)
}

// Validate checks that the identifier contains only public lookup data.
func (i PublicNewsIdentifier) Validate() error {
	if !isSupportedIdentifierKind(i.Kind) || i.Value == "" || !utf8.ValidString(i.Value) {
		return fmt.Errorf("%w: kind and value are required", ErrInvalidNewsIdentifier)
	}
	// Ampersand is allowed in genuine public names such as "AT&T"; a
	// concrete provider must URL-encode the identifier when building its own
	// request rather than treating this value as a raw query string.
	if strings.ContainsAny(i.Value, "\r\n:\\?=\x00") || amountPattern.MatchString(i.Value) || quantityPattern.MatchString(i.Value) || privateTokenPattern.MatchString(i.Value) {
		return fmt.Errorf("%w: private account, amount, or quantity data is not allowed", ErrInvalidNewsIdentifier)
	}

	switch i.Kind {
	case IdentifierTicker:
		// A ticker is compact and has no spaces.  Numeric-only strings are
		// rejected because they are much more likely to be an amount than a
		// public ticker.
		if !tickerPattern.MatchString(i.Value) || !containsLetter(i.Value) {
			return fmt.Errorf("%w: ticker must be an alphanumeric public symbol", ErrInvalidNewsIdentifier)
		}
	default:
		if !textIdentifier.MatchString(i.Value) {
			return fmt.Errorf("%w: identifier contains unsupported characters", ErrInvalidNewsIdentifier)
		}
	}
	return nil
}

func isSupportedIdentifierKind(kind IdentifierKind) bool {
	switch kind {
	case IdentifierTicker, IdentifierCompany, IdentifierFund, IdentifierSector:
		return true
	default:
		return false
	}
}

func containsLetter(value string) bool {
	for _, r := range value {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') {
			return true
		}
	}
	return false
}

// Query is the complete provider request.  Its shape is intentionally small:
// no account, holding, amount, unit, or free-form query fields exist to leak
// local portfolio data into a provider implementation.
type Query struct {
	Identifier PublicNewsIdentifier `json:"identifier"`
}

// NewQuery validates the identifier at the provider boundary as well as at
// service entry points.  This protects providers that are called directly in
// tests or by future integrations.
func NewQuery(identifier PublicNewsIdentifier) (Query, error) {
	if err := identifier.Validate(); err != nil {
		return Query{}, err
	}
	return Query{Identifier: identifier}, nil
}

// ProviderArticle is the provider-owned portion of a result.  The service
// fills in the related public identifier, so providers cannot infer or need
// to receive a user's local holdings.
type ProviderArticle struct {
	Headline      string
	Source        string
	PublishedAt   time.Time
	Link          string
	RelevanceNote string
}

// NewsItem is the local, displayable representation of a public news result.
// RelatedIdentifier is always the public identifier used for the query.
type NewsItem struct {
	Headline          string               `json:"headline"`
	Source            string               `json:"source"`
	PublishedAt       time.Time            `json:"publishedAt"`
	Link              string               `json:"link"`
	RelatedIdentifier PublicNewsIdentifier `json:"relatedIdentifier"`
	RelatedCategory   IdentifierKind       `json:"relatedCategory"`
	RelevanceNote     string               `json:"relevanceNote"`
}

// NewsProvider is the only external boundary.  Implementations should build
// requests from query.Identifier only.  The package intentionally provides no
// HTTP implementation because no provider terms/API have been verified.
type NewsProvider interface {
	Search(context.Context, Query) ([]ProviderArticle, error)
}

// Provider is kept as a short alias for callers that prefer the generic name.
type Provider = NewsProvider

// NoProvider makes the lack of a configured provider explicit and avoids an
// accidental network call in a default build.
type NoProvider struct{}

func (NoProvider) Search(context.Context, Query) ([]ProviderArticle, error) {
	return nil, ErrProviderUnavailable
}

// Store is a process-local news result store.  It keeps only the fields needed
// for display and can be replaced by a persistent local store later without
// changing the provider contract.
type Store struct {
	mu    sync.RWMutex
	items []NewsItem
}

// List returns a snapshot in insertion order.  The returned slice can be
// modified by the caller without mutating the local store.
func (s *Store) List() []NewsItem {
	if s == nil {
		return nil
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]NewsItem(nil), s.items...)
}

func (s *Store) append(items []NewsItem) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.items = append(s.items, items...)
}

// NewsService performs privacy-safe lookup and stores displayable results
// locally.  A provider must be injected explicitly.
type NewsService struct {
	provider NewsProvider
	store    *Store
}

// NewNewsService constructs a service with an injected provider.  A nil
// provider is replaced with NoProvider so a lookup remains deterministic and
// cannot panic or make an implicit network request.
func NewNewsService(provider NewsProvider) *NewsService {
	if provider == nil {
		provider = NoProvider{}
	}
	return &NewsService{provider: provider, store: &Store{}}
}

// Lookup validates the public identifier before calling the provider, maps the
// response into the local display shape, and stores the mapped items.
func (s *NewsService) Lookup(ctx context.Context, identifier PublicNewsIdentifier) ([]NewsItem, error) {
	if s == nil {
		return nil, errors.New("news service is nil")
	}
	query, err := NewQuery(identifier)
	if err != nil {
		return nil, err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	articles, err := s.provider.Search(ctx, query)
	if err != nil {
		return nil, err
	}
	items := make([]NewsItem, 0, len(articles))
	for _, article := range articles {
		item, err := displayItem(identifier, article)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	s.store.append(items)
	return append([]NewsItem(nil), items...), nil
}

// List returns all results stored by this service instance.
func (s *NewsService) List() []NewsItem {
	if s == nil || s.store == nil {
		return nil
	}
	return s.store.List()
}

func displayItem(identifier PublicNewsIdentifier, article ProviderArticle) (NewsItem, error) {
	headline := strings.TrimSpace(article.Headline)
	source := strings.TrimSpace(article.Source)
	note := strings.TrimSpace(article.RelevanceNote)
	if headline == "" || source == "" || article.PublishedAt.IsZero() || !utf8.ValidString(headline) || !utf8.ValidString(source) {
		return NewsItem{}, fmt.Errorf("%w: headline, source, and publication date are required", ErrInvalidArticle)
	}
	parsedLink, err := url.Parse(strings.TrimSpace(article.Link))
	if err != nil || parsedLink.Host == "" || (parsedLink.Scheme != "http" && parsedLink.Scheme != "https") {
		return NewsItem{}, fmt.Errorf("%w: link must be an http or https URL", ErrInvalidArticle)
	}
	if note == "" {
		note = "Public news result related to the selected identifier; assess relevance independently."
	}
	return NewsItem{
		Headline:          headline,
		Source:            source,
		PublishedAt:       article.PublishedAt,
		Link:              parsedLink.String(),
		RelatedIdentifier: identifier,
		RelatedCategory:   identifier.Kind,
		RelevanceNote:     note,
	}, nil
}
