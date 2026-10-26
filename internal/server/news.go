package server

// HTTP boundaries for optional public news lookup. Route registration is
// intentionally exposed as RegisterNewsRoutes so the shared server bootstrap
// can opt in without this file importing or modifying server.go.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/ananthakumaran/paisa/internal/service"
	"github.com/gin-gonic/gin"
)

const newsAPIKeyEnv = "ALPHAVANTAGE_API_KEY"

type newsLookupRequest struct {
	Kind  service.IdentifierKind `json:"kind"`
	Value string                 `json:"value"`
}

type NewsHTTPHandler struct {
	service    *service.NewsService
	configured bool
}

// NewAlphaVantageNewsHTTPHandler creates an optional handler from
// ALPHAVANTAGE_API_KEY. It does not make a request during construction.
func NewAlphaVantageNewsHTTPHandler() *NewsHTTPHandler {
	key := strings.TrimSpace(os.Getenv(newsAPIKeyEnv))
	configured := key != ""
	var provider service.NewsProvider = service.NoProvider{}
	if configured {
		provider = service.NewAlphaVantageNewsProvider(key)
	}
	return &NewsHTTPHandler{service: service.NewNewsService(provider), configured: configured}
}

// NewNewsHTTPHandler injects a provider for tests or a future explicitly
// configured integration. The provider itself remains the only network
// boundary.
func NewNewsHTTPHandler(provider service.NewsProvider) *NewsHTTPHandler {
	return &NewsHTTPHandler{service: service.NewNewsService(provider), configured: provider != nil}
}

// RegisterNewsRoutes registers local news status/list/search endpoints on any
// gin router. The application bootstrap may call this from server.go when the
// feature is ready to expose.
func RegisterNewsRoutes(router gin.IRouter, handler *NewsHTTPHandler) {
	if handler == nil {
		handler = NewAlphaVantageNewsHTTPHandler()
	}
	router.GET("/api/news/status", handler.status)
	router.GET("/api/news", handler.list)
	router.POST("/api/news/search", handler.search)
}

func (h *NewsHTTPHandler) status(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"configured": h != nil && h.configured,
		"provider":   "Alpha Vantage NEWS_SENTIMENT",
		"premium":    true,
	})
}

func (h *NewsHTTPHandler) list(c *gin.Context) {
	if h == nil || h.service == nil {
		c.JSON(http.StatusOK, gin.H{"items": []service.NewsItem{}, "configured": false, "provider": "Alpha Vantage NEWS_SENTIMENT", "premium": true})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": h.service.List(), "configured": h.configured, "provider": "Alpha Vantage NEWS_SENTIMENT", "premium": true})
}

func (h *NewsHTTPHandler) search(c *gin.Context) {
	if h == nil || h.service == nil || !h.configured {
		c.JSON(http.StatusServiceUnavailable, gin.H{"code": "provider_not_configured", "error": "Public news lookup is disabled; set ALPHAVANTAGE_API_KEY to enable optional Alpha Vantage NEWS_SENTIMENT."})
		return
	}
	request, err := decodeNewsLookupRequest(c)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "invalid_request", "error": err.Error()})
		return
	}
	identifier, err := service.NewPublicNewsIdentifier(request.Kind, request.Value)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"code": "invalid_identifier", "error": err.Error()})
		return
	}
	items, err := h.service.Lookup(c.Request.Context(), identifier)
	if err != nil {
		status := http.StatusBadGateway
		code := "provider_search_failed"
		if errors.Is(err, service.ErrUnsupportedNewsIdentifier) {
			status = http.StatusUnprocessableEntity
			code = "unsupported_identifier"
		} else if errors.Is(err, service.ErrProviderUnavailable) {
			status = http.StatusServiceUnavailable
			code = "provider_not_configured"
		} else if errors.Is(err, service.ErrInvalidNewsIdentifier) {
			status = http.StatusBadRequest
			code = "invalid_identifier"
		}
		c.JSON(status, gin.H{"code": code, "error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"items": items, "configured": true, "provider": "Alpha Vantage NEWS_SENTIMENT", "premium": true})
}

func decodeNewsLookupRequest(c *gin.Context) (newsLookupRequest, error) {
	var request newsLookupRequest
	decoder := json.NewDecoder(io.LimitReader(c.Request.Body, 1<<20))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&request); err != nil {
		return newsLookupRequest{}, err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return newsLookupRequest{}, errors.New("request body must contain one JSON object")
		}
		return newsLookupRequest{}, err
	}
	if strings.TrimSpace(string(request.Kind)) == "" || strings.TrimSpace(request.Value) == "" {
		return newsLookupRequest{}, fmt.Errorf("kind and value are required")
	}
	return request, nil
}
