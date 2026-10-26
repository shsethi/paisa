package server

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ananthakumaran/paisa/internal/financepaths"
	"github.com/gin-gonic/gin"
)

type localTaxReturn struct {
	SourceType   string          `json:"source_type"`
	OriginalPath string          `json:"original_path"`
	ImportedAt   string          `json:"imported_at"`
	Status       string          `json:"status"`
	Record       json.RawMessage `json:"record"`
}

type localTaxHistoryResponse struct {
	Returns          []localTaxReturn       `json:"returns"`
	AIS              []localTaxReturn       `json:"ais"`
	AnnualTaxCredits []json.RawMessage      `json:"annual_tax_credits"`
	Form16           []localTaxReturn       `json:"form16"`
	Form26AS         []localTaxReturn       `json:"form26as"`
	Imports          []localPortfolioImport `json:"imports"`
	Warnings         []string               `json:"warnings"`
}

func isITRSourceType(sourceType string) bool {
	// itr_json and itr_xml were emitted by the initial local importer. Keep
	// them readable alongside the later, more descriptive names.
	return sourceType == "itr_json" || sourceType == "itr_xml" || sourceType == "itr_return_json" || sourceType == "itr_return_xml"
}

func localTaxHistory(root string) localTaxHistoryResponse {
	response := localTaxHistoryResponse{Returns: []localTaxReturn{}, AIS: []localTaxReturn{}, AnnualTaxCredits: []json.RawMessage{}, Form16: []localTaxReturn{}, Form26AS: []localTaxReturn{}, Imports: []localPortfolioImport{}, Warnings: []string{}}
	importsRoot := filepath.Join(root, "imports")
	importsReal, err := filepath.EvalSymlinks(importsRoot)
	if err != nil {
		response.Warnings = append(response.Warnings, "Local finance imports folder is unavailable.")
		return response
	}
	outputRoot := filepath.Join(root, "extracted", "imports", "itr_returns")
	entries, err := os.ReadDir(outputRoot)
	if err != nil {
		if !os.IsNotExist(err) {
			response.Warnings = append(response.Warnings, "Local ITR import records could not be read.")
		}
	} else {
		latest := make(map[string]financeManifest)
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			data, readErr := os.ReadFile(filepath.Join(outputRoot, entry.Name(), "manifest.json"))
			if readErr != nil {
				response.Warnings = append(response.Warnings, "An ITR import manifest could not be read.")
				continue
			}
			var manifest financeManifest
			if json.Unmarshal(data, &manifest) != nil || manifest.RecordType != "import_manifest" || manifest.ImportID != entry.Name() || !isITRSourceType(manifest.SourceType) || !strings.HasPrefix(manifest.OriginalPath, "tax/returns/") || manifest.ImportID != localSHA256([]byte(manifest.SourceType+"\n"+manifest.OriginalPath+"\n"+manifest.ContentSHA256)) {
				response.Warnings = append(response.Warnings, "An ITR import manifest failed validation.")
				continue
			}
			previous, ok := latest[manifest.OriginalPath]
			if !ok || manifest.ImportedAt > previous.ImportedAt || (manifest.ImportedAt == previous.ImportedAt && manifest.ImportID > previous.ImportID) {
				latest[manifest.OriginalPath] = manifest
			}
		}
		paths := make([]string, 0, len(latest))
		for sourcePath := range latest {
			paths = append(paths, sourcePath)
		}
		sort.Strings(paths)
		for _, original := range paths {
			manifest := latest[original]
			path := filepath.Clean(filepath.Join(importsRoot, filepath.FromSlash(original)))
			if !beneath(importsRoot, path) {
				response.Warnings = append(response.Warnings, "An ITR source path is invalid.")
				continue
			}
			real, sourceErr := filepath.EvalSymlinks(path)
			if sourceErr != nil || !beneath(importsReal, real) {
				response.Imports = append(response.Imports, localPortfolioManifestView(manifest.SourceType, manifest, false))
				response.Warnings = append(response.Warnings, "An ITR source file is unavailable; re-import it to refresh the tax history.")
				continue
			}
			bytes, sourceErr := os.ReadFile(real)
			if sourceErr != nil || localSHA256(bytes) != manifest.ContentSHA256 {
				response.Imports = append(response.Imports, localPortfolioManifestView(manifest.SourceType, manifest, false))
				response.Warnings = append(response.Warnings, "An ITR source changed since import; re-import it to refresh the tax history.")
				continue
			}
			response.Imports = append(response.Imports, localPortfolioManifestView(manifest.SourceType, manifest, true))
			if manifest.Status == "failed" {
				continue
			}
			recordBytes, readErr := os.ReadFile(filepath.Join(outputRoot, manifest.ImportID, "return.json"))
			if readErr != nil || !json.Valid(recordBytes) {
				response.Warnings = append(response.Warnings, "An imported ITR summary could not be read.")
				continue
			}
			var record struct {
				Source struct {
					Path        string `json:"path"`
					ContentHash string `json:"contentHash"`
				} `json:"source"`
			}
			if json.Unmarshal(recordBytes, &record) != nil || record.Source.Path != original || record.Source.ContentHash != manifest.ContentSHA256 {
				response.Warnings = append(response.Warnings, "An imported ITR summary failed provenance checks.")
				continue
			}
			response.Returns = append(response.Returns, localTaxReturn{SourceType: manifest.SourceType, OriginalPath: original, ImportedAt: manifest.ImportedAt, Status: manifest.Status, Record: recordBytes})
		}
	}
	loadAnnualTaxCredits(&response, root, importsRoot, importsReal)
	loadAIS(&response, root, importsRoot, importsReal)
	loadTaxPDFSummaries(&response, root, importsRoot, importsReal, "form16", "tax/form-16/", &response.Form16)
	loadTaxPDFSummaries(&response, root, importsRoot, importsReal, "form26as", "tax/form-26as/", &response.Form26AS)
	return response
}

