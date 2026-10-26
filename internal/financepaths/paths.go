// Package financepaths resolves and checks the local personal finance folder.
package financepaths

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Paths contains the documented local data folders beneath My Finance.
type Paths struct {
	Root      string
	Imports   string
	Inbox     string
	Tax       string
	Banking   string
	Invest    string
	Manual    string
	Extracted string
	Database  string
	Dashboard string
	Backups   string
}

// Resolve returns paths below root. A blank root searches the current directory
// and its parents for an existing "My Finance" folder.
func Resolve(root string) (Paths, error) {
	if root == "" {
		cwd, err := os.Getwd()
		if err != nil {
			return Paths{}, err
		}
		for dir := cwd; ; dir = filepath.Dir(dir) {
			candidate := filepath.Join(dir, "My Finance")
			if info, err := os.Stat(candidate); err == nil && info.IsDir() {
				root = candidate
				break
			}
			parent := filepath.Dir(dir)
			if parent == dir {
				return Paths{}, errors.New("could not find 'My Finance' in the current directory or its parents; pass --root or set PAISA_FINANCE_ROOT")
			}
		}
	}
	abs, err := filepath.Abs(root)
	if err != nil {
		return Paths{}, fmt.Errorf("resolve finance root: %w", err)
	}
	imports := filepath.Join(abs, "imports")
	return Paths{
		Root: abs, Imports: imports,
		Inbox: filepath.Join(imports, "_inbox"),
		Tax:   filepath.Join(imports, "tax"), Banking: filepath.Join(imports, "banking"),
		Invest: filepath.Join(imports, "investments"), Manual: filepath.Join(imports, "manual"),
		Extracted: filepath.Join(abs, "extracted"), Database: filepath.Join(abs, "database"),
		Dashboard: filepath.Join(abs, "dashboard"), Backups: filepath.Join(abs, "backups"),
	}, nil
}

// Check creates generated output directories, then confirms required source
// folders are readable and generated folders are writable. It never creates
// or modifies anything under imports/.
func (p Paths) Check() error {
	inputs := []string{
		p.Imports, p.Inbox,
		filepath.Join(p.Tax, "ais"), filepath.Join(p.Tax, "form-16"),
		filepath.Join(p.Tax, "form-26as"), filepath.Join(p.Tax, "returns"),
		filepath.Join(p.Banking, "icici"), filepath.Join(p.Invest, "cas"),
		filepath.Join(p.Invest, "indmoney"), filepath.Join(p.Invest, "kuvera"),
		filepath.Join(p.Invest, "zerodha"), filepath.Join(p.Manual, "assets-liabilities"),
	}
	for _, dir := range inputs {
		info, err := os.Stat(dir)
		if err != nil {
			return fmt.Errorf("required input folder %q is missing or inaccessible: %w", dir, err)
		}
		if !info.IsDir() {
			return fmt.Errorf("required input folder %q is not a directory", dir)
		}
		f, err := os.Open(dir)
		if err != nil {
			return fmt.Errorf("required input folder %q is not readable: %w", dir, err)
		}
		_ = f.Close()
	}
	for _, dir := range []string{p.Extracted, p.Database, p.Dashboard, p.Backups} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("create generated folder %q: %w", dir, err)
		}
		probe, err := os.CreateTemp(dir, ".paisa-write-check-*")
		if err != nil {
			return fmt.Errorf("generated folder %q is not writable: %w", dir, err)
		}
		name := probe.Name()
		if err := probe.Close(); err != nil {
			_ = os.Remove(name)
			return fmt.Errorf("finish write check in %q: %w", dir, err)
		}
		if err := os.Remove(name); err != nil {
			return fmt.Errorf("remove write check from %q: %w", dir, err)
		}
	}
	return nil
}
