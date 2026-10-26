package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalFinancePortfolioLoadsOnlyVerifiedRecords(t *testing.T) {
	root := t.TempDir()
	imports := filepath.Join(root, "imports")
	sourceRelative := "investments/kuvera/holdings.csv"
	sourcePath := filepath.Join(imports, filepath.FromSlash(sourceRelative))
	if err := os.MkdirAll(filepath.Dir(sourcePath), 0700); err != nil {
		t.Fatal(err)
	}
	sourceBytes := []byte("local fixture")
	if err := os.WriteFile(sourcePath, sourceBytes, 0600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(sourceBytes)
	contentHash := hex.EncodeToString(digest[:])
	sourceType := "kuvera_holdings"
	importID := localSHA256([]byte(sourceType + "\n" + sourceRelative + "\n" + contentHash))
	output := filepath.Join(root, "extracted", "imports", sourceType, importID)
	if err := os.MkdirAll(output, 0700); err != nil {
		t.Fatal(err)
	}
	manifest := financeManifest{RecordType: "import_manifest", ImportID: importID, SourceType: sourceType, OriginalPath: sourceRelative, ContentSHA256: contentHash, ImportedAt: "2026-10-24T00:00:00Z", Status: "succeeded", RowCounts: localImportCounts{Read: 1, Accepted: 1}}
	manifestBytes, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(output, "manifest.json"), manifestBytes, 0600); err != nil {
		t.Fatal(err)
	}
	record := financeRecord{RecordType: "holding", SourceID: localSHA256([]byte("stable-row")), Current: "1250", Currency: "INR", Source: financeRecordSource{ImportID: importID, OriginalPath: sourceRelative, ContentSHA256: contentHash, RecordLocator: "csv row 2"}}
	recordBytes, _ := json.Marshal([]financeRecord{record})
	if err := os.WriteFile(filepath.Join(output, "holdings.json"), recordBytes, 0600); err != nil {
		t.Fatal(err)
	}

	response := localFinancePortfolio(root)
	if len(response.Holdings) != 1 || len(response.Warnings) != 0 || len(response.Imports) != 1 || !response.Imports[0].SourceCurrent {
		t.Fatalf("expected one verified holding with current source, got holdings=%d imports=%d warnings=%d", len(response.Holdings), len(response.Imports), len(response.Warnings))
	}
	if err := os.WriteFile(sourcePath, []byte("changed"), 0600); err != nil {
		t.Fatal(err)
	}
	response = localFinancePortfolio(root)
	if len(response.Holdings) != 0 || len(response.Imports) != 1 || response.Imports[0].SourceCurrent || len(response.Warnings) == 0 {
		t.Fatal("changed source must make the imported holding stale and keep it out of the view")
	}
}

func writeKitePortfolioFixture(t *testing.T, root string, corrupt bool) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "imports"), 0700); err != nil {
		t.Fatal(err)
	}
	directory := filepath.Join(root, "extracted", "api", "zerodha", "2026-10-26", "snapshot-a")
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	snapshot := map[string]any{
		"holdings":  []map[string]any{{"tradingsymbol": "TEST", "exchange": "NSE", "isin": "INE000000001", "quantity": 2, "average_price": 10.5, "last_price": 15.25}},
		"positions": map[string]any{"net": []any{}, "day": []any{}}, "margins": map[string]any{}, "orders": []any{}, "trades": []any{},
	}
	snapshotBytes, _ := json.Marshal(snapshot)
	snapshotBytes = append(snapshotBytes, '\n')
	digest := sha256.Sum256(snapshotBytes)
	manifest := map[string]any{
		"record_type": "zerodha_kite_snapshot_manifest", "fetched_at": "2026-10-26T15:34:07.148Z", "as_of_date": "2026-10-26",
		"source_type": "zerodha_kite_api", "api_version": "3", "sync_version": "1.0.0", "content_sha256": hex.EncodeToString(digest[:]),
		"counts": map[string]any{"holdings": 1, "orders": 0, "trades": 0},
	}
	manifestBytes, _ := json.Marshal(manifest)
	if corrupt {
		snapshotBytes = append(snapshotBytes, ' ')
	}
	if err := os.WriteFile(filepath.Join(directory, "snapshot.json"), snapshotBytes, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "manifest.json"), manifestBytes, 0600); err != nil {
		t.Fatal(err)
	}
}

func TestLocalFinancePortfolioLoadsLatestVerifiedKiteSnapshot(t *testing.T) {
	root := t.TempDir()
	writeKitePortfolioFixture(t, root, false)
	response := localFinancePortfolio(root)
	if len(response.Warnings) != 0 || len(response.Holdings) != 1 || len(response.Imports) != 1 {
		t.Fatalf("expected one verified Kite holding, got holdings=%d imports=%d warnings=%d", len(response.Holdings), len(response.Imports), len(response.Warnings))
	}
	holding := response.Holdings[0]
	if holding.Current != "30.5" || holding.Security["identifier"] != "INE000000001" || holding.Source.OriginalPath != "api/zerodha/2026-10-26" {
		t.Fatal("Kite holding was not normalized into the local portfolio model")
	}
	if response.Imports[0].SourceType != "zerodha_kite_api" || !response.Imports[0].SourceCurrent {
		t.Fatal("Kite snapshot freshness metadata is missing")
	}
}

func TestLocalFinancePortfolioRejectsCorruptKiteSnapshot(t *testing.T) {
	root := t.TempDir()
	writeKitePortfolioFixture(t, root, true)
	response := localFinancePortfolio(root)
	if len(response.Holdings) != 0 || len(response.Warnings) != 1 {
		t.Fatal("corrupt Kite snapshot must be ignored with a warning")
	}
}
