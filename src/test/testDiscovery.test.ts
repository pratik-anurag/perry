import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canIndexTestFile,
  findRelatedTestFiles,
  isRelatedTestFile,
  MAX_TEST_FILE_BYTES,
  MAX_TEST_INDEX_BYTES,
  TestFileSnapshot
} from '../testDiscovery';

test('test file matching detects source stem and symbol references', () => {
  assert.equal(isRelatedTestFile('/repo/src/userService.ts', 'createUser', '/repo/src/userService.test.ts', ''), true);
  assert.equal(isRelatedTestFile('/repo/src/userService.ts', 'createUser', '/repo/tests/account.spec.ts', 'createUser()'), true);
  assert.equal(isRelatedTestFile('/repo/src/userService.ts', 'createUser', '/repo/tests/account.spec.ts', 'deleteUser()'), false);
  assert.equal(isRelatedTestFile('/repo/pkg/payments/service.go', 'ChargeCustomer', '/repo/pkg/payments/service_test.go', ''), true);
  assert.equal(isRelatedTestFile('/repo/src/main/java/UserService.java', 'createUser', '/repo/src/test/java/UserServiceTest.java', ''), true);
  assert.equal(isRelatedTestFile('/repo/src/main/java/UserService.java', 'createUser', '/repo/src/test/java/AccountTests.java', 'service.createUser()'), true);
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

test('test file indexing rejects oversized files and total indexes', () => {
  assert.equal(canIndexTestFile(MAX_TEST_FILE_BYTES, 0), true);
  assert.equal(canIndexTestFile(MAX_TEST_FILE_BYTES + 1, 0), false);
  assert.equal(canIndexTestFile(1, MAX_TEST_INDEX_BYTES), false);
  assert.equal(canIndexTestFile(1, MAX_TEST_INDEX_BYTES - 1), true);
});
