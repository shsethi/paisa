package server

import (
	"bytes"
	"encoding/json"
	"math/big"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ananthakumaran/paisa/internal/financepaths"
	"github.com/gin-gonic/gin"
)

type financeManifest struct {
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

type financeRecordSource struct {
	ImportID      string `json:"import_id"`
	OriginalPath  string `json:"original_path"`
	ContentSHA256 string `json:"content_sha256"`
	RecordLocator string `json:"record_locator"`
}

type financeRecord struct {
	RecordType   string              `json:"record_type"`
	SourceID     string              `json:"source_id"`
	Current      string              `json:"current_value"`
	CostBasis    *string             `json:"cost_basis"`
	Units        *string             `json:"units"`
	AveragePrice *string             `json:"average_price"`
	NAV          *string             `json:"nav"`
	AverageNAV   *string             `json:"average_nav"`
	Returns      *string             `json:"total_returns_percent"`
	XIRR         *string             `json:"xirr_percent"`
	Currency     string              `json:"currency"`
	AsOfDate     *string             `json:"as_of_date"`
	BalanceType  string              `json:"balance_type"`
	Amount       *string             `json:"amount"`
	Category     string              `json:"category"`
	Label        *string             `json:"label"`
	Owner        *string             `json:"owner"`
	AccountLabel *string             `json:"account_label"`
	Security     map[string]string   `json:"security"`
	Source       financeRecordSource `json:"source"`
}

type localPortfolioImport struct {
	SourceType    string            `json:"source_type"`
	OriginalPath  string            `json:"original_path"`
	ImportedAt    string            `json:"imported_at"`
	Status        string            `json:"status"`
	RowCounts     localImportCounts `json:"row_counts"`
	ErrorCount    int               `json:"error_count"`
	SourceCurrent bool              `json:"source_current"`
}

type localFinancePortfolioResponse struct {
	Holdings []financeRecord        `json:"holdings"`
	Balances []financeRecord        `json:"balances"`
	Imports  []localPortfolioImport `json:"imports"`
	Warnings []string               `json:"warnings"`
}

type financeImportSource struct {
	name       string
	dataFile   string
	rootPrefix string
	isBalance  bool
}

var financeImportSources = []financeImportSource{
	{name: "kuvera_holdings", dataFile: "holdings.json", rootPrefix: "investments/kuvera/"},
	{name: "indmoney_holdings", dataFile: "holdings.json", rootPrefix: "investments/indmoney/"},
	{name: "nsdl_cas_holdings", dataFile: "holdings.json", rootPrefix: "investments/cas/"},
	{name: "manual_balances", dataFile: "balances.json", rootPrefix: "manual/assets-liabilities/", isBalance: true},
}

type kiteSnapshotManifest struct {
	RecordType    string `json:"record_type"`
	FetchedAt     string `json:"fetched_at"`
	AsOfDate      string `json:"as_of_date"`
	SourceType    string `json:"source_type"`
	APIVersion    string `json:"api_version"`
	SyncVersion   string `json:"sync_version"`
	ContentSHA256 string `json:"content_sha256"`
	Counts        struct {
		Holdings int `json:"holdings"`
	} `json:"counts"`
}

type kiteHolding struct {
	TradingSymbol string      `json:"tradingsymbol"`
	Exchange      string      `json:"exchange"`
	ISIN          string      `json:"isin"`
	Quantity      json.Number `json:"quantity"`
	AveragePrice  json.Number `json:"average_price"`
	LastPrice     json.Number `json:"last_price"`
}

type kiteSnapshot struct {
	Holdings  []kiteHolding   `json:"holdings"`
	Positions json.RawMessage `json:"positions"`
	Margins   json.RawMessage `json:"margins"`
	Orders    json.RawMessage `json:"orders"`
	Trades    json.RawMessage `json:"trades"`
}

type kitePortfolioCandidate struct {
	manifest kiteSnapshotManifest
	holdings []financeRecord
}

func kiteDecimal(value json.Number) (string, bool) {
	text := value.String()
	if text == "" {
		return "", false
	}
	var number json.Number = value
	if _, err := number.Float64(); err != nil {
		return "", false
	}
	if strings.ContainsAny(text, "eE") {
		parsed, err := number.Float64()
		if err != nil {
			return "", false
		}
		text = strings.TrimRight(strings.TrimRight(strconv.FormatFloat(parsed, 'f', 6, 64), "0"), ".")
	}
	return text, true
}

func kiteProduct(left, right json.Number) (string, bool) {
	a, ok := new(big.Rat).SetString(left.String())
	if !ok {
		return "", false
	}
	b, ok := new(big.Rat).SetString(right.String())
	if !ok {
		return "", false
	}
	value := new(big.Rat).Mul(a, b).FloatString(6)
	value = strings.TrimRight(strings.TrimRight(value, "0"), ".")
	if value == "-0" || value == "" {
		value = "0"
	}
	return value, true
}

func normalizeKiteHoldings(manifest kiteSnapshotManifest, rows []kiteHolding) ([]financeRecord, bool) {
	records := make([]financeRecord, 0, len(rows))
	seen := make(map[string]bool)
	for _, row := range rows {
		symbol := strings.TrimSpace(row.TradingSymbol)
		exchange := strings.TrimSpace(row.Exchange)
		if symbol == "" || exchange == "" {
			return nil, false
		}
		locator := exchange + ":" + symbol
		if seen[locator] {
			return nil, false
		}
		seen[locator] = true
		units, unitsOK := kiteDecimal(row.Quantity)
		average, averageOK := kiteDecimal(row.AveragePrice)
		last, lastOK := kiteDecimal(row.LastPrice)
		current, currentOK := kiteProduct(row.Quantity, row.LastPrice)
		cost, costOK := kiteProduct(row.Quantity, row.AveragePrice)
		if !unitsOK || !averageOK || !lastOK || !currentOK || !costOK {
			return nil, false
		}
		identifier := strings.TrimSpace(row.ISIN)
		if identifier == "" {
			identifier = locator
		}
		asOfDate := manifest.AsOfDate
		security := map[string]string{"identifier": identifier, "symbol": symbol, "name": symbol, "category": "Equity"}
		if strings.TrimSpace(row.ISIN) != "" {
			security["isin"] = strings.TrimSpace(row.ISIN)
		}
		records = append(records, financeRecord{
			RecordType: "holding", SourceID: localSHA256([]byte("zerodha_kite_api\n" + manifest.ContentSHA256 + "\n" + locator)),
			Current: current, CostBasis: &cost, Units: &units, AveragePrice: &average, NAV: &last,
			Currency: "INR", AsOfDate: &asOfDate, Security: security,
			Source: financeRecordSource{ImportID: manifest.ContentSHA256, OriginalPath: "api/zerodha/" + manifest.AsOfDate, ContentSHA256: manifest.ContentSHA256, RecordLocator: locator},
		})
	}
	return records, true
}

func latestKitePortfolio(root string) (*kitePortfolioCandidate, bool) {
	base := filepath.Join(root, "extracted", "api", "zerodha")
	dates, err := os.ReadDir(base)
	if err != nil {
		return nil, !os.IsNotExist(err)
	}
	var latest *kitePortfolioCandidate
	invalid := false
	for _, dateEntry := range dates {
		if !dateEntry.IsDir() || len(dateEntry.Name()) != 10 {
			continue
		}
		datePath := filepath.Join(base, dateEntry.Name())
		snapshots, readErr := os.ReadDir(datePath)
		if readErr != nil {
			invalid = true
			continue
		}
		for _, snapshotEntry := range snapshots {
			if !snapshotEntry.IsDir() {
				continue
			}
			directory := filepath.Join(datePath, snapshotEntry.Name())
			manifestBytes, manifestErr := os.ReadFile(filepath.Join(directory, "manifest.json"))
			snapshotBytes, snapshotErr := os.ReadFile(filepath.Join(directory, "snapshot.json"))
			var manifest kiteSnapshotManifest
			if manifestErr != nil || snapshotErr != nil || json.Unmarshal(manifestBytes, &manifest) != nil || manifest.RecordType != "zerodha_kite_snapshot_manifest" || manifest.SourceType != "zerodha_kite_api" || manifest.APIVersion != "3" || manifest.AsOfDate != dateEntry.Name() || localSHA256(snapshotBytes) != manifest.ContentSHA256 {
				invalid = true
				continue
			}
			if _, parseErr := time.Parse(time.RFC3339Nano, manifest.FetchedAt); parseErr != nil {
				invalid = true
				continue
			}
			decoder := json.NewDecoder(bytes.NewReader(snapshotBytes))
			decoder.UseNumber()
			var snapshot kiteSnapshot
			if decoder.Decode(&snapshot) != nil || manifest.Counts.Holdings != len(snapshot.Holdings) {
				invalid = true
				continue
			}
			holdings, ok := normalizeKiteHoldings(manifest, snapshot.Holdings)
			if !ok {
				invalid = true
				continue
			}
			candidate := &kitePortfolioCandidate{manifest: manifest, holdings: holdings}
			if latest == nil || candidate.manifest.FetchedAt > latest.manifest.FetchedAt || (candidate.manifest.FetchedAt == latest.manifest.FetchedAt && candidate.manifest.ContentSHA256 > latest.manifest.ContentSHA256) {
				latest = candidate
			}
		}
	}
	return latest, invalid
}

func appendLatestKitePortfolio(response *localFinancePortfolioResponse, root string) {
	latest, invalid := latestKitePortfolio(root)
	if invalid {
		response.Warnings = append(response.Warnings, "A Zerodha Kite API snapshot failed validation and was ignored.")
	}
	if latest == nil {
		return
	}
	response.Holdings = append(response.Holdings, latest.holdings...)
	response.Imports = append(response.Imports, localPortfolioImport{
		SourceType: "zerodha_kite_api", OriginalPath: "api/zerodha/" + latest.manifest.AsOfDate,
		ImportedAt: latest.manifest.FetchedAt, Status: "succeeded",
		RowCounts: localImportCounts{Read: len(latest.holdings), Accepted: len(latest.holdings)}, SourceCurrent: true,
	})
}

func localFinancePortfolio(root string) localFinancePortfolioResponse {
	response := localFinancePortfolioResponse{Holdings: []financeRecord{}, Balances: []financeRecord{}, Imports: []localPortfolioImport{}, Warnings: []string{}}
	importsRoot := filepath.Join(root, "imports")
	importsRootReal, err := filepath.EvalSymlinks(importsRoot)
	if err != nil {
		response.Warnings = append(response.Warnings, "Local finance imports folder is unavailable.")
		return response
	}
	for _, source := range financeImportSources {
		outputRoot := filepath.Join(root, "extracted", "imports", source.name)
		entries, readErr := os.ReadDir(outputRoot)
		if readErr != nil {
			if !os.IsNotExist(readErr) {
				response.Warnings = append(response.Warnings, "A local portfolio import folder could not be read.")
			}
			continue
		}
		latest := make(map[string]financeManifest)
		for _, entry := range entries {
			if !entry.IsDir() {
				continue
			}
			manifestPath := filepath.Join(outputRoot, entry.Name(), "manifest.json")
			data, err := os.ReadFile(manifestPath)
			if err != nil {
				response.Warnings = append(response.Warnings, "A local portfolio manifest could not be read.")
				continue
			}
			var manifest financeManifest
			if json.Unmarshal(data, &manifest) != nil || manifest.RecordType != "import_manifest" || manifest.SourceType != source.name || manifest.ImportID != entry.Name() || manifest.ImportID != localSHA256([]byte(manifest.SourceType+"\n"+manifest.OriginalPath+"\n"+manifest.ContentSHA256)) || !strings.HasPrefix(manifest.OriginalPath, source.rootPrefix) {
				response.Warnings = append(response.Warnings, "A local portfolio manifest failed validation.")
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
				response.Warnings = append(response.Warnings, "A local portfolio source path is invalid.")
				continue
			}
			sourceReal, sourceErr := filepath.EvalSymlinks(sourcePath)
			if sourceErr != nil || !beneath(importsRootReal, sourceReal) {
				response.Imports = append(response.Imports, localPortfolioManifestView(source.name, manifest, false))
				response.Warnings = append(response.Warnings, "A local portfolio source is unavailable; re-import it to refresh the view.")
				continue
			}
			sourceBytes, sourceErr := os.ReadFile(sourceReal)
			if sourceErr != nil || localSHA256(sourceBytes) != manifest.ContentSHA256 {
				response.Imports = append(response.Imports, localPortfolioManifestView(source.name, manifest, false))
				response.Warnings = append(response.Warnings, "A local portfolio source changed after import; re-import it to refresh the view.")
				continue
			}
			response.Imports = append(response.Imports, localPortfolioManifestView(source.name, manifest, true))
			if manifest.Status == "failed" {
				continue
			}
			data, err := os.ReadFile(filepath.Join(outputRoot, manifest.ImportID, source.dataFile))
			if err != nil {
				response.Warnings = append(response.Warnings, "A local portfolio record file could not be read.")
				continue
			}
			var records []financeRecord
			if json.Unmarshal(data, &records) != nil {
				response.Warnings = append(response.Warnings, "A local portfolio record file is invalid.")
				continue
			}
			valid := true
			for _, record := range records {
				if record.RecordType == "" || record.SourceID == "" || record.Source.ImportID != manifest.ImportID || record.Source.OriginalPath != manifest.OriginalPath || record.Source.ContentSHA256 != manifest.ContentSHA256 || record.Source.RecordLocator == "" {
					valid = false
					break
				}
			}
			if !valid {
				response.Warnings = append(response.Warnings, "A local portfolio record failed provenance checks.")
				continue
			}
			if source.isBalance {
				response.Balances = append(response.Balances, records...)
			} else {
				response.Holdings = append(response.Holdings, records...)
			}
		}
	}
	appendLatestKitePortfolio(&response, root)
	return response
}

func localPortfolioManifestView(sourceType string, manifest financeManifest, current bool) localPortfolioImport {
	return localPortfolioImport{SourceType: sourceType, OriginalPath: manifest.OriginalPath, ImportedAt: manifest.ImportedAt, Status: manifest.Status, RowCounts: manifest.RowCounts, ErrorCount: len(manifest.Errors), SourceCurrent: current}
}

func GetLocalFinancePortfolio(c *gin.Context) {
	paths, err := financepaths.Resolve(os.Getenv("PAISA_FINANCE_ROOT"))
	if err != nil {
		c.JSON(http.StatusOK, localFinancePortfolioResponse{Holdings: []financeRecord{}, Balances: []financeRecord{}, Imports: []localPortfolioImport{}, Warnings: []string{"Could not locate the local My Finance folder."}})
		return
	}
	c.JSON(http.StatusOK, localFinancePortfolio(paths.Root))
}
