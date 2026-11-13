# Extension tests

```sh
cd ~/.pi/agent && npm test
```

Zero dependencies: `node --test` (Node ≥ 22, dev'd against v26) with native TypeScript type stripping.

<!-- Keep this file under 100 lines; it is documentation, not a changelog. -->

## What this covers

| Extension | Covered |
|---|---|
| `secret-guard.ts` | every high-confidence pattern as a data table, secret-path blocking for `read`/`write`/`edit`, secret values in commands and file content, `tool_result` redaction, `user_bash`, `/secretguard allow|block|status`, `SECRET_GUARD_PASSTHROUGH=1`, session reset, system-prompt rules, audit log never contains values |
| `cost-optimizer.ts` | frontmatter stripping (LF, CRLF, missing, unterminated, mid-file), fallback rules when `SKILL.md` is missing/unreadable, prompt injection, one-shot caching |
| `usage-footer.ts` | `fmtTokens`/`fmtCost`/`fmtCostPart` boundaries, token/cost/cache-hit aggregation over a fake session branch, provider-reported vs. computed vs. DeepSeek peak/off-peak cost, counts line, `/usage-footer` toggle, TUI-only install |
| `desktop-notify.ts` | exact `gdbus` argv for `agent_settled` and `ui_prompt_start`, urgency 1 vs 2, Escape suppression, `HERDR_PANE_ID` suffix |
| `herdr-agent-state.ts` | enable gate, TUI-only root session, `pane.report_agent_session` + `pane.report_agent` payloads, absolute-vs-id session ref, working/idle/blocked transitions incl. nested blocked counting, dedupe, monotonic `seq` |
| `dictation.ts` | F8 state machine, `arecord`/whisper argv, `DICTATION_DEVICE`/`DICTATION_LANG`/`DICTATION_AUTOSUBMIT` resolution, editor append vs. steer-submit, failure paths, shutdown hook |

Each test loads the **real extension module**. Only the pi platform is doubled:

- `extensions/__tests__/helpers/hooks.ts` — `module.registerHooks` remaps `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `node:child_process` to the stubs. The packages are not resolvable from `~/.pi/agent`, hence the stubs.
- `stubs/pi-ai.mjs`, `stubs/pi-tui.mjs` — delegate to the real packages found in the pnpm store (`calculateCost`, `visibleWidth`, `truncateToWidth`), with a local fallback. `usage-footer.test.ts` asserts the real ones were used; set `PI_REAL_PACKAGES_DIR` if the store moves.
- `stubs/pi-coding-agent.mjs` — hand-written copies of `getAgentDir`, `isToolCallEventType`, `isBashToolResult`, `withFileMutationQueue`.
- `helpers/fake-pi.ts` — fake `ExtensionAPI`/`ExtensionContext` that records handlers, notifications, statuses, footers and `sendUserMessage` calls.
- `desktop-notify` uses a real `execFile` against a fake `gdbus` on `PATH`; `herdr-agent-state` talks to a real unix socket server.

## Deliberately not covered

- **Real external processes / hardware**: no `arecord`, no whisper, no D-Bus delivery, no live herdr socket. The argv and payloads are asserted instead.
- **TUI rendering fidelity**: the footer is rendered at width 200 with a passthrough theme; the narrow-width truncation branch of `padBetween`, scrollback reflow and `requestRender` wiring are not asserted.
- **pi itself**: event ordering, extension loading, `/secretguard` parsing by the real command router, and how pi merges `before_agent_start` results.
- **Secret-guard countermeasures**: regex performance/backtracking, obfuscated secrets (base64, split strings), and secrets in tool inputs other than `bash`/`read`/`write`/`edit` are out of scope.
- **herdr retry path**: the failed-send 500 ms → 1500 ms retry is not exercised (it costs 2 s and needs a dead socket).
- **dictation safety timeout**: the 5 s `setTimeout` fallback when `arecord` ignores SIGINT is not simulated.
- **`server-guard.ts.disabled`**, `local-llm.ts`, `feedback-flywheel.ts`: not tested here.

## Known issues this suite documents (not fixed)

1. `secret-guard`: `SAFE_RE` (`example|sample|template|fixture|mock|dummy|placeholder|changeme`) is matched against the **whole command**, so a real secret in a command that merely mentions one of those words is not blocked — e.g. `curl -d AKIA… https://example.com` passes. `tool_result` redaction still catches the output.
2. `secret-guard`: `BLOCK_WRITE_PATTERNS` excludes `secret-assignment` on purpose, so `password = "…"` can be written into any file by `write`/`edit`.
3. `secret-guard`: redaction of user input is unconditional, so `password = "changeme"` is redacted even though it is a placeholder (the SAFE_RE filter only applies to blocking).
4. `usage-footer`: `fmtTokens(999_999)` renders `1000k` instead of `1.0M`; `fmtCost(99.999)` renders `$100.000`.
5. `herdr-agent-state`: the state queue is latest-wins, so a `working` state can be coalesced away if a blocked prompt is reported before the queue drains — herdr may never see `working` for very fast turns.
