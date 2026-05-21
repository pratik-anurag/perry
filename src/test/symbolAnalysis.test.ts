import test from 'node:test';
import assert from 'node:assert/strict';
import { getSymbolIdentifier, lineContainsCallToSymbol } from '../symbolAnalysis';

test('call-site scanner finds Python calls without matching definitions or comments', () => {
  assert.equal(lineContainsCallToSymbol('    result = build_user(account)', 'build_user', 'python'), true);
  assert.equal(lineContainsCallToSymbol('async def build_user(account):', 'build_user', 'python'), false);
  assert.equal(lineContainsCallToSymbol('    # build_user(account)', 'build_user', 'python'), false);
});

test('call-site scanner finds Go calls without matching function definitions or comments', () => {
  assert.equal(lineContainsCallToSymbol('    user := buildUser(account)', 'buildUser', 'go'), true);
  assert.equal(lineContainsCallToSymbol('func buildUser(account Account) User {', 'buildUser', 'go'), false);
  assert.equal(lineContainsCallToSymbol('    // buildUser(account)', 'buildUser', 'go'), false);
});

test('symbol identifier uses the callable name from qualified symbols', () => {
  assert.equal(getSymbolIdentifier('Service.build_user'), 'build_user');
  assert.equal(getSymbolIdentifier('(*Server).Handle'), 'Handle');
});
