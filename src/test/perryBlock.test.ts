import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContextBlock } from '../perryBlock';
import { SymbolContext } from '../types';

test('context block renders the visible comment format', () => {
  const context: SymbolContext = {
    symbol: {
      name: 'placeOrder',
      kind: 'Function',
      filePath: '/repo/src/order.service.ts',
      uri: 'file:///repo/src/order.service.ts',
      line: 12,
      range: {
        start: { line: 11, character: 0 },
        end: { line: 15, character: 1 }
      }
    },
    references: { available: true, count: 4 },
    usedBy: { available: true, symbols: ['CheckoutPage', 'OrderService'] },
    calls: { symbols: ['validateCart', 'calculateTax'] },
    git: { available: true, author: 'Anika', relativeDate: '3 days ago' },
    tests: [{ path: '/repo/src/order.service.test.ts', uri: 'file:///repo/src/order.service.test.ts' }],
    owner: { available: true, owner: '@payments-team' }
  };

  assert.equal(
    formatContextBlock(context, { commentPrefix: '//' }),
    [
      '// Used by: CheckoutPage, OrderService',
      '// Calls: validateCart(), calculateTax()',
      '// Last changed: 3 days ago by Anika',
      '// Related tests: order.service.test.ts',
      '// Owner: Payments Team'
    ].join('\n')
  );
});
