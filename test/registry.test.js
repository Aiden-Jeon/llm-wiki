import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { normalizeVault, parseRegistry, renderRegistry } from '../src/registry.js';

test('registry markdown round-trip', () => {
  const input = [{
    name: 'personal',
    path: '/tmp/my-wiki',
    kind: 'open',
    signals: 'career, AI',
    notes: 'public notes',
  }];
  assert.deepEqual(parseRegistry(renderRegistry(input)), input);
});

test('registry expands a home-relative vault path', () => {
  const vault = normalizeVault({ name: 'home', path: '~/wiki', kind: 'open' });
  assert.equal(vault.path, path.join(os.homedir(), 'wiki'));
});

test('registry rejects invalid secure kind and markdown delimiters', () => {
  assert.throws(() => renderRegistry([{ name: 'bad|name', path: '/tmp/x', kind: 'open' }]), /\|/);
  assert.throws(() => renderRegistry([{ name: 'work', path: '/tmp/x', kind: 'private' }]), /open 또는 secure/);
});