func loadTaxPDFSummaries(response *localTaxHistoryResponse, root, importsRoot, importsReal, sourceType, pathPrefix string, target *[]localTaxReturn) {
	outputRoot := filepath.Join(root, "extracted", "imports", sourceType)
	entries, err := os.ReadDir(outputRoot)
	if err != nil { if !os.IsNotExist(err) { response.Warnings = append(response.Warnings, "A tax PDF import folder could not be read.") }; return }
	latest := make(map[string]financeManifest)
	for _, entry := range entries {
		if !entry.IsDir() { continue }
		data, readErr := os.ReadFile(filepath.Join(outputRoot, entry.Name(), "manifest.json")); var manifest financeManifest
		if readErr != nil || json.Unmarshal(data, &manifest) != nil || manifest.RecordType != "import_manifest" || manifest.SourceType != sourceType || manifest.ImportID != entry.Name() || !strings.HasPrefix(manifest.OriginalPath, pathPrefix) || manifest.ImportID != localSHA256([]byte(manifest.SourceType+"\n"+manifest.OriginalPath+"\n"+manifest.ContentSHA256)) { response.Warnings = append(response.Warnings, "A tax PDF import manifest failed validation."); continue }
		previous, ok := latest[manifest.OriginalPath]; if !ok || manifest.ImportedAt > previous.ImportedAt { latest[manifest.OriginalPath] = manifest }
	}
	paths := make([]string, 0, len(latest)); for original := range latest { paths = append(paths, original) }; sort.Strings(paths)
	for _, original := range paths {
		manifest := latest[original]; sourcePath := filepath.Clean(filepath.Join(importsRoot, filepath.FromSlash(original))); sourceReal, sourceErr := filepath.EvalSymlinks(sourcePath)
		current := sourceErr == nil && beneath(importsReal, sourceReal); if current { bytes, readErr := os.ReadFile(sourceReal); current = readErr == nil && localSHA256(bytes) == manifest.ContentSHA256 }
		response.Imports = append(response.Imports, localPortfolioManifestView(sourceType, manifest, current)); if !current { response.Warnings = append(response.Warnings, "A tax PDF source is unavailable or changed since import."); continue }; if manifest.Status == "failed" { continue }
		record, readErr := os.ReadFile(filepath.Join(outputRoot, manifest.ImportID, "summary.json")); if readErr != nil || !json.Valid(record) { response.Warnings = append(response.Warnings, "An imported tax PDF summary could not be read."); continue }
		*target = append(*target, localTaxReturn{SourceType: sourceType, OriginalPath: original, ImportedAt: manifest.ImportedAt, Status: manifest.Status, Record: record})
	}
}

