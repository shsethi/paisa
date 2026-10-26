package cmd

import (
	"fmt"
	"os"

	"github.com/ananthakumaran/paisa/internal/financepaths"
	"github.com/spf13/cobra"
)

var financeRoot string

var financePathsCmd = &cobra.Command{
	Use:   "finance-paths",
	Short: "Check local My Finance folders",
	Long:  "Resolve the local finance data folders, create generated output folders, and check source-folder readability and output-folder writability.",
	RunE: func(cmd *cobra.Command, args []string) error {
		root := financeRoot
		if root == "" {
			root = os.Getenv("PAISA_FINANCE_ROOT")
		}
		paths, err := financepaths.Resolve(root)
		if err != nil {
			return err
		}
		if err := paths.Check(); err != nil {
			return err
		}
		fmt.Fprintf(cmd.OutOrStdout(), "Finance root: %s\nImports: %s\nExtracted: %s\nDatabase: %s\nDashboard: %s\nBackups: %s\nLocal finance folders are ready.\n", paths.Root, paths.Imports, paths.Extracted, paths.Database, paths.Dashboard, paths.Backups)
		return nil
	},
}

func init() {
	financePathsCmd.Flags().StringVar(&financeRoot, "root", "", "finance data root (overrides PAISA_FINANCE_ROOT and automatic discovery)")
	rootCmd.AddCommand(financePathsCmd)
}
