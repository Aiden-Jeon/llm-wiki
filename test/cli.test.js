import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOptions, prepareWorkspace } from '../src/cli.js';
import { getPaths } from '../src/paths.js';
import { writeRegistry } from '../src/registry.js';

function tmpPaths() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'llmwiki-'));
  return getPaths({
    LLM_WIKI_CONFIG_HOME: path.join(root, 'config'),
    LLM_WIKI_DATA_HOME: path.join(root, 'data'),
  });
}

test('parseOptions keeps "=" inside option values', () => {
  const { options } = parseOptions(['--notes=k=v, x', '--signals', 'a,b'], { allowed: ['notes', 'signals'] });
  assert.equal(options.notes, 'k=v, x');
  assert.equal(options.signals, 'a,b');
});

test('parseOptions rejects unknown options instead of ignoring them', () => {
  assert.throws(
    () => parseOptions(['--kine', 'secure'], { allowed: ['kind'] }),
    /\uc54c \uc218 \uc5c6\ub294 \uc635\uc158: --kine/,
  );
});

test('parseOptions treats declared booleans as flags', () => {
  assert.equal(parseOptions(['--json'], { allowed: ['json'], booleans: ['json'] }).options.json, true);
  assert.equal(parseOptions(['--json=false'], { allowed: ['json'], booleans: ['json'] }).options.json, false);
});

test('parseOptions requires a value and collects positionals', () => {
  assert.throws(() => parseOptions(['--name'], { allowed: ['name'] }), /--name \uc635\uc158 \uac12\uc774 \ud544\uc694/);
  assert.deepEqual(parseOptions(['personal', '/tmp/v']).rest, ['personal', '/tmp/v']);
});

test('prepareWorkspace refreshes managed files and keeps local agent state', () => {
  const paths = tmpPaths();
  writeRegistry(paths.registry, [{ name: 'personal', path: '/tmp/personal', kind: 'open' }]);

  fs.mkdirSync(path.join(paths.workspace, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(paths.workspace, '.claude/settings.local.json'), '{"permissions":{}}');
  fs.writeFileSync(path.join(paths.workspace, '.claude/stale.json'), 'x');
  fs.writeFileSync(path.join(paths.workspace, 'CLAUDE.md'), 'overwritten by user');

  prepareWorkspace(paths);
  prepareWorkspace(paths); // 반복 실행에도 사용자 상태가 남아야 한다.

  assert.ok(fs.existsSync(path.join(paths.workspace, '.claude/settings.local.json')));
  assert.ok(fs.existsSync(path.join(paths.workspace, '.claude/stale.json')));
  assert.ok(fs.existsSync(path.join(paths.workspace, '.claude/commands/wiki-add.md')));
  assert.ok(fs.existsSync(path.join(paths.workspace, 'WORKSPACE.md')));
  assert.notEqual(fs.readFileSync(path.join(paths.workspace, 'CLAUDE.md'), 'utf8'), 'overwritten by user');
  assert.match(fs.readFileSync(path.join(paths.workspace, 'wikis.local.md'), 'utf8'), /\| personal \|/);
});

test('prepareWorkspace fails with setup guidance when config is missing', () => {
  assert.throws(() => prepareWorkspace(tmpPaths()), /llmwiki setup/);
});
