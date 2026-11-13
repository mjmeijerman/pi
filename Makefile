# pi agent setup — one-command install for a new machine.
# Usage:  make setup   (or just: make)

.PHONY: setup bootstrap verify hooks update uninstall mutate mutate-full

# Full provisioning on a new machine: config, hooks, system packages, API key,
# pi packages, optional local model / dictation venv, then verification.
setup:
	@$(CURDIR)/setup.sh

# Config and hooks only — no secrets, no system packages, no optional extras.
bootstrap:
	@$(CURDIR)/setup.sh --no-apt --no-verify

verify:
	@echo "== pi:            $$(command -v pi || echo MISSING)"
	@echo "== hooksPath:     $$(git config --global --get core.hooksPath || echo not-set)"
	@echo "== excludesFile:  $$(git config --global --get core.excludesFile || echo not-set)"
	@echo "== templateDir:   $$(git config --global --get init.templateDir || echo not-set)"
	@echo "== git-vuln-scan: $$(command -v git-vuln-scan || echo MISSING)"

hooks:
	@bash $(CURDIR)/git-hooks/install-hooks.sh

# Mutation testing (Radar Vol. 35, blip 2): proves the extension assertions bite.
# Incremental — only mutants whose source or covering tests changed are re-run.
mutate:
	@cd $(CURDIR)/agent && npx stryker run

# Same, throwing the incremental cache away: a full first-pass score.
mutate-full:
	@rm -f $(CURDIR)/agent/reports/stryker/stryker-incremental.json
	@cd $(CURDIR)/agent && npx stryker run

update:
	@git pull --ff-only
	@$(CURDIR)/install.sh

uninstall:
	@echo "Removing secret-guard global git config..."
	@git config --global --unset core.hooksPath || true
	@git config --global --unset core.excludesFile || true
	@git config --global --unset init.templateDir || true
	@echo "Done. Optional cleanup: rm -rf ~/.pi/git-hooks ~/.pi/gitignore_global ~/.git-templates ~/.local/bin/git-vuln-scan"
