package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/ananthakumaran/paisa/internal/financepaths"
	"github.com/gin-gonic/gin"
)

type localImportCounts struct {
	Read     int `json:"read"`
	Accepted int `json:"accepted"`
	Rejected int `json:"rejected"`
	Skipped  int `json:"skipped"`
}

type localICICIManifest struct {
	RecordType    string            `json:"record_type"`
	ImportID      string            `json:"import_id"`
	SourceType    string            `json:"source_type"`
	OriginalPath  string            `json:"original_path"`
	ContentSHA256 string            `json:"content_sha256"`
	ImportedAt    string            `json:"imported_at"`
	Status        string            `json:"status"`
	RowCounts     localImportCounts `json:"row_counts"`
	Errors        []json.RawMessage `json:"errors"`
}

type localICICITransactionRecord struct {
	RecordType           string  `json:"record_type"`
	SourceID             string  `json:"source_id"`
	Date                 string  `json:"date"`
	Description          string  `json:"description"`
	Debit                *string `json:"debit"`
	Credit               *string `json:"credit"`
	Currency             string  `json:"currency"`
	Balance              *string `json:"balance"`
	Category             *string `json:"category"`
	Classification       *string `json:"classification"`
	ClassificationDetail struct {
		Rule         string `json:"rule"`
		Reason       string `json:"reason"`
		Confidence   string `json:"confidence"`
		ReviewNeeded bool   `json:"review_needed"`
	} `json:"classification_detail"`
	Source struct {
		ImportID      string `json:"import_id"`
		OriginalPath  string `json:"original_path"`
		ContentSHA256 string `json:"content_sha256"`
		RecordLocator string `json:"record_locator"`
	} `json:"source"`
	ReviewStatus string `json:"review_status"`
}

type localICICITransactionView struct {
	Date                 string  `json:"date"`
	Description          string  `json:"description"`
	Debit                *string `json:"debit"`
	Credit               *string `json:"credit"`
	Currency             string  `json:"currency"`
	Balance              *string `json:"balance"`
	Category             *string `json:"category"`
	Classification       *string `json:"classification"`
	ClassificationDetail struct {
		Rule         string `json:"rule"`
		Reason       string `json:"reason"`
		Confidence   string `json:"confidence"`
		ReviewNeeded bool   `json:"review_needed"`
	} `json:"classification_detail"`
	ReviewStatus string `json:"review_status"`
	Source       struct {
		OriginalPath  string `json:"original_path"`
		RecordLocator string `json:"record_locator"`
	} `json:"source"`
}

type localImportedSource struct {
	OriginalPath  string            `json:"original_path"`
	ImportedAt    string            `json:"imported_at"`
	Status        string            `json:"status"`
	RowCounts     localImportCounts `json:"row_counts"`
	ErrorCount    int               `json:"error_count"`
	SourceCurrent bool              `json:"source_current"`
}

type localICICIResponse struct {
	Transactions []localICICITransactionView `json:"transactions"`
	Imports      []localImportedSource       `json:"imports"`
	Warnings     []string                    `json:"warnings"`
}

func localSHA256(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func beneath(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)) && !filepath.IsAbs(relative)
}

