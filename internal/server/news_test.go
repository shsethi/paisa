package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/ananthakumaran/paisa/internal/service"
	"github.com/gin-gonic/gin"
)

type fakeNewsProvider struct {
	query service.Query
}

func (p *fakeNewsProvider) Search(_ context.Context, query service.Query) ([]service.ProviderArticle, error) {
	p.query = query
	return []service.ProviderArticle{{
		Headline:      "Public company update",
		Source:        "Example News",
		PublishedAt:   testNewsDate(),
		Link:          "https://news.example.test/story",
		RelevanceNote: "Public news result.",
	}}, nil
}

func testNewsDate() (date time.Time) {
	return time.Date(2026, time.October, 24, 0, 0, 0, 0, time.UTC)
}

func TestNewsHTTPHandlerSearchAcceptsOnlyKindAndValue(t *testing.T) {
	gin.SetMode(gin.TestMode)
	fake := &fakeNewsProvider{}
	router := gin.New()
	RegisterNewsRoutes(router, NewNewsHTTPHandler(fake))

	request := httptest.NewRequest(http.MethodPost, "/api/news/search", strings.NewReader(`{"kind":"ticker","value":"ACME"}`))
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), "Example News") {
		t.Fatalf("search status/body = %d/%s", response.Code, response.Body.String())
	}
	if fake.query.Identifier.Kind != service.IdentifierTicker || fake.query.Identifier.Value != "ACME" {
		t.Fatalf("provider query = %#v", fake.query)
	}

	private := httptest.NewRequest(http.MethodPost, "/api/news/search", strings.NewReader(`{"kind":"ticker","value":"ACME","units":"10"}`))
	privateResponse := httptest.NewRecorder()
	router.ServeHTTP(privateResponse, private)
	if privateResponse.Code != http.StatusBadRequest {
		t.Fatalf("private field status = %d, body = %s", privateResponse.Code, privateResponse.Body.String())
	}
}

func TestNewsHTTPHandlerShowsDisabledStateWithoutProvider(t *testing.T) {
	gin.SetMode(gin.TestMode)
	router := gin.New()
	RegisterNewsRoutes(router, NewNewsHTTPHandler(nil))

	statusRequest := httptest.NewRequest(http.MethodGet, "/api/news/status", nil)
	statusResponse := httptest.NewRecorder()
	router.ServeHTTP(statusResponse, statusRequest)
	if statusResponse.Code != http.StatusOK || !strings.Contains(statusResponse.Body.String(), `"configured":false`) || !strings.Contains(statusResponse.Body.String(), `"premium":true`) {
		t.Fatalf("status response = %d/%s", statusResponse.Code, statusResponse.Body.String())
	}
	searchRequest := httptest.NewRequest(http.MethodPost, "/api/news/search", strings.NewReader(`{"kind":"ticker","value":"ACME"}`))
	searchResponse := httptest.NewRecorder()
	router.ServeHTTP(searchResponse, searchRequest)
	if searchResponse.Code != http.StatusServiceUnavailable || !strings.Contains(searchResponse.Body.String(), "provider_not_configured") {
		t.Fatalf("disabled search = %d/%s", searchResponse.Code, searchResponse.Body.String())
	}
}
