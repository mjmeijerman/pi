#!/usr/bin/env bash
# ============================================================================
# scan-unicode.sh — a file that looks like English is not English yet.
#
# Radar basis: #72 agent package manager (Trial), #7 agent plugin marketplace
# (Trial). A skill or a prompt arrives from somewhere else, so the bytes that
# will be read as instructions are the bytes that need a scan, not the file name.
#
# Refused in a staged change to agent/skills/**, agent/prompts/** and
# agent/AGENTS.md:
#   1. bidi controls   — U+202A..U+202E, U+2066..U+2069, U+200E, U+200F, U+061C.
#                        They reorder what a reader sees, so the line on screen
#                        is not the line that runs.
#   2. zero-width      — U+200B, U+200C, U+200D, U+2060, U+FEFF, U+00AD, U+180E
#                        and the invisible operators U+2061..U+2064. Invisible
#                        characters inside a path or a command change the token
#                        without changing the look of it.
#   3. homoglyphs from outside the Latin block — Cyrillic, Greek and Armenian
#                        letters that render as a Latin one, plus fullwidth
#                        Latin. `pаcket` with a Cyrillic а is a different word.
#
# How "ordinary non-Latin text" is told apart from a homoglyph, which is the
# only judgement call in this file:
#   - A homoglyph is excused when it sits inside a fenced code block or inside a
#     quoted span on its line ('  "  `  « »  “ ”). Both are data by construction:
#     an example, a translation, a literal. Prose is instruction, and a Cyrillic
#     letter in prose that renders as a Latin one is the attack.
#   - The exemption covers homoglyphs only. A bidi override or a zero-width
#     character is refused wherever it appears, because neither becomes data by
#     being quoted: both are invisible, so a reader cannot consent to them.
#   - Fence state is tracked per file, from a ``` or ~~~ marker at up to three
#     spaces of indent, which is the CommonMark rule. Quote state is tracked per
#     line, toggling on each quote character.
#
# Reports file, line, column, codepoint, what it is and the line with the
# offending characters replaced by a visible <U+XXXX> tag — never the raw byte,
# since a terminal can do the same trick the file does.
#
# Override: SKIP_UNICODE_SCAN=1 or git commit --no-verify
# Dependency: perl, for Unicode-aware character iteration. When perl is absent
# the scan says so on stderr and lets the commit through: a hidden-codepoint
# scan that cannot run must not present itself as a gate that passed.
# ============================================================================
set -u
[ "${SKIP_UNICODE_SCAN:-}" = "1" ] && exit 0

read -r -d '' SCAN <<'PERL'
use strict;
use warnings;
binmode(STDIN, ':encoding(UTF-8)');
binmode(STDOUT, ':encoding(UTF-8)');

my $path = shift // '-';

my %bidi = (
	0x202A => 'LEFT-TO-RIGHT EMBEDDING, reorders what follows',
	0x202B => 'RIGHT-TO-LEFT EMBEDDING, reorders what follows',
	0x202C => 'POP DIRECTIONAL FORMATTING',
	0x202D => 'LEFT-TO-RIGHT OVERRIDE, reverses how the rest of the line reads',
	0x202E => 'RIGHT-TO-LEFT OVERRIDE, reverses how the rest of the line reads',
	0x2066 => 'LEFT-TO-RIGHT ISOLATE',
	0x2067 => 'RIGHT-TO-LEFT ISOLATE',
	0x2068 => 'FIRST STRONG ISOLATE',
	0x2069 => 'POP DIRECTIONAL ISOLATE',
	0x200E => 'LEFT-TO-RIGHT MARK, invisible, reorders neighbours',
	0x200F => 'RIGHT-TO-LEFT MARK, invisible, reorders neighbours',
	0x061C => 'ARABIC LETTER MARK, invisible, reorders neighbours',
);
my %zero = (
	0x200B => 'ZERO WIDTH SPACE, invisible and part of the token',
	0x200C => 'ZERO WIDTH NON-JOINER, invisible and part of the token',
	0x200D => 'ZERO WIDTH JOINER, invisible and part of the token',
	0x2060 => 'WORD JOINER, invisible and part of the token',
	0xFEFF => 'ZERO WIDTH NO-BREAK SPACE (BOM), invisible',
	0x00AD => 'SOFT HYPHEN, invisible inside a word',
	0x180E => 'MONGOLIAN VOWEL SEPARATOR, invisible',
	0x2061 => 'FUNCTION APPLICATION, invisible operator',
	0x2062 => 'INVISIBLE TIMES, invisible operator',
	0x2063 => 'INVISIBLE SEPARATOR, invisible operator',
	0x2064 => 'INVISIBLE PLUS, invisible operator',
);
my %homoglyph = (
	# Cyrillic
	0x0430 => 'a', 0x0435 => 'e', 0x043E => 'o', 0x0440 => 'p', 0x0441 => 'c',
	0x0443 => 'y', 0x0445 => 'x', 0x0456 => 'i', 0x0458 => 'j', 0x0455 => 's',
	0x04CF => 'l', 0x0501 => 'd', 0x04BB => 'h', 0x051B => 'q', 0x051D => 'w',
	0x0410 => 'A', 0x0412 => 'B', 0x0415 => 'E', 0x041A => 'K', 0x041C => 'M',
	0x041D => 'H', 0x041E => 'O', 0x0420 => 'P', 0x0421 => 'C', 0x0422 => 'T',
	0x0425 => 'X', 0x0423 => 'Y', 0x0405 => 'S', 0x0406 => 'I', 0x0408 => 'J',
	# Greek
	0x03B1 => 'a', 0x03B5 => 'e', 0x03B9 => 'i', 0x03BA => 'k', 0x03BD => 'v',
	0x03BF => 'o', 0x03C1 => 'p', 0x03C5 => 'u', 0x03C7 => 'x', 0x03F2 => 'c',
	0x0391 => 'A', 0x0392 => 'B', 0x0395 => 'E', 0x0396 => 'Z', 0x0397 => 'H',
	0x0399 => 'I', 0x039A => 'K', 0x039C => 'M', 0x039D => 'N', 0x039F => 'O',
	0x03A1 => 'P', 0x03A4 => 'T', 0x03A5 => 'Y', 0x03A7 => 'X',
	# Armenian
	0x0585 => 'o', 0x057D => 'u', 0x0578 => 'n', 0x0566 => 'q', 0x0571 => 'h',
	# Fullwidth Latin renders as Latin at a glance
);
for my $cp (0xFF21 .. 0xFF3A, 0xFF41 .. 0xFF5A) {
	$homoglyph{$cp} = chr($cp - 0xFEE0);
}