// loadAIS keeps AIS facts independent from ITR values: they are displayed for
// review and reconciliation only, never selected as a replacement total.
func loadAIS(response *localTaxHistoryResponse, root, importsRoot, importsReal string) {
	outputRoot := filepath.Join(root, "extracted", "imports", "ais_json")
	entries, err := os.ReadDir(outputRoot)
	if err != nil {
		if !os.IsNotExist(err) {
			response.Warnings = append(response.Warnings, "AIS import records could not be read.")
		}
		return
	}
	latest := make(map[string]financeManifest)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(outputRoot, entry.Name(), "manifest.json"))
		var manifest financeManifest
		if readErr != nil || json.Unmarshal(data, &manifest) != nil || manifest.RecordType != "import_manifest" || manifest.SourceType != "ais_json" || manifest.ImportID != entry.Name() || !strings.HasPrefix(manifest.OriginalPath, "tax/ais/") || manifest.ImportID != localSHA256([]byte(manifest.SourceType+"\n"+manifest.OriginalPath+"\n"+manifest.ContentSHA256)) {
			response.Warnings = append(response.Warnings, "An AIS import manifest failed validation.")
			continue
		}
		previous, ok := latest[manifest.OriginalPath]
		if !ok || manifest.ImportedAt > previous.ImportedAt || (manifest.ImportedAt == previous.ImportedAt && manifest.ImportID > previous.ImportID) {
			latest[manifest.OriginalPath] = manifest
		}
	}
	paths := make([]string, 0, len(latest))
	for original := range latest {
		paths = append(paths, original)
	}
	sort.Strings(paths)
	for _, original := range paths {
		manifest := latest[original]
		// A failed import contributes no tax data. Keep it visible in source
		// freshness, but do not turn a subsequently removed source into a page
		// warning about the active tax history.
		if manifest.Status == "failed" {
			response.Imports = append(response.Imports, localPortfolioManifestView(manifest.SourceType, manifest, false))
			continue
		}
		sourcePath := filepath.Clean(filepath.Join(importsRoot, filepath.FromSlash(original)))
		if !beneath(importsRoot, sourcePath) {
			response.Warnings = append(response.Warnings, "An AIS source path is invalid.")
			continue
		}
		sourceReal, sourceErr := filepath.EvalSymlinks(sourcePath)
		if sourceErr != nil || !beneath(importsReal, sourceReal) {
			response.Imports = append(response.Imports, localPortfolioManifestView(manifest.SourceType, manifest, false))
			response.Warnings = append(response.Warnings, "An AIS source file is unavailable; re-import it to refresh the tax history.")
			continue
		}
		sourceBytes, sourceErr := os.ReadFile(sourceReal)
		if sourceErr != nil || localSHA256(sourceBytes) != manifest.ContentSHA256 {
			response.Imports = append(response.Imports, localPortfolioManifestView(manifest.SourceType, manifest, false))
			response.Warnings = append(response.Warnings, "An AIS source changed since import; re-import it to refresh the tax history.")
			continue
		}
		response.Imports = append(response.Imports, localPortfolioManifestView(manifest.SourceType, manifest, true))
		recordBytes, readErr := os.ReadFile(filepath.Join(outputRoot, manifest.ImportID, "facts.json"))
		var record struct {
			Source struct {
				Path        string `json:"path"`
				ContentHash string `json:"contentHash"`
			} `json:"source"`
			Facts []json.RawMessage `json:"facts"`
		}
		if readErr != nil || !json.Valid(recordBytes) || json.Unmarshal(recordBytes, &record) != nil || record.Source.Path != original || record.Source.ContentHash != manifest.ContentSHA256 || record.Facts == nil {
			response.Warnings = append(response.Warnings, "An imported AIS record failed provenance checks.")
			continue
		}
		response.AIS = append(response.AIS, localTaxReturn{SourceType: manifest.SourceType, OriginalPath: original, ImportedAt: manifest.ImportedAt, Status: manifest.Status, Record: recordBytes})
	}
}

