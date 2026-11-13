# pi agent setup — one-command install for a new machine.
# Usage:  make setup   (or just: make)

.PHONY: setup verify hooks update uninstall

setup:
	@$(CURDIR)/install.sh --install-pi

verify:
	@echo "== pi:            $$(command -v pi || echo MISSING)"
	@echo "== hooksPath:     $$(git config --global --get core.hooksPath || echo not-set)"
	@echo "== excludesFile:  $$(git config --global --get core.excludesFile || echo not-set)"
	@echo "== templateDir:   $$(git config --global --get init.templateDir || echo not-set)"
	@echo "== git-vuln-scan: $$(command -v git-vuln-scan || echo MISSING)"

hooks:
	@bash $(CURDIR)/git-hooks/install-hooks.sh

update:
	@git pull --ff-only
	@$(CURDIR)/install.sh

uninstall:
	@echo "Removing secret-guard global git config..."
	@git config --global --unset core.hooksPath || true
	@git config --global --unset core.excludesFile || true
	@git config --global --unset init.templateDir || true
	@echo "Done. Optional cleanup: rm -rf ~/.pi/git-hooks ~/.pi/gitignore_global ~/.git-templates ~/.local/bin/git-vuln-scan"
