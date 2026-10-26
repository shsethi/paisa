package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
)

func noError(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func hashText(value string) string {
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}

func writeLocalICICIFixture(t *testing.T, root string, source []byte, description string) string {
	t.Helper()
	originalPath := "banking/icici/fixture.xls"
	contentHash := localSHA256(source)
	importID := hashText("icici_bank_statement\n" + originalPath + "\n" + contentHash)
	locator := "OpTransactionHistory!row:14"
	sourceID := hashText("icici_bank_statement\n" + contentHash + "\n" + locator)
	sourceFile := filepath.Join(root, "imports", filepath.FromSlash(originalPath))
	outputDir := filepath.Join(root, "extracted", "imports", "icici", importID)
	noError(t, os.MkdirAll(filepath.Dir(sourceFile), 0755))
	noError(t, os.MkdirAll(outputDir, 0700))
	noError(t, os.WriteFile(sourceFile, source, 0600))
	manifest := map[string]any{
		"record_type": "import_manifest", "import_id": importID,
		"source_type": "icici_bank_statement", "original_path": originalPath,
		"content_sha256": contentHash, "imported_at": "2026-10-24T12:00:00Z",
		"parser": map[string]string{"name": "icici-xls-import", "version": "1.0.0"},
		"status": "succeeded", "row_counts": map[string]int{"read": 1, "accepted": 1, "rejected": 0, "skipped": 0},
		"errors": []any{},
	}
	transaction := map[string]any{
		"record_type": "bank_transaction", "source_id": sourceID,
		"date": "2026-10-23", "description": description, "debit": "10.00", "credit": nil,
		"currency": "INR", "balance": "90.00", "category": nil, "classification": nil,
		"classification_detail": map[string]any{"rule": "uncategorized", "reason": "No supported rule matched.", "confidence": "low", "review_needed": true},
		"source":                map[string]string{"import_id": importID, "original_path": originalPath, "content_sha256": contentHash, "record_locator": locator},
		"review_status":         "needs_review",
	}
	writeJSON := func(file string, value any) {
		data, err := json.Marshal(value)
		noError(t, err)
		noError(t, os.WriteFile(file, data, 0600))
	}
	writeJSON(filepath.Join(outputDir, "manifest.json"), manifest)
	writeJSON(filepath.Join(outputDir, "transactions.json"), []any{transaction})
	return sourceFile
}

func TestLocalICICITransactionsLoadsVerifiedLocalRecords(t *testing.T) {
	root := t.TempDir()
	sourceFile := writeLocalICICIFixture(t, root, []byte("source bytes"), "local sample")
	t.Setenv("PAISA_FINANCE_ROOT", root)

	router := gin.New()
	router.GET("/api/finance/icici/transactions", GetLocalICICITransactions)
	request := httptest.NewRequest(http.MethodGet, "/api/finance/icici/transactions", nil)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("expected HTTP %d, got %d", http.StatusOK, response.Code)
	}
	var result localICICIResponse
	noError(t, json.Unmarshal(response.Body.Bytes(), &result))
	if len(result.Transactions) != 1 || len(result.Imports) != 1 {
		t.Fatalf("expected one transaction and one import, got %d and %d", len(result.Transactions), len(result.Imports))
	}
	if result.Transactions[0].Description != "local sample" ||
		result.Transactions[0].Source.OriginalPath != "banking/icici/fixture.xls" ||
		result.Transactions[0].Source.RecordLocator != "OpTransactionHistory!row:14" ||
		!result.Imports[0].SourceCurrent || len(result.Warnings) != 0 {
		t.Fatal("verified local transaction fields did not match the fixture")
	}
	if _, err := os.Stat(sourceFile); err != nil {
		t.Fatal("original source file is unavailable")
	}
	for _, privateField := range []string{"content_sha256", "source_id", "import_id"} {
		if strings.Contains(response.Body.String(), privateField) {
			t.Fatalf("API response should not expose %s", privateField)
		}
	}
}

func TestLocalICICITransactionsHidesRowsWhenSourceChanged(t *testing.T) {
	root := t.TempDir()
	sourceFile := writeLocalICICIFixture(t, root, []byte("original source"), "local sample")
	noError(t, os.WriteFile(sourceFile, []byte("changed source"), 0600))

	result := loadLocalICICITransactions(root)
	if len(result.Transactions) != 0 || len(result.Imports) != 1 || result.Imports[0].SourceCurrent {
		t.Fatal("changed source should be listed as stale with no transaction rows")
	}
	if !strings.Contains(strings.Join(result.Warnings, " "), "changed since import") {
		t.Fatal("expected a source-changed warning")
	}
}

func TestLocalICICITransactionsIgnoresMissingImportFolder(t *testing.T) {
	result := loadLocalICICITransactions(t.TempDir())
	if len(result.Transactions) != 0 || len(result.Imports) != 0 || len(result.Warnings) != 1 {
		t.Fatal("missing import folder should return an empty response")
	}
}
