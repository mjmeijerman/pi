# Mutation survivors — the decided ones

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-18 — half-yearly, or after any survivor sweep.

**What this file is.** The record a survivor leaves behind when it is not killed: the input domain
it cannot be observed on, or the test that finally killed it. A survivor with no row here is an
open item, not a decision. The rules for reading a survivor (group by what the mutation changes,
ask what the guard's contract at that line is, never write a vacuous test) are in
`specs/areas/secret-guard.md` and in the sweep reports; this file only holds the verdicts.

Scope: the whole mutated set, not one file — `agent/extensions/secret-guard.ts`,
`agent/extensions/merge-guard.ts`, `agent/extensions/lib/usage-format.ts`, and (since the
`test/guard-survivors` sweep) `agent/extensions/big-boss-pi-guard.ts`,
`agent/extensions/pi-master-guard.ts` and `agent/extensions/config-guard.ts` (this is wider than
the file it replaces, which covered `secret-guard.ts` only). Widened because every count this repo
quotes is the full run: a ledger that reconciles 80 sweep rows against a 84-mutant run has to name
every file in the glob or the arithmetic cannot close.

Measured on `test/guard-survivors` (trunk `8dba206` + this ledger's branch), 2026-11-18:

```
cd agent && rm -f reports/stryker/stryker-incremental.json
./node_modules/.bin/stryker run --force
```

1909 mutants — **1765 killed, 142 survived, 2 timeout, 0 no-coverage, 92.56%**, 13m51s.

The run as reported by stryker was 1764 killed / 143 survived / 2 timeout at 92.51%; the
`config-guard.ts` timing mutant (`58:14`, `performance.now() + started`) survived that run because
the first version of its test only claimed "under a second" and this process had been up far
shorter than that. The test now compares `ms` against the wall time of the same call, the follow-up
per-file run is 52/52 killed in 41s (`config-guard.ts` 100.00%), and the totals above carry that
one mutant as killed.

| File | Mutants | Killed | Survived | Timeout | Score |
| --- | --- | --- | --- | --- | --- |
| `extensions/lib/usage-format.ts` | 75 | 72 | 3 | 0 | 96.00% |
| `extensions/merge-guard.ts` | 342 | 331 | 11 | 0 | 96.78% |
| `extensions/secret-guard.ts` | 1060 | 993 | 67 | 0 | 93.68% |
| `extensions/big-boss-pi-guard.ts` | 305 | 252 | 51 | 2 | 83.28% |
| `extensions/pi-master-guard.ts` | 75 | 65 | 10 | 0 | 86.67% |
| `extensions/config-guard.ts` | 52 | 52 | 0 | 0 | 100.00% |
| **all six** | **1909** | **1765** | **142** | **2** | **92.56%** |

A timeout counts as killed. The number to quote is **142**, measured; the earlier numbers were
true of other trees and are reconciled below. The three guards are appended to `mutate` after the
three older entries on purpose: stryker numbers mutants in glob order, so appending is what keeps
every `#id` in this file pointing at the mutant it named before.

## Why 81 and not 84, and not 80

Both stale numbers were measured on sources this tree no longer has, and the arithmetic closes:

| where | tree | mutants | survived | what changed after it |
| --- | --- | --- | --- | --- |
| `reports/mutation-survivors-2.md` | trunk `2034027` | 1475 | 80 | #156 changed the redirect test in `secret-guard.ts` and added two mutants |
| `reports/mutation-determinism.md` | `173000b` (flake fix) | 1475 | 84 | #156: +5 killed, −3 survivors, +2 mutants (both killed) |
| this file | trunk `8dba206` | 1477 | **81** | — |

84 − 3 = 81, and 1477 = 1475 + 2 with 1396 = 1391 + 5: the two new mutants #156 introduced are
killed, and three mutants that survived the flake-fixed tree are now dead. The four mutants the
flake had hidden from the 80-row sweep (`#122`, `#214`, `#762`, `#786` here) are all in the table
below, so nothing was lost going from 80 to 81.

## Dead: decided survivors that a test now kills

| Id | Line:col | Mutation | Killed by |
| --- | --- | --- | --- |
| `#936` | `secret-guard.ts` 383:19 | EqualityOperator — `i <= words.length` | `secret-guard-fd-redirect.test.ts` › `secret-guard: redirect operator with a stream number`; also › `a stream copy is not a redirect, even with a credential file after it`. This is ledger row #507, which the 80-row sweep left as documented |
| `#943` | `secret-guard.ts` 384:8 | Regex — `/^\d*>>?$/` loses its `^` | `secret-guard-fd-redirect.test.ts` › `a word ending in > is a word, not an operator`; also the stream-number test. **The successor of the `381:8` finding**: the shipped regex became `/^\d*>>?$/` in #156, and the mutant that made the fd-redirect hole visible is now killed rather than open |
| `#1151` | `secret-guard.ts` 546:13 | Regex — `/(?:--?[\w-]+=?|[\w.-]+=)?@(.+)$/` | `secret-guard-flow.test.ts` › `an \`@\` inside a user@host operand is not a file body` (#155) |
| `#819` | `pi-master-guard.ts` 34:21 | Regex — `/(^\|[\s;&\|(])(rm\|rmdir\|mv\|cp\|dd\|tee\|truncate\|…` | `pi-master-guard-mutants.test.ts` › `shellWriteReason("bash -c echo a  > rm /home/mark/pi-master/x")` |
| `#819` | `pi-master-guard.ts` 34:21 | Regex — `/(^\|[\s;&\|(])(rm\|rmdir\|mv\|cp\|dd\|tee\|truncate\|…` | `pi-master-guard-mutants.test.ts` › `shellWriteReason("echo 'a' > '/home/mark/pi-master/x'")` |
| `#819` | `pi-master-guard.ts` 34:21 | Regex — `/(^\|[\s;&\|(])(rm\|rmdir\|mv\|cp\|dd\|tee\|truncate\|…` | `pi-master-guard-mutants.test.ts` › `shellWriteReason("bash -c echo a  > rm /home/mark/pi-master/x")` |
| `#822` | `pi-master-guard.ts` 35:18 | Regex — `/^\S*(delegate\|jev\|hc\|herdr-app\|herdr)\b/` | `pi-master-guard-mutants.test.ts` › `shellWriteReason("delegate echo a  >> rm /home/mark/pi-master/x")` |
| `#825` | `pi-master-guard.ts` 39:7 | ConditionalExpression — `true` | `pi-master-guard-mutants.test.ts` › `shellWriteReason("rm /home/mark/big-boss-pi/x")` |
| `#828` | `pi-master-guard.ts` 40:7 | ConditionalExpression — `false` | `pi-master-guard-mutants.test.ts` › `shellWriteReason("delegate echo a  >> rm /home/mark/pi-master/x")` |
| `#835` | `pi-master-guard.ts` 48:3 | StringLiteral — `""` | `pi-master-guard-mutants.test.ts` › `bash in /home/mark/pi-master (PI_WORKER=null)` |
| `#834` | `pi-master-guard.ts` 47:3 | StringLiteral — `""` | `pi-master-guard-mutants.test.ts` › `bash in /home/mark/pi-master (PI_WORKER=null)` |
| `#850` | `pi-master-guard.ts` 55:19 | StringLiteral — `""` | `pi-master-guard-mutants.test.ts` › `write in /home/mark/pi-master (PI_WORKER=null)` |
| `#862` | `pi-master-guard.ts` 62:19 | StringLiteral — `""` | `pi-master-guard-mutants.test.ts` › `bash in /home/mark/pi-master (PI_WORKER=null)` |
| `#863` | `pi-master-guard.ts` 62:74 | StringLiteral — `""` | `pi-master-guard-mutants.test.ts` › `bash in /home/mark/pi-master (PI_WORKER=null)` |
| `#31` | `big-boss-pi-guard.ts` 73:40 | ConditionalExpression — `false` | `big-boss-pi-guard-mutants.test.ts` › `delegationPath("/home/mark/big-boss-pi/reports")` |
| `#33` | `big-boss-pi-guard.ts` 73:51 | StringLiteral — ```` | `big-boss-pi-guard-mutants.test.ts` › `delegationPath("/home/mark/big-boss-pi/reports")` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<-EOF\n\trm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#56` | `big-boss-pi-guard.ts` 83:26 | Regex — `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("cat <<'EOF'\nrm /home/mark/pi-master/x\nEOF", /home/mark/big-boss-pi)` |
| `#65` | `big-boss-pi-guard.ts` 90:10 | StringLiteral — `""` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("sudo echo a \nrm /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#68` | `big-boss-pi-guard.ts` 92:22 | MethodExpression — `segment` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("(echo a  >\| sudo rm /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#70` | `big-boss-pi-guard.ts` 97:21 | Regex — `/^(rm\|mv\|cp\|tee\|touch\|truncate\|mkdir\|rmdir\|ln…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("rmx /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#70` | `big-boss-pi-guard.ts` 97:21 | Regex — `/^(rm\|mv\|cp\|tee\|touch\|truncate\|mkdir\|rmdir\|ln…` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("xrm /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#107` | `big-boss-pi-guard.ts` 126:36 | Regex — `/^-[a-zA-Z]*c[^a-zA-Z]*$/` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("bash -lc 'rm /home/mark/pi-master/x'", /home/mark/big-boss-pi)` |
| `#113` | `big-boss-pi-guard.ts` 130:8 | ConditionalExpression — `true` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("X=1 rm /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#115` | `big-boss-pi-guard.ts` 130:8 | EqualityOperator — `i <= 0` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("X=1 rm /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#131` | `big-boss-pi-guard.ts` 138:8 | ConditionalExpression — `true` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("bash -c echo a  > sed -i /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#136` | `big-boss-pi-guard.ts` 138:29 | ConditionalExpression — `false` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("perl -i /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#138` | `big-boss-pi-guard.ts` 138:41 | StringLiteral — `""` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("perl -i /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#137` | `big-boss-pi-guard.ts` 138:29 | EqualityOperator — `command !== "perl"` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("bash -c echo a  > sed -i /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#145` | `big-boss-pi-guard.ts` 138:86 | Regex — `/^-[^a-zA-Z]*i/` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("sed -n /home/mark/big-boss-pi/x", /home/mark/big-boss-pi)` |
| `#145` | `big-boss-pi-guard.ts` 138:86 | Regex — `/^-[^a-zA-Z]*i/` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("perl -pi -e 's/a/b/' /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#159` | `big-boss-pi-guard.ts` 154:14 | Regex — `/>>?\s*([\s;&\|>]+)/g` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("jev echo a  >rm /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#182` | `big-boss-pi-guard.ts` 166:7 | ConditionalExpression — `false` | `big-boss-pi-guard-mutants.test.ts` › `edit in /home/mark/big-boss-pi/specs (PI_WORKER=null)` |
| `#184` | `big-boss-pi-guard.ts` 167:20 | MethodExpression — `cleaned.endsWith("~")` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("rm ~/pi-master/x", /home/mark/big-boss-pi)` |
| `#188` | `big-boss-pi-guard.ts` 168:10 | MethodExpression — `expanded.endsWith("/")` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("sed -i.bak 's/a/b/' /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#198` | `big-boss-pi-guard.ts` 184:25 | LogicalOperator — `segment.split(/\s+/)[0] && ""` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("sudo rm /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#200` | `big-boss-pi-guard.ts` 184:39 | Regex — `/\S+/` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("sudo rm /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#202` | `big-boss-pi-guard.ts` 184:56 | LogicalOperator — `verb?.split(/\s+/)[0] && ""` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("sudo rm /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#204` | `big-boss-pi-guard.ts` 184:68 | Regex — `/\s/` | `big-boss-pi-guard-mutants.test.ts` › `shellWriteReason("sudo rm /home/mark/pi-master/x", /home/mark/big-boss-pi)` |
| `#277` | `big-boss-pi-guard.ts` 233:8 | ConditionalExpression — `false` | `big-boss-pi-guard-mutants.test.ts` › `bash in /home/mark/projects/bakmark (PI_WORKER=null)` |
| `#290` | `big-boss-pi-guard.ts` 239:92 | StringLiteral — `""` | `big-boss-pi-guard-mutants.test.ts` › `write in /home/mark/big-boss-pi (PI_WORKER=null)` |
| `#293` | `big-boss-pi-guard.ts` 243:7 | StringLiteral — `""` | `big-boss-pi-guard-mutants.test.ts` › `write in /home/mark/big-boss-pi (PI_WORKER=null)` |
| `#296` | `big-boss-pi-guard.ts` 247:8 | ConditionalExpression — `false` | `big-boss-pi-guard-mutants.test.ts` › `read in /home/mark/big-boss-pi (PI_WORKER=null)` |
| `#302` | `big-boss-pi-guard.ts` 250:18 | StringLiteral — `""` | `big-boss-pi-guard-mutants.test.ts` › `bash in /home/mark/big-boss-pi (PI_WORKER=null)` |
| `#303` | `big-boss-pi-guard.ts` 250:81 | StringLiteral — `""` | `big-boss-pi-guard-mutants.test.ts` › `bash in /home/mark/big-boss-pi (PI_WORKER=null)` |
| `#329` | `config-guard.ts` 58:14 | ArithmeticOperator — `performance.now() + started` | `config-guard-mutants.test.ts` › `the reported cost is the call's own duration, not an absolute timestamp` |

The rows the `2a51509` ledger recorded as dead do not carry over by line, so each was checked
rather than copied. The two `NET_TARGET_RE` rows (`#437`, `#438`) name an identifier that is no
longer in the source — `grep NET_TARGET_RE agent/extensions/secret-guard.ts` finds nothing at
`8dba206`, so those mutants are **gone**, not open, and the behaviour they pinned is still held by
`secret-guard-net-target.test.ts` (`a host with a trailing root dot is a host`). The `(args ?? "")`
row (`#1034`) sits at line 795 now; its LogicalOperator mutant is killed and its surviving
StringLiteral sibling is `#1479` in the table below, carrying the `2a51509` proof.

## Surviving, with its domain named

81 rows, one per mutant, keyed on file+line+column. Two mutants can share a line and one mutant
can share a column with another (`153:7` has three, `546:13` has three), so the location triple is
the key and the replacement is what tells them apart. **Proof** is `doc #NNN` when the row is in
the earlier ledger by number, `eq, 80-row sweep` when the 80-row sweep's differential run
(7,455 scripts for `secret-guard.ts`, 60,438 numbers for `usage-format.ts`, 212,850 commands for
`merge-guard.ts`) already proved it on byte-identical source, and `new here` when this sweep is the
first to decide it.

### `lib/usage-format.ts`

| Id | Line:col | Mutator | Replacement | Domain it cannot be observed on | Proof |
| --- | --- | --- | --- | --- | --- |
| `#10` | 27:7 | EqualityOperator | `scaled <= 1000` | at the boundary the extra pass lands on `scaled = 1.0` in the next unit and the precision break renders the same text | eq, 80-row sweep |
| `#25` | 34:23 | EqualityOperator | `scaled <= 10` | at the boundary the extra pass lands on `scaled = 1.0` in the next unit and the precision break renders the same text | eq, 80-row sweep |
| `#43` | 40:41 | StringLiteral | `"Stryker was here!"` | `TOKEN_UNITS[unit]` is defined for every unit the walk can reach (it stops at `T`), so the empty-string fallback never fires | eq, 80-row sweep |

### `merge-guard.ts`

| Id | Line:col | Mutator | Replacement | Domain it cannot be observed on | Proof |
| --- | --- | --- | --- | --- | --- |
| `#99` | 52:77 | StringLiteral | `""` | the strip joiner is always adjacent to a newline (the regex stops before it), so a space and an empty string cannot glue two words | eq, 80-row sweep |
| `#116` | 76:16 | Regex | `/\\bgit\\b(.*)/` | `$` only differs before a final newline, and `segments()` has already split on newlines | eq, 80-row sweep |
| `#121` | 78:17 | MethodExpression | `after.trim().split(/\\s+/)` | `after` starts at a flag, and `filter(Boolean)` drops the empty leading token | eq, 80-row sweep |
| `#122` | 78:17 | MethodExpression | `after` | `after` starts at a flag, and `filter(Boolean)` drops the empty leading token | new here |
| `#123` | 78:36 | Regex | `/\\s/` | a single-space split yields empty tokens inside runs, and `filter(Boolean)` drops them | eq, 80-row sweep |
| `#140` | 97:31 | Regex | `/\\s/` | a single-space split yields empty tokens inside runs, and `filter(Boolean)` drops them | eq, 80-row sweep |
| `#192` | 136:34 | StringLiteral | `""` | `startsWith("~")` guards a `replace(/^~/` that is a no-op off the prefix; a first `~` is always the leading one | eq, 80-row sweep |
| `#193` | 136:53 | Regex | `/~/` | `startsWith("~")` guards a `replace(/^~/` that is a no-op off the prefix; a first `~` is always the leading one | eq, 80-row sweep |
| `#214` | 164:9 | ConditionalExpression | `true` | a lookup that answers `undefined` for a directory it does not know: the caller's `!branch` covers `undefined` and `null` alike, so no segment is skipped or landed differently | new here |
| `#289` | 212:11 | ArrayDeclaration | `[]` | probed against a real temporary repo: the three stdio shapes all return the same `git rev-parse` output | eq, 80-row sweep |
| `#292` | 212:30 | StringLiteral | `""` | probed against a real temporary repo: the three stdio shapes all return the same `git rev-parse` output | eq, 80-row sweep |

### `secret-guard.ts`

| Id | Line:col | Mutator | Replacement | Domain it cannot be observed on | Proof |
| --- | --- | --- | --- | --- | --- |
| `#560` | 59:2 | Regex | `/(^\|[\\/\\\\'"\\s])([^\\/\\\\'"\\s]*\\.env(\\…` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #133 |
| `#577` | 75:2 | Regex | `/(^\|[;&\|()\\s\\/\\\\])(cat\|bat\|sed\|head\|tail\|…` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #150 |
| `#583` | 85:2 | Regex | `/(^\|[;&\|()\\s\\/\\\\])(cat\|bat\|sed\|head\|tail\|…` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #156 |
| `#590` | 103:29 | ArrayDeclaration | `["Stryker was here"]` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #163 |
| `#592` | 106:15 | StringLiteral | `"Stryker was here!"` | first-character sentinel: the replacement literal contains a space, so the `\`-escape test and the leading-`#` test answer as before | eq, 80-row sweep |
| `#627` | 136:15 | StringLiteral | `"Stryker was here!"` | first-character sentinel: the replacement literal contains a space, so the `\`-escape test and the leading-`#` test answer as before | eq, 80-row sweep |
| `#630` | 141:7 | ConditionalExpression | `false` | re-scan of a matched heredoc opener: the opener regex forbids `<` in the delimiter and balances its own quotes, so the second pass finds nothing new | eq, 80-row sweep |
| `#633` | 141:20 | BlockStatement | `{}` | re-scan of a matched heredoc opener: the opener regex forbids `<` in the delimiter and balances its own quotes, so the second pass finds nothing new | eq, 80-row sweep |
| `#657` | 153:7 | ConditionalExpression | `false` | re-scan of a matched heredoc opener: the opener regex forbids `<` in the delimiter and balances its own quotes, so the second pass finds nothing new | eq, 80-row sweep |
| `#658` | 153:7 | LogicalOperator | `ch !== "<" && units[i + 1] !== "<"` | re-scan of a matched heredoc opener: the opener regex forbids `<` in the delimiter and balances its own quotes, so the second pass finds nothing new | eq, 80-row sweep |
| `#659` | 153:7 | ConditionalExpression | `false` | re-scan of a matched heredoc opener: the opener regex forbids `<` in the delimiter and balances its own quotes, so the second pass finds nothing new | eq, 80-row sweep |
| `#662` | 153:21 | ConditionalExpression | `false` | re-scan of a matched heredoc opener: the opener regex forbids `<` in the delimiter and balances its own quotes, so the second pass finds nothing new | eq, 80-row sweep |
| `#666` | 154:13 | Regex | `/<<-?\\s*(["']?)([A-Za-z0-9_.:-]+)\\1/` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #240 |
| `#681` | 170:25 | ArrayDeclaration | `["Stryker was here"]` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #257 |
| `#700` | 195:18 | Regex | `/(^\|\\/)(?:ba\|da\|k\|z)?sh/` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #278 |
| `#716` | 207:7 | Regex | `/[A-Za-z_][A-Za-z0-9_]*=/` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #293 |
| `#739` | 214:47 | MethodExpression | ``git ${words[i + 1]?.text ?? ""}`` | `after` starts at a flag, and `filter(Boolean)` drops the empty leading token | eq, 80-row sweep |
| `#744` | 214:76 | StringLiteral | `"Stryker was here!"` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #321 |
| `#745` | 214:93 | ArithmeticOperator | `i - 1` | `at` is read only by `scriptIndices` and `shellScript`, and a `git …` segment matches neither | eq, 80-row sweep |
| `#762` | 229:25 | Regex | `/(^\|\\/)(?:grep\|egrep\|fgrep\|rg\|sed\|awk)/` | the mutation only widens `PATTERN_VERB_RE`, so it matches a verb *starting with* `grep`/`rg`/`sed`; a binary named that is not a shape the guard's contract covers | new here |
| `#786` | 235:3 | Regex | `/^[/{].[/}]$/` | OPEN — see §Open 1 | new here |
| `#790` | 236:3 | Regex | `/^[0-9,$][a-zA-Z]{0,2}$/` | `isProgram`'s page/range alternative only classifies words like `1,70p`; such a word is never a secret path, so skip membership cannot change a verdict | eq, 80-row sweep |
| `#792` | 236:3 | Regex | `/^[0-9,$]+[a-zA-Z]$/` | `isProgram`'s page/range alternative only classifies words like `1,70p`; such a word is never a secret path, so skip membership cannot change a verdict | eq, 80-row sweep |
| `#793` | 236:3 | Regex | `/^[0-9,$]+[^a-zA-Z]{0,2}$/` | `isProgram`'s page/range alternative only classifies words like `1,70p`; such a word is never a secret path, so skip membership cannot change a verdict | eq, 80-row sweep |
| `#806` | 253:7 | ConditionalExpression | `false` | `skipNext` is redundant: the token after `-e` is already in `skip`, and `seen` suppresses every later word | eq, 80-row sweep |
| `#807` | 253:17 | BlockStatement | `{}` | `skipNext` is redundant: the token after `-e` is already in `skip`, and `seen` suppresses every later word | eq, 80-row sweep |
| `#808` | 254:15 | BooleanLiteral | `true` | `skipNext` is redundant: the token after `-e` is already in `skip`, and `seen` suppresses every later word | eq, 80-row sweep |
| `#816` | 259:11 | BooleanLiteral | `false` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #389 |
| `#817` | 260:15 | BooleanLiteral | `false` | `skipNext` is redundant: the token after `-e` is already in `skip`, and `seen` suppresses every later word | eq, 80-row sweep |
| `#824` | 265:15 | BooleanLiteral | `false` | `skipNext` is redundant: the token after `-e` is already in `skip`, and `seen` suppresses every later word | eq, 80-row sweep |
| `#869` | 314:24 | Regex | `/(\\s)(-T\|--upload-file\|--post-file\|--body-fi…` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #440 |
| `#915` | 358:7 | ConditionalExpression | `false` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #486 |
| `#917` | 358:16 | StringLiteral | `"Stryker was here!"` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #488 |
| `#918` | 358:20 | BlockStatement | `{}` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #489 |
| `#919` | 359:4 | AssignmentOperator | `re.lastIndex -= 1` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #490 |
| `#923` | 362:40 | StringLiteral | `"Stryker was here!"` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #494 |
| `#973` | 392:27 | ConditionalExpression | `true` | `script !== line` is the self-recursion guard; a `-c` operand can never equal the whole command line | eq, 80-row sweep |
| `#978` | 403:12 | Regex | `/\\s*[^=:]*[=:]\\s*["']?([\\s\\S]*?)["']?\\s*$/` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #563 |
| `#981` | 403:12 | Regex | `/^\\S*[^=:]*[=:]\\s*["']?([\\s\\S]*?)["']?\\s*$/` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #563 |
| `#991` | 403:12 | Regex | `/^\\s*[^=:]*[=:]\\s*["']?([\\S\\S]*?)["']?\\s*$/` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #563 |
| `#994` | 403:12 | Regex | `/^\\s*[^=:]*[=:]\\s*["']?([\\s\\S]*?)[^"']?\\…` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #563 |
| `#998` | 404:9 | OptionalChaining | `m[1]` | the inner regex always matches the assignment text (it requires `[=:]`), so its lazy group is never undefined | eq, 80-row sweep |
| `#1005` | 412:8 | ConditionalExpression | `false` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #574 |
| `#1007` | 412:17 | StringLiteral | `"Stryker was here!"` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #576 |
| `#1008` | 412:21 | BlockStatement | `{}` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #577 |
| `#1009` | 413:5 | AssignmentOperator | `p.re.lastIndex -= 1` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #578 |
| `#1010` | 419:22 | ConditionalExpression | `true` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #579 |
| `#1020` | 453:24 | ArrayDeclaration | `["Stryker was here"]` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #589 |
| `#1052` | 477:15 | StringLiteral | `"Stryker was here!"` | first-character sentinel: the replacement literal contains a space, so the `\`-escape test and the leading-`#` test answer as before | eq, 80-row sweep |
| `#1082` | 493:21 | ConditionalExpression | `false` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #645 |
| `#1084` | 493:28 | StringLiteral | `""` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #647 |
| `#1116` | 523:8 | ConditionalExpression | `true` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #690 |
| `#1126` | 533:18 | ConditionalExpression | `true` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #700 |
| `#1128` | 533:24 | StringLiteral | `"Stryker was here!"` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #702 |
| `#1152` | 546:13 | Regex | `/^(?:--?[\\w-]+=?\|[\\w.-]+=)?@(.+)/` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #729 |
| `#1155` | 546:13 | Regex | `/^(?:--?[\\w-]=?\|[\\w.-]+=)?@(.+)$/` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #729 |
| `#1177` | 553:6 | ConditionalExpression | `true` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #751 |
| `#1178` | 553:6 | EqualityOperator | `pipe.length >= 1` | a one-element pipe slices to `[]`, joins to the empty string, and `hasMatch` is false either way | eq, 80-row sweep |
| `#1182` | 553:68 | StringLiteral | `""` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #756 |
| `#1362` | 721:28 | ArrayDeclaration | `["Stryker was here"]` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #918 |
| `#1368` | 722:79 | StringLiteral | `"Stryker was here!"` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #924 |
| `#1369` | 723:13 | ConditionalExpression | `true` | on a write call `event.input.edits` is undefined, so the loop body runs zero times either way | eq, 80-row sweep |
| `#1373` | 723:86 | ArrayDeclaration | `["Stryker was here"]` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #929 |
| `#1376` | 723:114 | StringLiteral | `"Stryker was here!"` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #934 |
| `#1378` | 723:131 | StringLiteral | `"Stryker was here!"` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #934 |
| `#1441` | 768:8 | ConditionalExpression | `true` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #997 |
| `#1479` | 795:23 | StringLiteral | `"Stryker was here!"` | documented ledger row; the earlier sweep's differential run found 0 differing | doc #1035 |

### `big-boss-pi-guard.ts` (new here)

51 rows from a guard that had never been mutated. The domain is one catch-all: a generated shell
corpus crossed with cwds, tool calls and `PI_WORKER` values, 51,792 observations, 0 differing
verdicts on each row below. The 56 mutants that guard's own test file now separates are in **Dead**;
the two timeouts (`119:27`, `131:4`, both of which hang the `commandVerb` walk) count as killed.

| Id | Line:col | Mutator | Replacement | Domain it cannot be observed on | Proof |
| --- | --- | --- | --- | --- | --- |
| `#23` | 70:7 | ConditionalExpression | `true` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#39` | 78:26 | Regex | `/"(?:[^"\\]\|\\.)*"\|'[^']'/g` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#39` | 78:26 | Regex | `/"(?:[^"\\]\|\\.)*"\|'[^']'/g` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#56` | 83:26 | Regex | `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#56` | 83:26 | Regex | `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#56` | 83:26 | Regex | `/<<-?\s*(['"]?)(\w+)\1[\s\S]*?\n\s\2\s*(?=\n\|…` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#62` | 83:78 | StringLiteral | `""` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#64` | 87:10 | MethodExpression | `stripHeredocs(command).split(/\n/).map(unquot…` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#78` | 103:88 | StringLiteral | `""` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#80` | 106:34 | StringLiteral | `""` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#83` | 106:55 | StringLiteral | `""` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#85` | 117:17 | MethodExpression | `segment.split(/\s+/)` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#82` | 106:48 | StringLiteral | `""` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#86` | 117:31 | Regex | `/\s/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#89` | 119:10 | EqualityOperator | `i <= words.length` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#98` | 125:33 | StringLiteral | `"Stryker was here!"` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#101` | 126:8 | LogicalOperator | `SHELL_WRAPPERS.has(word) \|\| /^-[a-zA-Z]*c[a-z…` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#107` | 126:36 | Regex | `/^-[a-zA-Z]*c[^a-zA-Z]*$/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#107` | 126:36 | Regex | `/^-[a-zA-Z]*c[^a-zA-Z]*$/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#107` | 126:36 | Regex | `/^-[a-zA-Z]*c[^a-zA-Z]*$/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#123` | 130:42 | Regex | `/^[A-Za-z_][^A-Za-z0-9_]*=/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#127` | 136:31 | StringLiteral | `"Stryker was here!"` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#139` | 138:52 | MethodExpression | `words.slice(i + 1).every(word => /^-[a-zA-Z]*…` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#150` | 149:46 | StringLiteral | `""` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#151` | 149:51 | StringLiteral | `""` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#166` | 157:8 | ConditionalExpression | `true` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#168` | 157:8 | EqualityOperator | `at <= 0` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#178` | 165:33 | Regex | `/^[\s(=:'"`]+\|[^;,)'"`]+$/g` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#178` | 165:33 | Regex | `/^[\s(=:'"`]+\|[^;,)'"`]+$/g` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#178` | 165:33 | Regex | `/^[\s(=:'"`]+\|[^;,)'"`]+$/g` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#178` | 165:33 | Regex | `/^[\s(=:'"`]+\|[^;,)'"`]+$/g` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#179` | 165:61 | StringLiteral | `"Stryker was here!"` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#183` | 166:24 | StringLiteral | `"Stryker was here!"` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#185` | 167:39 | StringLiteral | `""` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#186` | 167:62 | Regex | `/~/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#191` | 173:10 | MethodExpression | `redirectsInto(segment).map(token => toPath(to…` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#200` | 184:39 | Regex | `/\S+/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#201` | 184:52 | StringLiteral | `"Stryker was here!"` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#204` | 184:68 | Regex | `/\s/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#203` | 184:56 | OptionalChaining | `verb.split` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#206` | 184:81 | StringLiteral | `"Stryker was here!"` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#207` | 185:37 | Regex | `/\s/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#223` | 186:43 | Regex | `/^[^<>&\|]+$/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#223` | 186:43 | Regex | `/^[^<>&\|]+$/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#223` | 186:43 | Regex | `/^[^<>&\|]+$/` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#224` | 188:8 | ConditionalExpression | `true` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#229` | 201:23 | ConditionalExpression | `true` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#232` | 201:23 | EqualityOperator | `redirectsInto(segment).length <= 0` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#234` | 202:8 | ConditionalExpression | `false` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#254` | 225:22 | MethodExpression | `value` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |
| `#285` | 237:77 | StringLiteral | `"Stryker was here!"` | the same shell corpus × 6 cwds, `insideGuarded`/`delegationPath`/`cwdIsGuarded` over 18 paths, `workerSession` over 6 `PI_WORKER` values, and the handler over 6 tools × 6 cwds × 3 `PI_WORKER` values — 51,792 observations | new here |

### `pi-master-guard.ts` (new here)

10 rows, 10,228 observations each, 0 differing verdicts. Everything the guard decides is reachable
from `shellWriteReason(command)` plus the handler, and the two message strings that survive are the
ones no test asserts — `ctx.ui.notify` text is not the contract, the `reason` is.

| Id | Line:col | Mutator | Replacement | Domain it cannot be observed on | Proof |
| --- | --- | --- | --- | --- | --- |
| `#819` | 34:21 | Regex | `/(^\|[\s;&\|(])(rm\|rmdir\|mv\|cp\|dd\|tee\|truncate\|…` | a generated shell corpus (24 verbs × 13 paths × 12 command prefixes, both `verb path` and `prefix echo a <joint> verb path` shapes, plus 19 heredoc/quote/arrow/`sed -i`/`2>` shapes per path) and the handler over 6 tool names × 6 cwds — 10,228 observations | new here |
| `#794` | 29:23 | StringLiteral | `"Stryker was here!"` | a generated shell corpus (24 verbs × 13 paths × 12 command prefixes, both `verb path` and `prefix echo a <joint> verb path` shapes, plus 19 heredoc/quote/arrow/`sed -i`/`2>` shapes per path) and the handler over 6 tool names × 6 cwds — 10,228 observations | new here |
| `#797` | 29:43 | StringLiteral | `"Stryker was here!"` | a generated shell corpus (24 verbs × 13 paths × 12 command prefixes, both `verb path` and `prefix echo a <joint> verb path` shapes, plus 19 heredoc/quote/arrow/`sed -i`/`2>` shapes per path) and the handler over 6 tool names × 6 cwds — 10,228 observations | new here |
| `#819` | 34:21 | Regex | `/(^\|[\s;&\|(])(rm\|rmdir\|mv\|cp\|dd\|tee\|truncate\|…` | a generated shell corpus (24 verbs × 13 paths × 12 command prefixes, both `verb path` and `prefix echo a <joint> verb path` shapes, plus 19 heredoc/quote/arrow/`sed -i`/`2>` shapes per path) and the handler over 6 tool names × 6 cwds — 10,228 observations | new here |
| `#796` | 29:35 | Regex | `/\/$/` | a generated shell corpus (24 verbs × 13 paths × 12 command prefixes, both `verb path` and `prefix echo a <joint> verb path` shapes, plus 19 heredoc/quote/arrow/`sed -i`/`2>` shapes per path) and the handler over 6 tool names × 6 cwds — 10,228 observations | new here |
| `#819` | 34:21 | Regex | `/(^\|[\s;&\|(])(rm\|rmdir\|mv\|cp\|dd\|tee\|truncate\|…` | a generated shell corpus (24 verbs × 13 paths × 12 command prefixes, both `verb path` and `prefix echo a <joint> verb path` shapes, plus 19 heredoc/quote/arrow/`sed -i`/`2>` shapes per path) and the handler over 6 tool names × 6 cwds — 10,228 observations | new here |
| `#819` | 34:21 | Regex | `/(^\|[\s;&\|(])(rm\|rmdir\|mv\|cp\|dd\|tee\|truncate\|…` | a generated shell corpus (24 verbs × 13 paths × 12 command prefixes, both `verb path` and `prefix echo a <joint> verb path` shapes, plus 19 heredoc/quote/arrow/`sed -i`/`2>` shapes per path) and the handler over 6 tool names × 6 cwds — 10,228 observations | new here |
| `#822` | 35:18 | Regex | `/^\S*(delegate\|jev\|hc\|herdr-app\|herdr)\b/` | a generated shell corpus (24 verbs × 13 paths × 12 command prefixes, both `verb path` and `prefix echo a <joint> verb path` shapes, plus 19 heredoc/quote/arrow/`sed -i`/`2>` shapes per path) and the handler over 6 tool names × 6 cwds — 10,228 observations | new here |
| `#822` | 35:18 | Regex | `/^\S*(delegate\|jev\|hc\|herdr-app\|herdr)\b/` | a generated shell corpus (24 verbs × 13 paths × 12 command prefixes, both `verb path` and `prefix echo a <joint> verb path` shapes, plus 19 heredoc/quote/arrow/`sed -i`/`2>` shapes per path) and the handler over 6 tool names × 6 cwds — 10,228 observations | new here |
| `#854` | 59:8 | ConditionalExpression | `true` | a generated shell corpus (24 verbs × 13 paths × 12 command prefixes, both `verb path` and `prefix echo a <joint> verb path` shapes, plus 19 heredoc/quote/arrow/`sed -i`/`2>` shapes per path) and the handler over 6 tool names × 6 cwds — 10,228 observations | new here |

### `config-guard.ts` (new here)

52 mutants, 52 killed: the one survivor this sweep found was the timing arithmetic at `58:14`, and
the spec's suspicion was right to point at it — it survived the first test because the assertion
was a loose "under a second". It is now killed by a comparison against the wall time of the same
call. No row is open, so this guard has no surviving table.


## Reconciliation: the 80-row sweep → 81 mutants on `8dba206`

Every one of the 80 rows in `reports/mutation-survivors-2.md` lands somewhere, and the number adds up:

| | rows | which |
| --- | --- | --- |
| still surviving, label kept | 77 | all of them are in the table above, at their `8dba206` line (the `secret-guard.ts` rows at old line ≥ 380 moved **+3**: #156 added three comment lines above the redirect test) |
| now dead | 3 | `380:19` → `#936`, `381:8` → `#943`, `543:13` → `#1151`, all in **Dead** above |
| gone (mutant no longer exists) | 0 | — |
| **still surviving + new since the sweep** | **77 + 4 = 81** | the four are `#122` and `#214` (`merge-guard.ts`), `#762` and `#786` (`secret-guard.ts`) |

All four are flake casualties, and both reports name them: `#122` and `#762` are `Killed→Survived`
rows in `reports/mutation-determinism.md`, and `#214` and `#786` are the two mutants the 80-row
sweep's run 2 killed while run 1 left alive (`reports/mutation-survivors-2.md`, *The runs*).
`#122` and `#762` inherited a label from a same-shaped row; `#214` is decided here (see the table,
`merge-guard.ts:164:9`: `branchOf` can hand the caller `undefined` instead of `null`, and the
caller's `!branch` cannot tell them apart); `#786` is **open**, below.

`#659` (`secret-guard.ts:153:7`) is one of the three identical `ConditionalExpression → false`
mutants at that position; the sweep listed two rows for two of them, and this tree has three
survivors there. All three carry the same verdict, so the extra one is labelled by the same row.

## The three guards that had never been mutated

`big-boss-pi-guard.ts`, `pi-master-guard.ts` and `config-guard.ts` were 409 lines outside the
`mutate` glob until this branch: a survivor there meant a delegation guard could be neutered with
every test green. They were swept per file first (`--mutate "extensions/<file>.ts"`), then added to
the glob:

| File | Mutants | Killed | Timeout | Survived (before the new tests) | Per-file sweep |
| --- | --- | --- | --- | --- | --- |
| `big-boss-pi-guard.ts` | 305 | 209 | 2 | 94 | 2m23s |
| `pi-master-guard.ts` | 75 | 54 | 0 | 21 | 54s |
| `config-guard.ts` | 52 | 51 | 0 | 1 | 41s |

202 mutants, 116 survivors, and every one decided: **56 killed** by a new
`extensions/__tests__/<guard>-mutants.test.ts` (the input that separates each one is the test name
in **Dead**), **60 proved equivalent** over the named domain in the tables above, **2 timeouts**
(hung mutants, killed by the timeout, not by a test).

The method, once, so a later sweep can repeat it: apply each mutant's replacement at the span
stryker reports, import shipped and mutant side by side, and compare the full observable answer
(return value, block, reason, notices) over a generated corpus. The runner was a throwaway script,
not a committed harness; the corpus recipe is the domain column above (24 write verbs and read
commands × 13 paths × 12 command prefixes in two shapes, plus heredoc, quote, arrow, `sed -i` and
`2>` shapes, crossed with cwds, tool names and `PI_WORKER` values). Rebuilding it is the cost of a
new equivalence proof; the numbers here are what one run of it found.


## Open

1. **`secret-guard.ts:235:3` (`#786`) — a test gap, not a decision about the guard.**
   `/^[/{].*[/}]$/` → `/^[/{].[/}]$/` narrows `isProgram`'s second alternative from "a word that
   starts with `/` or `{` and ends with `/` or `}`" to a three-character word. Shipped code reads
   `grep /secret.env/ f` as a regex and lets it through; the mutant reads the word as a file name
   and blocks it, because `.env` followed by `/` is a secret path. None of the 7,455 sweep scripts
   and no test in the suite sends a `/…/`-delimited pattern that names a secret file, which is why
   the mutant survives. The mutant is *stricter* than the shipped code, so this is a missing test,
   not a hole. **What decides it:** a probe of both versions on `grep /secret.env/ f`; if it
   differs as described, one test pinning that a `/…/` regex word is not a file body kills `#786`.
   Not fixed here: this task is docs-only.
2. **The sweep's equivalence arguments are inherited, not re-run.** The 77 `eq` rows carry the
   80-row sweep's differential result on source that is byte-identical at their location. What
   this run proves is that they still survive, not that they are equivalent again. A future
   `secret-guard.ts` change that touches a regex those rows sit on puts them back at `new here`.

## Totals to keep in step

Update the table at the top and the rows above, not the method or the rules. When the survivor
count moves, this file's *Reconciliation* and *The three guards* sections are the parts that go
stale first. Current totals: **1909 mutants, 1765 killed, 142 survived, 2 timeout, 92.56%**, and the
survivor set is 81 (older files, unchanged) + 60 (the three guards, new here) + 1 open
(`secret-guard.ts:235:3`).
