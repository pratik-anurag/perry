import test from 'node:test';
import assert from 'node:assert/strict';
import { dedupeUsageSites, formatUsageSiteLabel, isPositionInsideRange, usageSitesToSymbols } from '../usageSites';
import { UsageSite } from '../types';

test('usage site labels include container context when available', () => {
  assert.equal(formatUsageSiteLabel('src/file.go:42', 'caller'), 'caller (src/file.go:42)');
  assert.equal(formatUsageSiteLabel('src/file.py:9'), 'src/file.py:9');
});

test('usage site dedupe preserves order and marks truncation', () => {
  const sites: UsageSite[] = [
    usageSite('file:///repo/a.go', 4, 10, 'first (a.go:4)'),
    usageSite('file:///repo/a.go', 4, 10, 'duplicate (a.go:4)'),
    usageSite('file:///repo/b.go', 8, 2, 'second (b.go:8)'),
    usageSite('file:///repo/c.go', 12, 1, 'third (c.go:12)')
  ];

  const result = dedupeUsageSites(sites, 2);

  assert.equal(result.truncated, true);
  assert.deepEqual(result.sites.map((site) => site.label), ['first (a.go:4)', 'second (b.go:8)']);
});

test('usage symbols are derived from unique labels', () => {
  assert.deepEqual(
    usageSitesToSymbols([
      usageSite('file:///repo/a.py', 3, 2, 'caller (a.py:3)'),
      usageSite('file:///repo/a.py', 4, 2, 'caller (a.py:3)'),
      usageSite('file:///repo/b.py', 9, 1, 'other (b.py:9)')
    ]),
    ['caller (a.py:3)', 'other (b.py:9)']
  );
});

test('range helper identifies calls inside a symbol body', () => {
  const range = {
    start: { line: 4, character: 0 },
    end: { line: 10, character: 1 }
  };

  assert.equal(isPositionInsideRange(range, 6, 8), true);
  assert.equal(isPositionInsideRange(range, 11, 0), false);
});

function usageSite(uri: string, line: number, character: number, label: string): UsageSite {
  return {
    label,
    uri,
    path: uri.replace('file://', ''),
    line,
    character,
    source: 'text-scan'
  };
}
