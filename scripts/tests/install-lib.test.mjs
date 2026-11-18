// Tests for the installer's pure half (scripts/install-lib.mjs).
//
// These pin the two properties the cross-platform port must not lose:
//   1. `keep every rule` reproduces agent/AGENTS.md byte for byte, so an
//      unfiltered setup on a working machine changes nothing.
//   2. the per-OS differences stay in ONE table, so they cannot spread into the
//      engine as `if (win32)` branches — the revert trigger in the spec is
//      "per-OS special cases spreading past three places".
//
// Run: node --test scripts/tests/install-lib.test.mjs  (or make scripts-test)

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
	OS_PLAN,
	PI_WRAPPER_BEGIN,
	PI_WRAPPER_BLOCK,
	PI_WRAPPER_END,
	filterAgentsMd,
	homePaths,
	parseAgentsMd,
	parseRuleSelection,
	pickNames,
	planFor,
	ruleIds,
	ruleSlug,
	samePath,
	spliceManagedBlock,
} from '../install-lib.mjs';

const AGENTS = fs.readFileSync(new URL('../../agent/AGENTS.md', import.meta.url), 'utf8');
const SECTIONS = ['Sandbox', 'Landing changes', 'Harness sources', 'Models', 'Harness feedback', 'Herdr', 'Machine / screens'];

test('agent/AGENTS.md: 17 rules, each in a named section', () => {
	const parsed = parseAgentsMd(AGENTS);
	assert.equal(parsed.rules.length, 17, 'setup.mjs says "rule N of 17"; a new rule means a new number');
	for (const section of SECTIONS) {
		assert.ok(
			parsed.rules.some((r) => r.section === section),
			`no rule under "## ${section}" — setup would not offer it`,
		);
	}
	assert.equal(new Set(ruleIds(parsed).map((r) => r.slug)).size, 17, 'every rule needs its own slug, or one answer covers two rules');
});

test('keeping every rule reproduces AGENTS.md byte for byte', () => {
	assert.equal(filterAgentsMd(AGENTS, () => true), AGENTS);
});

test('dropping a rule removes its bullet and keeps the others', () => {
	const parsed = parseAgentsMd(AGENTS);
	const target = parsed.rules[4]; // the second "Landing changes" rule
	const filtered = filterAgentsMd(AGENTS, (rule) => rule.index !== target.index);
	assert.equal(filtered.split('\n').filter((l) => /^- /.test(l)).length, 16);
	assert.ok(!filtered.includes(target.text.slice(0, 40)), 'the dropped rule is still there');
	assert.ok(filtered.includes(parsed.rules[5].text.slice(0, 40)), 'a rule after it went missing');
});

test('a section whose only rule was dropped loses its heading', () => {
	const parsed = parseAgentsMd(AGENTS);
	const sandbox = parsed.rules.find((r) => r.section === 'Sandbox');
	const filtered = filterAgentsMd(AGENTS, (rule) => rule.index !== sandbox.index);
	assert.ok(!filtered.includes('## Sandbox'), 'an empty heading is a rule nobody can follow');
	assert.ok(filtered.includes('## Harness sources'));
	assert.equal(filtered.endsWith('\n'), true);
	assert.equal(filtered.includes('\n\n\n'), false, 'no double blank lines left behind');
});

test('a recorded answer survives a rule inserted above it', () => {
	const before = parseAgentsMd(AGENTS);
	const ruffled = AGENTS.replace('# Global rules\n\n', '# Global rules\n\n- A brand new rule nobody has answered yet, inserted at the top.\n');
	const after = parseAgentsMd(ruffled);
	assert.equal(after.rules.length, before.rules.length + 1);
	for (const rule of before.rules) {
		const match = after.rules.find((r) => r.slug === rule.slug);
		assert.ok(match, `slug ${rule.slug} moved — answers recorded against it would be lost`);
		assert.equal(match.index, rule.index + 1, 'indexes shift, slugs must not');
	}
});

test('ruleSlug is derived from the rule text, not its position', () => {
	assert.equal(ruleSlug('- Never merge, push to trunk'), ruleSlug('Never merge, push to trunk'));
	assert.match(ruleSlug('Always respond in English, regardless of the language'), /^always-respond-in-english-regardless-of$/);
});

