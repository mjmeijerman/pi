# Mutation survivors — the decided ones

Owner: Mark Meijerman (`mjmeijerman`)
Review: 2027-05-18 — half-yearly, or after any survivor sweep.

**What this file is.** The record a survivor leaves behind when it is not killed: the input domain
it cannot be observed on, or the test that finally killed it. A survivor with no row here is an
open item, not a decision. The rules for reading a survivor (group by what the mutation changes,
ask what the guard's contract at that line is, never write a vacuous test) are in
`specs/areas/secret-guard.md` and in the sweep reports; this file only holds the verdicts.

Scope: the whole mutated set, not one file — `agent/extensions/secret-guard.ts`,
`agent/extensions/merge-guard.ts` and `agent/extensions/lib/usage-format.ts` (this is wider than
the file it replaces, which covered `secret-guard.ts` only). Widened because every count this repo
quotes is the full run: a ledger that reconciles 80 sweep rows against a 84-mutant run has to name
all three files or the arithmetic cannot close.

Measured on trunk `8dba206`, 2026-11-18:

```
cd agent && rm -f reports/stryker/stryker-incremental.json
./node_modules/.bin/stryker run --force
```

1477 mutants — **1396 killed, 81 survived, 0 timeout, 0 no-coverage, 94.52%**, 10m32s.

| File | Mutants | Killed | Survived | Timeout | Score |
| --- | --- | --- | --- | --- | --- |
| `extensions/lib/usage-format.ts` | 75 | 72 | 3 | 0 | 96.00% |
| `extensions/merge-guard.ts` | 342 | 331 | 11 | 0 | 96.78% |
| `extensions/secret-guard.ts` | 1060 | 993 | 67 | 0 | 93.68% |
| **all three** | **1477** | **1396** | **81** | **0** | **94.52%** |

A timeout counts as killed. The number to quote is **81**, measured; the earlier numbers were
true of other trees and are reconciled below.

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
count moves, this file's *Reconciliation* and *Why 81* sections are the parts that go stale first.
