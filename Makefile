# pi agent setup — one-command install for a new machine.
# Usage:  make setup   (or just: make)

.PHONY: setup bootstrap verify hooks update uninstall mutate mutate-full audit evals evals-install pr-check scripts-test

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

# Quarterly Radar audit (blip 29 harness quality evaluation, blip 39 doc sprawl).
# Staleness is detected by harness-check's review-freshness check; this target is
# the single command the calendar entry needs, so hygiene stops being willpower.
audit:
	@bash $(CURDIR)/scripts/harness-check.sh
	@echo
	@echo "Next: refresh docs/radar-conformance.md against the PDF (its §6 recipe),"
	@echo "then delete every row that no longer earns its place (blip 36)."

# Promptfoo evals of the instructions themselves (blip 110, and the nondeterministic
# half of blip 29): seventeen prompts that check AGENTS.md and the skills change
# behaviour, six of them adversarial. Runs weekly from systemd/pi-evals.timer and by
# hand; not PR CI — it grades a local model, so it is advisory and needs ollama on this
# machine. --no-cache on purpose: a cached replay would report "ran now" with last
# week's answers, and the run record is what harness-check.sh trusts. Every run writes
# agent/evals/last-run.txt. See agent/evals/README.md.
evals:
	@cd $(CURDIR)/agent/evals && npx --yes promptfoo@0.125.1 eval -c promptfooconfig.yaml --no-cache -o .last-run.json; \
		status=$$?; \
		node $(CURDIR)/agent/evals/record-run.mjs $(CURDIR)/agent/evals/.last-run.json; \
		exit $$status

# The PR body gates, before the push instead of after the red check. This is
# the same scripts/pr-gate.sh CI runs, so a local verdict and the CI verdict
# cannot disagree. Give it the body file and nothing else: the script diffs the
# merge base of origin/trunk and HEAD itself, and fails loudly when it cannot,
# rather than checking a diff nobody supplied. PATHS=<file> checks an explicit
# changed-path list instead (a branch you have not pushed yet).
#
#   make pr-check BODY=pr.md
#   make pr-check BODY=pr.md PATHS=changed.txt
#   make pr-check BODY=pr.md BASE=origin/trunk HEAD=HEAD
pr-check:
	@bash $(CURDIR)/scripts/pr-gate.sh --body "$(BODY)" \
		$(if $(or $(BASE),$(HEAD)),--base "$(or $(BASE),origin/trunk)" --head "$(or $(HEAD),HEAD)") \
		$(if $(PATHS),--paths "$(PATHS)")

# The gates' own tests, next to the scripts they test (blip 29 harness quality
# evaluation, blip 38 CI hardening): a gate whose passing case was never run is a
# gate that can go dead quietly. Two suites, and both are globbed so a new test
# file needs no edit here: the node tests (same runner as the extensions, no
# dependencies), then every plain-bash *.test.sh run through bash, since a fresh
# clone has no executable bit on them. Fail-fast: the first suite that goes red
# stops the target with its own exit code, and the echo above each suite names it
# in the CI log.
#
# The runner hands the suite the environment it was started in, inherited slug and
# all. Each bash test owns its own environment instead: the provenance test clears
# AGENT_SLUG and PI_AGENT_SLUG in the cases that assert on a human commit and sets
# the slug it wants in the cases that assert on the hook. Clearing it here would
# hide the same coupling in the next bash test, and would put the reason in a file
# that does not own the behaviour.
scripts-test:
	@echo "== scripts-test: node --test scripts/tests/*.test.mjs"
	@node --test scripts/tests/*.test.mjs
	@for t in scripts/tests/*.test.sh; do \
		[ -e "$$t" ] || continue; \
		echo "== scripts-test: bash $$t"; \
		bash "$$t" || { status=$$?; echo "== scripts-test: FAILED $$t (exit $$status)" >&2; exit $$status; }; \
	done
	@echo "== scripts-test: every suite passed"

update:
	@git pull --ff-only
	@$(CURDIR)/install.sh

# Install and start the weekly eval timer: systemd/pi-evals.{service,timer} copied
# into ~/.config/systemd/user with %h expanded, then enabled. install.sh does the same
# on a full setup; this target re-installs after editing the units.
evals-install:
	@install -d "$${XDG_CONFIG_HOME:-$$HOME/.config}/systemd/user"
	@for f in systemd/pi-evals.service systemd/pi-evals.timer; do \
		sed "s|%h|$$HOME|g" "$$f" > "$${XDG_CONFIG_HOME:-$$HOME/.config}/systemd/user/$$(basename $$f)"; \
		echo "== $$f installed"; \
	done
	@systemctl --user daemon-reload
	@systemctl --user enable --now pi-evals.timer
	@systemctl --user list-timers pi-evals.timer --no-pager

uninstall:
	@echo "Removing secret-guard global git config..."
	@git config --global --unset core.hooksPath || true
	@git config --global --unset core.excludesFile || true
	@git config --global --unset init.templateDir || true
	@echo "Done. Optional cleanup: rm -rf ~/.pi/git-hooks ~/.pi/gitignore_global ~/.git-templates ~/.local/bin/git-vuln-scan"
