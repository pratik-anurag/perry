import test from 'node:test';
import assert from 'node:assert/strict';
import { findRelatedTestFiles, isRelatedTestFile, TestFileSnapshot } from '../testDiscovery';

test('test file matching detects source stem and symbol references', () => {
  assert.equal(isRelatedTestFile('/repo/src/userService.ts', 'createUser', '/repo/src/userService.test.ts', ''), true);
  assert.equal(isRelatedTestFile('/repo/src/userService.ts', 'createUser', '/repo/tests/account.spec.ts', 'createUser()'), true);
  assert.equal(isRelatedTestFile('/repo/src/userService.ts', 'createUser', '/repo/tests/account.spec.ts', 'deleteUser()'), false);
  assert.equal(isRelatedTestFile('/repo/pkg/payments/service.go', 'ChargeCustomer', '/repo/pkg/payments/service_test.go', ''), true);
});

test('test file discovery limits related matches', () => {
  const files: TestFileSnapshot[] = Array.from({ length: 8 }, (_, index) => ({
    path: `/repo/tests/example${index}.test.ts`,
    uri: `file:///repo/tests/example${index}.test.ts`,
    fileName: `example${index}.test.ts`,
    content: 'targetSymbol()'
  }));

  assert.equal(findRelatedTestFiles('/repo/src/source.ts', 'targetSymbol', files).length, 5);
});
