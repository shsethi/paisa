package server

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLocalTaxHistoryLoadsVerifiedAISFactsSeparately(t *testing.T) {
	root := t.TempDir()
	original := "tax/ais/fixture.json"
	source := []byte(`{"assessmentYear":"2026"}`)
	sourcePath := filepath.Join(root, "imports", filepath.FromSlash(original))
	if err := os.MkdirAll(filepath.Dir(sourcePath), 0700); err != nil { t.Fatal(err) }
	if err := os.WriteFile(sourcePath, source, 0600); err != nil { t.Fatal(err) }
	contentHash := localSHA256(source)
	importID := localSHA256([]byte("ais_json\n" + original + "\n" + contentHash))
	output := filepath.Join(root, "extracted", "imports", "ais_json", importID)
	if err := os.MkdirAll(output, 0700); err != nil { t.Fatal(err) }
	manifest := financeManifest{RecordType: "import_manifest", ImportID: importID, SourceType: "ais_json", OriginalPath: original, ContentSHA256: contentHash, ImportedAt: "2026-10-24T00:00:00Z", Status: "succeeded", RowCounts: localImportCounts{Read: 1, Accepted: 1}}
	manifestBytes, _ := json.Marshal(manifest)
	if err := os.WriteFile(filepath.Join(output, "manifest.json"), manifestBytes, 0600); err != nil { t.Fatal(err) }
	record := map[string]any{
		"source": map[string]any{"path": original, "contentHash": contentHash},
		"identity": map[string]any{"financialYear": map[string]string{"value": "2025-26"}},
		"facts": []map[string]any{{"recordId": "fact-1", "section": "AIS", "category": "income", "amount": map[string]any{"value": 10}, "sourcePath": "AIS.fact"}},
	}
	recordBytes, _ := json.Marshal(record)
	if err := os.WriteFile(filepath.Join(output, "facts.json"), recordBytes, 0600); err != nil { t.Fatal(err) }

	response := localTaxHistory(root)
	if len(response.AIS) != 1 || len(response.AIS[0].Record) == 0 || len(response.Imports) != 1 || !response.Imports[0].SourceCurrent || len(response.Warnings) != 0 {
		t.Fatalf("expected one verified AIS import, got ais=%d imports=%d warnings=%d", len(response.AIS), len(response.Imports), len(response.Warnings))
	}
	if len(response.Returns) != 0 || len(response.AnnualTaxCredits) != 0 {
		t.Fatal("AIS facts must remain separate from ITR returns and annual tax credits")
	}
	if err := os.WriteFile(sourcePath, []byte("changed"), 0600); err != nil { t.Fatal(err) }
	response = localTaxHistory(root)
	if len(response.AIS) != 0 || len(response.Imports) != 1 || response.Imports[0].SourceCurrent {
		t.Fatal("a changed AIS source must be excluded and marked stale")
	}
}

func TestIsITRSourceTypeAcceptsHistoricalAndCurrentImportNames(t *testing.T) {
	for _, sourceType := range []string{"itr_json", "itr_xml", "itr_return_json", "itr_return_xml"} {
		if !isITRSourceType(sourceType) { t.Fatalf("expected %s to be accepted", sourceType) }
	}
	if isITRSourceType("ais_json") { t.Fatal("AIS must not be treated as an ITR return") }
}
