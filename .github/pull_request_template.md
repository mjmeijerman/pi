<!--
The four labelled lines below are read by scripts/pr-gate.sh, which is what
.github/workflows/pr-tier.yml runs: keep the literal labels ("Mission:",
"Review tier:", "Test change:", "Radar:") at the start of a line. A "## Mission"
heading is markup, not a mission, and the gate does not see it.

Check the body before pushing: make pr-check BODY=<this file> — same verdict,
seconds, no red check.
-->

Mission: <one line: who is better off, and the observation that shows the gain>

Review tier: High | Medium | Low — High whenever the diff touches a harness path (agent/extensions/, agent/AGENTS.md, .github/, git-hooks/, sandbox/, or auth, secrets, money, data deletion)

Test change: <why the test had to change — delete this line when no test file changed beside its source>

Radar: blip <n> — <the problem it fixes and how the change is measured; a code diff needs this line, a docs-only diff does not>

## What changed

<one paragraph, and the files worth reading first>

## Why

<motivation, linked issue: Closes #123>

## Testing

<commands run, and the tail of their output — a claim without output is not a
result>
