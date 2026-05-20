import test from 'node:test';
import assert from 'node:assert/strict';
import { matchCodeOwner, matchesCodeownersPattern, parseCodeowners } from '../codeowners';

test('CODEOWNERS parser ignores comments and uses the last matching owner', () => {
  const rules = parseCodeowners(`
# comment
* @global
src/ @src-team
src/payments/ @payments-team
*.py @python-team
`);

  assert.equal(matchCodeOwner(rules, 'src/payments/checkout.ts'), '@payments-team');
  assert.equal(matchCodeOwner(rules, 'scripts/tool.py'), '@python-team');
  assert.equal(matchCodeOwner(rules, 'README.md'), '@global');
});

test('CODEOWNERS pattern matcher handles suffixes, prefixes, and simple globs', () => {
  assert.equal(matchesCodeownersPattern('*.ts', 'src/index.ts'), true);
  assert.equal(matchesCodeownersPattern('src/', 'src/index.ts'), true);
  assert.equal(matchesCodeownersPattern('src/**/model.ts', 'src/domain/payments/model.ts'), true);
  assert.equal(matchesCodeownersPattern('docs/', 'src/index.ts'), false);
});