func loadAnnualTaxCredits(response *localTaxHistoryResponse, root, importsRoot, importsReal string) {
	outputRoot := filepath.Join(root, "extracted", "imports", "annual_tax_statement")
	entries, err := os.ReadDir(outputRoot)
	if err != nil {
		if !os.IsNotExist(err) {
			response.Warnings = append(response.Warnings, "Annual tax statement imports could not be read.")
		}
		return
	}
	latest := make(map[string]financeManifest)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(outputRoot, entry.Name())
		data, readErr := os.ReadFile(filepath.Join(dir, "manifest.json"))
		var manifest financeManifest
		if readErr != nil || json.Unmarshal(data, &manifest) != nil || manifest.RecordType != "import_manifest" || manifest.SourceType != "annual_tax_statement" || manifest.ImportID != entry.Name() || !strings.HasPrefix(manifest.OriginalPath, "tax/form-26as/") || manifest.ImportID != localSHA256([]byte(manifest.SourceType+"\n"+manifest.OriginalPath+"\n"+manifest.ContentSHA256)) {
			response.Warnings = append(response.Warnings, "An annual tax statement manifest failed validation.")
			continue
		}
		previous, ok := latest[manifest.OriginalPath]
		if !ok || manifest.ImportedAt > previous.ImportedAt || (manifest.ImportedAt == previous.ImportedAt && manifest.ImportID > previous.ImportID) {
			latest[manifest.OriginalPath] = manifest
		}
	}
	paths := make([]string, 0, len(latest))
	for original := range latest {
		paths = append(paths, original)
	}
	sort.Strings(paths)
	for _, original := range paths {
		manifest := latest[original]
		sourcePath := filepath.Clean(filepath.Join(importsRoot, filepath.FromSlash(original)))
		if !beneath(importsRoot, sourcePath) {
			response.Warnings = append(response.Warnings, "An annual tax statement source path is invalid.")
			continue
		}
		sourceReal, sourceErr := filepath.EvalSymlinks(sourcePath)
		if sourceErr != nil || !beneath(importsReal, sourceReal) {
			response.Imports = append(response.Imports, localPortfolioManifestView(manifest.SourceType, manifest, false))
			response.Warnings = append(response.Warnings, "An annual tax statement source is unavailable.")
			continue
		}
		sourceBytes, sourceErr := os.ReadFile(sourceReal)
		if sourceErr != nil || localSHA256(sourceBytes) != manifest.ContentSHA256 {
			response.Imports = append(response.Imports, localPortfolioManifestView(manifest.SourceType, manifest, false))
			response.Warnings = append(response.Warnings, "An annual tax statement source changed since import.")
			continue
		}
		response.Imports = append(response.Imports, localPortfolioManifestView(manifest.SourceType, manifest, true))
		if manifest.Status == "failed" {
			continue
		}
		data, readErr := os.ReadFile(filepath.Join(outputRoot, manifest.ImportID, "records.json"))
		var records []json.RawMessage
		if readErr != nil || json.Unmarshal(data, &records) != nil {
			response.Warnings = append(response.Warnings, "Annual tax statement rows could not be read.")
			continue
		}
		valid := true
		for _, raw := range records {
			var row struct {
				Source struct {
					ImportID     string `json:"import_id"`
					OriginalPath string `json:"original_path"`
					ContentHash  string `json:"content_sha256"`
					Locator      string `json:"record_locator"`
				} `json:"source"`
			}
			if json.Unmarshal(raw, &row) != nil || row.Source.ImportID != manifest.ImportID || row.Source.OriginalPath != original || row.Source.ContentHash != manifest.ContentSHA256 || row.Source.Locator == "" {
				valid = false
				break
			}
		}
		if !valid {
			response.Warnings = append(response.Warnings, "Annual tax statement row provenance failed validation.")
			continue
		}
		response.AnnualTaxCredits = append(response.AnnualTaxCredits, records...)
	}
}

func GetLocalTaxHistory(c *gin.Context) {
	paths, err := financepaths.Resolve(os.Getenv("PAISA_FINANCE_ROOT"))
	if err != nil {
		c.JSON(http.StatusOK, localTaxHistoryResponse{Returns: []localTaxReturn{}, AIS: []localTaxReturn{}, AnnualTaxCredits: []json.RawMessage{}, Form16: []localTaxReturn{}, Form26AS: []localTaxReturn{}, Imports: []localPortfolioImport{}, Warnings: []string{"Could not locate the local My Finance folder."}})
		return
	}
	c.JSON(http.StatusOK, localTaxHistory(paths.Root))
}
