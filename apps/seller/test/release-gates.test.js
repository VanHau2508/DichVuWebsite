import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('go/no-go chỉ được kết luận sau full CI và không xoá toàn bộ Redis', () => {
  const source = read('scripts/go-no-go.sh');
  assert.match(source, /suite full_ci\s+"toàn bộ unit \+ DB \+ e2e \+ smoke" bash scripts\/ci-local\.sh/);
  assert.match(source, /\[ "\$\{R\[full_ci\]\}" = PASS \] \|\| nogo=/);
  assert.match(source, /redis-cli --scan --pattern 'rl:\*'/);
  assert.doesNotMatch(source, /redis-cli\s+flushall/i);
});

test('dependency scan đỏ khi Docker hoặc npm audit không chạy được', () => {
  const source = read('scripts/security-scan.sh');
  assert.match(source, /audit_rc=\$\?/);
  assert.match(source, /dependency scan KHÔNG CHẠY ĐƯỢC/);
  assert.match(source, /npm audit trả kết quả không nhận diện được/);
  assert.doesNotMatch(source, /\|\| \[ -z "\$out" \]/);
});
