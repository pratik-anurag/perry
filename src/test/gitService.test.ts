import test from 'node:test';
import assert from 'node:assert/strict';
import { formatRelativeDate } from '../gitService';

test('relative date formatting handles common buckets', () => {
  const now = new Date(2024, 4, 20, 12, 0, 0);

  assert.equal(formatRelativeDate(new Date(2024, 4, 20, 1, 0, 0).getTime() / 1000, now), 'today');
  assert.equal(formatRelativeDate(new Date(2024, 4, 19, 1, 0, 0).getTime() / 1000, now), 'yesterday');
  assert.equal(formatRelativeDate(new Date(2024, 4, 10, 1, 0, 0).getTime() / 1000, now), '10 days ago');
  assert.equal(formatRelativeDate(new Date(2024, 2, 20, 1, 0, 0).getTime() / 1000, now), '2 months ago');
  assert.equal(formatRelativeDate(new Date(2022, 4, 20, 1, 0, 0).getTime() / 1000, now), '2 years ago');
});