my $class = join '', map { sprintf '\x{%04X}', $_ } (keys %bidi, keys %zero, keys %homoglyph);
my $hidden = qr/[$class]/;

sub render { # the line with every hidden character made visible
	my ($s) = @_;
	$s =~ s/($hidden)/sprintf '<U+%04X>', ord $1/ge;
	$s = substr $s, 0, 160;
	return $s;
}

my $fence = 0;
my $line_no = 0;
my @findings;
while (my $line = <STDIN>) {
	$line_no++;
	$line =~ s/\r?\n\z//;
	my $marker = $line =~ /^\s{0,3}(?:```|~~~)/ ? 1 : 0;
	my $in_fence = $fence;
	$fence = !$fence if $marker;
	my $quoted = 0;
	my $col = 0;
	for my $c (split //, $line) {
		$col++;
		if ($c =~ /["'`\x{00AB}\x{00BB}\x{201C}\x{201D}]/) {
			$quoted = !$quoted;
			next;
		}
		my $cp = ord $c;
		my ($kind, $desc, $look);
		if (exists $bidi{$cp}) {
			$kind = 'bidi';
			$desc = $bidi{$cp};
		} elsif (exists $zero{$cp}) {
			$kind = 'zero-width';
			$desc = $zero{$cp};
		} elsif (exists $homoglyph{$cp}) {
			$kind = 'homoglyph';
			$desc = 'not a Latin letter but renders as one';
			$look = $homoglyph{$cp};
		} else {
			next;
		}
		# Data by construction: quoted non-Latin text and fenced examples are
		# excused for homoglyphs only. Invisibles are never data.
		next if $kind eq 'homoglyph' && ($in_fence || $quoted);
		push @findings, sprintf '%s:%d:%d: U+%04X %s (%s), looks like %s -> "%s"',
			$path, $line_no, $col, $cp, $desc, $kind,
			defined $look ? "Latin '$look'" : 'nothing visible', render($line);
	}
}

print "$_\n" for @findings;
exit(@findings ? 1 : 0);
PERL

files=$(git diff --cached --name-only --diff-filter=ACMR -z 2>/dev/null | tr '\0' '\n') || exit 0
[ -n "$files" ] || exit 0

# Only the files that carry instruction: a skill, a prompt, or AGENTS.md.
guarded=$(printf '%s\n' "$files" | grep -E '^(agent/AGENTS\.md|agent/(skills|prompts)/)' || true)
[ -n "$guarded" ] || exit 0

if ! command -v perl >/dev/null 2>&1; then
	printf 'unicode-guard: perl is missing, so the hidden-codepoint scan did not run\n' >&2
	exit 0
fi

blocked=0
while IFS= read -r f; do
	[ -n "$f" ] || continue
	out=$(git show ":$f" 2>/dev/null | perl -e "$SCAN" -- "$f")
	rc=$?
	if [ "$rc" -ne 0 ]; then
		[ -n "$out" ] && printf '%s\n' "$out"
		blocked=$((blocked + 1))
	fi
done <<<"$guarded"

if [ "$blocked" -gt 0 ]; then
	printf 'unicode-guard: blocked commit — %d staged file(s) under agent/skills, agent/prompts or agent/AGENTS.md carry hidden codepoints.\n' "$blocked" >&2
	printf 'unicode-guard: remove them and re-stage. Override: SKIP_UNICODE_SCAN=1 or git commit --no-verify\n' >&2
	exit 1
fi
exit 0