test('the pi wrapper block is spliced, not appended twice', () => {
	const rc = '# my rc\n\nexport PATH="$HOME/.local/bin:$PATH"\n';
	const once = spliceManagedBlock(rc, PI_WRAPPER_BEGIN, PI_WRAPPER_END, PI_WRAPPER_BLOCK);
	const twice = spliceManagedBlock(once, PI_WRAPPER_BEGIN, PI_WRAPPER_END, PI_WRAPPER_BLOCK);
	assert.equal(twice, once, 'a second install must not stack a second wrapper');
	assert.ok(once.startsWith('# my rc\n'), 'what was outside the markers is still first');
	assert.equal(once.split(PI_WRAPPER_BEGIN).length, 2);
});

test('an old wrapper block is replaced where it stood', () => {
	const stale = `# rc\n${PI_WRAPPER_BEGIN}\npi() { echo old; }\n${PI_WRAPPER_END}\n# after\n`;
	const next = spliceManagedBlock(stale, PI_WRAPPER_BEGIN, PI_WRAPPER_END, PI_WRAPPER_BLOCK);
	assert.ok(!next.includes('echo old'), 'the stale block survived');
	assert.ok(next.includes('# after'), 'a line after the block was eaten');
});

test('one per-OS table: three plans, and only the real differences differ', () => {
	const n = OS_PLAN;
	assert.deepEqual(Object.keys(n).sort(), ['darwin', 'linux', 'win32']);
	assert.equal(n.linux.linkMode, 'symlink');
	assert.equal(n.win32.linkMode, 'copy', 'a symlink on Windows needs elevation or Developer Mode');
	assert.equal(n.linux.binSubdir, n.darwin.binSubdir);
	assert.equal(n.linux.service, 'systemd');
	assert.equal(n.darwin.service, 'launchd');
	assert.equal(n.win32.service, 'schtasks');
	assert.equal(n.linux.sandbox, true);
	assert.equal(n.darwin.sandbox, false);
	assert.equal(n.win32.sandbox, false);
	assert.deepEqual(n.win32.rcFiles, [], 'no POSIX rc file on Windows');
	assert.equal(n.win32.herdrInstall, 'powershell');
	assert.equal(n.linux.herdrInstall, 'sh');
	assert.match(planFor('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }).herdrInstalled, /herdr-app[\\/]herdr-app\.exe$/);
	assert.equal(planFor('plan9').platform, 'linux', 'an unknown platform reads as POSIX rather than crashing a setup');
});

test('homePaths derives every path the engine writes from HOME', () => {
	const plan = planFor('linux');
	const p = homePaths({ home: '/home/me', agentDir: '/home/me/.pi/agent', plan });
	assert.equal(p.binDir, '/home/me/.local/bin');
	assert.equal(p.stateFile, '/home/me/.pi/state/setup.json');
	assert.equal(p.gitHooksDir, '/home/me/.pi/git-hooks');
	assert.equal(p.serviceDir, '/home/me/.config/systemd/user');
	assert.equal(homePaths({ home: 'C:\\Users\\me', agentDir: 'C:\\Users\\me\\.pi\\agent', plan: planFor('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }) }).serviceDir, null);
});

test('pickNames: nothing given means everything', () => {
	assert.deepEqual(pickNames(['a', 'b'], []), ['a', 'b']);
	assert.deepEqual(pickNames(['a', 'b', 'c'], ['c']), ['c']);
	assert.deepEqual(pickNames(['a', 'b'], ['zzz']), []);
});

test('--rules= parses into one answer per rule', () => {
	assert.equal(parseRuleSelection(undefined, 17).size, 0);
	assert.equal([...parseRuleSelection('none', 3).values()].every((v) => v === false), true);
	assert.deepEqual([...parseRuleSelection('drop:2', 3).entries()], [
		[1, true],
		[2, false],
		[3, true],
	]);
	assert.deepEqual([...parseRuleSelection('keep:2,3', 3).entries()], [
		[1, false],
		[2, true],
		[3, true],
	]);
	assert.throws(() => parseRuleSelection('some', 3), /--rules wants/);
});

test('samePath: git echoes back a different spelling of the same directory', () => {
	assert.equal(samePath('/home/me/.pi/git-hooks', '/home/me/.pi/git-hooks/'), true);
	assert.equal(samePath('/home/me/.pi/git-hooks', '/home/other/.pi/git-hooks'), false);
	assert.equal(samePath('/c/Users/me/.pi/git-hooks', 'C:\\Users\\me\\.pi\\git-hooks', 'win32'), true);
	assert.equal(samePath('/c/Users/me/.pi/git-hooks', '/c/Users/me/.pi/git-hooks/', 'win32'), true);
	assert.equal(samePath('', '/home/me', 'linux'), false);
});