func loadLocalICICITransactions(root string) localICICIResponse {
	response := localICICIResponse{
		Transactions: []localICICITransactionView{},
		Imports:      []localImportedSource{},
		Warnings:     []string{},
	}
	importsRoot := filepath.Join(root, "imports")
	outputRoot := filepath.Join(root, "extracted", "imports", "icici")
	importsRootReal, err := filepath.EvalSymlinks(importsRoot)
	if err != nil {
		response.Warnings = append(response.Warnings, "Local finance imports folder is unavailable.")
		return response
	}
	iciciRootReal, err := filepath.EvalSymlinks(filepath.Join(importsRoot, "banking", "icici"))
	if err != nil {
		response.Warnings = append(response.Warnings, "Local ICICI source folder is unavailable.")
		return response
	}
	entries, err := os.ReadDir(outputRoot)
	if err != nil {
		if !os.IsNotExist(err) {
			response.Warnings = append(response.Warnings, "Local ICICI import records could not be read.")
		}
		return response
	}

	latest := make(map[string]localICICIManifest)
	manifestPath := make(map[string]string)
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		manifestFile := filepath.Join(outputRoot, entry.Name(), "manifest.json")
		data, readErr := os.ReadFile(manifestFile)
		if readErr != nil {
			response.Warnings = append(response.Warnings, "An ICICI import manifest could not be read.")
			continue
		}
		var manifest localICICIManifest
		if json.Unmarshal(data, &manifest) != nil ||
			manifest.RecordType != "import_manifest" ||
			manifest.SourceType != "icici_bank_statement" ||
			!strings.HasPrefix(manifest.OriginalPath, "banking/icici/") ||
			manifest.ImportID != entry.Name() ||
			manifest.ImportID != localSHA256([]byte(manifest.SourceType+"\n"+manifest.OriginalPath+"\n"+manifest.ContentSHA256)) {
			response.Warnings = append(response.Warnings, "An ICICI import manifest is invalid.")
			continue
		}
		previous, exists := latest[manifest.OriginalPath]
		if !exists || manifest.ImportedAt > previous.ImportedAt ||
			(manifest.ImportedAt == previous.ImportedAt && manifest.ImportID > previous.ImportID) {
			latest[manifest.OriginalPath] = manifest
			manifestPath[manifest.OriginalPath] = filepath.Join(outputRoot, entry.Name(), "transactions.json")
		}
	}

	paths := make([]string, 0, len(latest))
	for originalPath := range latest {
		paths = append(paths, originalPath)
	}
	sort.Strings(paths)
	for _, originalPath := range paths {
		manifest := latest[originalPath]
		sourcePath := filepath.Clean(filepath.Join(importsRoot, filepath.FromSlash(originalPath)))
		if !beneath(importsRoot, sourcePath) || !beneath(filepath.Join(importsRoot, "banking", "icici"), sourcePath) {
			response.Warnings = append(response.Warnings, "An ICICI source path is invalid.")
			continue
		}
		sourceReal, sourceErr := filepath.EvalSymlinks(sourcePath)
		if sourceErr != nil || !beneath(importsRootReal, sourceReal) || !beneath(iciciRootReal, sourceReal) {
			response.Imports = append(response.Imports, sourceSummary(manifest, false))
			response.Warnings = append(response.Warnings, "An ICICI source file is unavailable; re-import it to refresh the local view.")
			continue
		}
		sourceBytes, sourceErr := os.ReadFile(sourceReal)
		if sourceErr != nil || localSHA256(sourceBytes) != manifest.ContentSHA256 {
			response.Imports = append(response.Imports, sourceSummary(manifest, false))
			response.Warnings = append(response.Warnings, "An ICICI source file has changed since import; re-import it to refresh the local view.")
			continue
		}
		response.Imports = append(response.Imports, sourceSummary(manifest, true))
		if manifest.Status == "failed" {
			continue
		}
		data, readErr := os.ReadFile(manifestPath[originalPath])
		if readErr != nil {
			response.Warnings = append(response.Warnings, "An ICICI transaction file could not be read.")
			continue
		}
		var records []localICICITransactionRecord
		if json.Unmarshal(data, &records) != nil {
			response.Warnings = append(response.Warnings, "An ICICI transaction file is invalid.")
			continue
		}
		valid := true
		for _, transaction := range records {
			if transaction.RecordType != "bank_transaction" ||
				transaction.Source.ImportID != manifest.ImportID ||
				transaction.Source.ContentSHA256 != manifest.ContentSHA256 ||
				transaction.Source.OriginalPath != manifest.OriginalPath ||
				transaction.SourceID != localSHA256([]byte(manifest.SourceType+"\n"+manifest.ContentSHA256+"\n"+transaction.Source.RecordLocator)) {
				valid = false
				break
			}
		}
		if !valid {
			response.Warnings = append(response.Warnings, "An ICICI transaction file failed provenance checks.")
			continue
		}
		for _, record := range records {
			response.Transactions = append(response.Transactions, toLocalICICITransactionView(record))
		}
	}
	sort.SliceStable(response.Transactions, func(i, j int) bool {
		if response.Transactions[i].Date == response.Transactions[j].Date {
			return response.Transactions[i].Source.RecordLocator > response.Transactions[j].Source.RecordLocator
		}
		return response.Transactions[i].Date > response.Transactions[j].Date
	})
	return response
}

func sourceSummary(manifest localICICIManifest, sourceCurrent bool) localImportedSource {
	return localImportedSource{
		OriginalPath:  manifest.OriginalPath,
		ImportedAt:    manifest.ImportedAt,
		Status:        manifest.Status,
		RowCounts:     manifest.RowCounts,
		ErrorCount:    len(manifest.Errors),
		SourceCurrent: sourceCurrent,
	}
}

func toLocalICICITransactionView(record localICICITransactionRecord) localICICITransactionView {
	var view localICICITransactionView
	view.Date = record.Date
	view.Description = record.Description
	view.Debit = record.Debit
	view.Credit = record.Credit
	view.Currency = record.Currency
	view.Balance = record.Balance
	view.Category = record.Category
	view.Classification = record.Classification
	view.ClassificationDetail = record.ClassificationDetail
	view.ReviewStatus = record.ReviewStatus
	view.Source.OriginalPath = record.Source.OriginalPath
	view.Source.RecordLocator = record.Source.RecordLocator
	return view
}

func GetLocalICICITransactions(c *gin.Context) {
	root, err := financepaths.Resolve(os.Getenv("PAISA_FINANCE_ROOT"))
	if err != nil {
		c.JSON(http.StatusOK, localICICIResponse{
			Transactions: []localICICITransactionView{},
			Imports:      []localImportedSource{},
			Warnings:     []string{"Could not locate the local My Finance folder."},
		})
		return
	}
	c.JSON(http.StatusOK, loadLocalICICITransactions(root.Root))
}
