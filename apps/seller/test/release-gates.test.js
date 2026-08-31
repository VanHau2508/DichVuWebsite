import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

test('role connector và khoá mã hoá được đấu đủ vào đường deploy production', () => {
  const deploy = read('scripts/deploy.sh');
  const provision = read('scripts/provision-db-roles.sh');
  const compose = read('infra/compose.prod.yml');
  const example = read('.env.example');

  assert.match(example, /^APP_INTEGRATION_PASSWORD=.+$/m);
  assert.match(example, /^INTEGRATION_ENC_KEY=.+$/m);
  assert.match(provision, /ROLES=\([^\n]*\bapp_integration\b[^\n]*\)/,
    'provision phải đổi mật khẩu bootstrap của app_integration');
  assert.match(deploy, /-e APP_INTEGRATION_PASSWORD/,
    'deploy phải chuyển secret vào provision-db-roles');
  assert.match(deploy, /app_integration:APP_INTEGRATION_PASSWORD/,
    'deploy phải đăng nhập thử role connector bằng mật khẩu production');
  assert.match(deploy, /\^INTEGRATION_ENC_KEY=\[0-9a-fA-F\]\{64\}\$/,
    'deploy phải fail-fast nếu khoá mã hoá credential sai hình dạng');
  assert.match(compose, /DATABASE_URL_INTEGRATION: postgres:\/\/app_integration:\$\{APP_INTEGRATION_PASSWORD:\?\}/);
  assert.match(compose, /INTEGRATION_ENC_KEY: \$\{INTEGRATION_ENC_KEY:\?\}/);
});

// ── Cổng migration từ DB TRẮNG ───────────────────────────────────────────────
// Gate này tồn tại vì `ci-local.sh` chưa bao giờ chạy `migrate`: nó kiểm test trên DB dev
// ĐÃ áp migration từ trước, nên "112/112 xanh" không nói gì về việc máy trắng dựng nổi
// schema hay không. Ba lần liền phải bù bằng thao tác Docker thủ công, và chính lượt thủ
// công đó mới lộ ra bẫy GRANT cấp bảng ở 0173.
//
// Bộ dưới đây canh chuyện nó không bị gỡ ra LẠI. Đó là rủi ro có thật: một bước tốn ~1 phút
// và cần Docker là ứng viên số một cho "tạm bỏ cho nhanh" rồi không ai thêm lại.
test('fresh-migration gate được gọi từ CẢ ci-local.sh lẫn GitHub CI, và KHÔNG bị --fast bỏ qua', () => {
  // BỎ CHÚ THÍCH TRƯỚC KHI KHỚP. Đột biến `true # bash scripts/fresh-migration-gate.sh`
  // (gọi bị comment ra) vẫn qua được `assert.match` trên nguyên văn — đã đo: 5 pass/0 fail.
  const uncomment = (src) => src.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  const local = uncomment(read('scripts/ci-local.sh'));
  const cloud = read('.github/workflows/ci.yml');

  assert.match(local, /^\s*(if\s+)?bash scripts\/fresh-migration-gate\.sh/m,
    'ci-local.sh phải GỌI gate ở đầu một lệnh, không phải nhắc tên nó trong chú thích');
  assert.match(cloud, /run:\s*bash scripts\/fresh-migration-gate\.sh/, 'GitHub CI phải gọi gate');

  // Gate phải đứng TRƯỚC mọi rẽ nhánh theo $FAST. Bản đầu đếm `if`/`^fi$` để đoán độ lồng —
  // sai hoàn toàn, vì `^fi$` đếm cả những `fi` đóng if khác, nên đột biến "nhét gate vào
  // nhánh --fast" vẫn XANH. Vị trí tương đối thì không đoán được: đứng trước nhánh đầu tiên
  // nghĩa là không nhánh nào bỏ qua được nó.
  const gateAt = local.indexOf('bash scripts/fresh-migration-gate.sh');
  const firstFastBranch = local.indexOf('if [ "$FAST" -eq 1 ]');
  assert.ok(gateAt > -1, 'không tìm thấy lời gọi gate');
  assert.ok(firstFastBranch === -1 || gateAt < firstFastBranch,
    'gate phải chạy TRƯỚC mọi rẽ nhánh $FAST — đứng sau là chế độ --fast có thể bỏ qua nó');

  // Kết quả phải đi vào biến đếm lỗi, không được nuốt.
  const call = local.slice(local.indexOf('step "1b.'), local.indexOf('step "2.'));
  assert.match(call, /\bfail\b/, 'gate đỏ phải gọi fail() để cổng trả exit khác 0');
  assert.doesNotMatch(call, /\|\|\s*true/, 'không được che lỗi gate bằng || true');
});

test('fresh-migration gate cô lập tuyệt đối và luôn tự dọn', () => {
  const source = read('scripts/fresh-migration-gate.sh');

  // Tên project phải SINH ĐỘNG. Tên cố định là hẹn giờ cho hai lượt CI song song xoá
  // volume của nhau, và tệ hơn là va vào project dev.
  assert.match(source, /PROJECT="nentang-fresh-\$\$-\$\(date \+%s\)/,
    'tên project phải duy nhất mỗi lượt (PID + thời gian + ngẫu nhiên)');
  assert.doesNotMatch(source, /-p\s+nentang-dev\b/, 'không được đụng project dev');

  // Dọn ở MỌI đường thoát, kể cả Ctrl-C.
  assert.match(source, /trap cleanup EXIT INT TERM/, 'phải dọn bằng trap trên cả EXIT/INT/TERM');
  assert.match(source, /down -v --remove-orphans/, 'phải xoá volume riêng của project');

  // Đường production: BỎ seed. compose.dev gắn sẵn --seed 900_seed_dev.sql, mà gate phải
  // chứng minh riêng chuỗi migration dựng nổi schema.
  assert.match(source, /migrate node migrate\.js up/, 'phải chạy đúng runner production');
  // Chỉ soi dòng LỆNH. Bộ này đã đỏ HAI LẦN vì chú thích của chính script: một lần ở
  // `--seed`, một lần ở `|| true` — cả hai chỗ script đang GIẢI THÍCH vì sao không dùng
  // chúng. Chốt mức mã nguồn mà không bỏ chú thích trước thì tài liệu hoá thành trách nhiệm
  // pháp lý: viết càng rõ càng dễ đỏ.
  const codeLines = source.split('\n').filter((l) => !/^\s*#/.test(l));
  const code = codeLines.join('\n');
  assert.doesNotMatch(code, /--seed/, 'gate KHÔNG được dùng dev seed');

  // Chờ bằng health check thật, không phải sleep cố định dài.
  assert.match(source, /pg_isready/, 'phải chờ bằng pg_isready');
  assert.match(source, /TIMEOUT_HEALTH|FRESH_GATE_HEALTH_TIMEOUT/, 'phải có timeout');

  // Xác minh ba chiều + không nuốt lỗi.
  assert.match(source, /"\$n_drift"\s+=\s+"0"/, 'phải khẳng định 0 DRIFT');
  assert.match(source, /"\$n_pending"\s+=\s+"0"/, 'phải khẳng định 0 pending');
  assert.match(source, /MANIFEST_MIGRATION_COUNT/, 'phải so BẰNG với baseline khai trong manifest');
  assert.match(source, /SELECT count\(\*\) FROM schema_migrations/,
    'phải đếm từ PHÍA DB: migrate.js status chỉ duyệt file nên mù với dòng thừa trong bảng');
  // …và phải THỰC SỰ SO con số đó. Chạy truy vấn rồi vứt kết quả thì vô nghĩa: đột biến
  // `[ "$n_db" = "$n_db" ]` giữ nguyên câu SELECT và vẫn XANH — đã đo: 5 pass/0 fail.
  assert.match(code, /\[\s*"\$n_db"\s*=\s*"\$n_files"\s*\]/,
    'phải so n_db với n_files, không chỉ chạy truy vấn đếm');
  // `|| true` chỉ được phép ở đúng hai chỗ: dọn dẹp (không được nuốt mã thoát gốc) và
  // `grep -c` (trả 1 khi đếm được 0, không phải lỗi).
  const suspicious = codeLines
    .filter((l) => /\|\|\s*true/.test(l) && !/docker compose .*down -v|grep -c/.test(l));
  assert.deepEqual(suspicious, [], `|| true che lỗi ở: ${suspicious.join(' / ')}`);
});

test('baseline migration đếm theo FILE, không theo số thứ tự cao nhất', () => {
  // Hôm nay 181 file nhưng file mới nhất mang số 0183 — dãy có khoảng trống. Suy số lượng
  // từ số thứ tự là sai NGAY TỪ HÔM NAY, không phải rủi ro tương lai.
  const manifest = read('scripts/test-manifest.sh');
  const declared = Number(/MANIFEST_MIGRATION_COUNT=(\d+)/.exec(manifest)?.[1]);
  const actual = fs.readdirSync(path.join(root, 'packages/db/migrations')).filter((f) => f.endsWith('.sql')).length;
  assert.equal(declared, actual,
    `có ${actual} file migration, khai báo ${declared} → sửa MANIFEST_MIGRATION_COUNT=${actual} trong cùng commit`);

  const nums = fs.readdirSync(path.join(root, 'packages/db/migrations'))
    .filter((f) => f.endsWith('.sql')).map((f) => Number(f.slice(0, 4)));
  assert.ok(Math.max(...nums) > actual,
    'nếu số thứ tự cao nhất == số file thì dãy đã liền, và bộ này mất ý nghĩa cảnh báo — đọc lại chú thích trước khi sửa');
});

test('bảng số đo §0 khớp các nguồn đếm được và không bắt nhầm ghi chép lịch sử', () => {
  const claude = read('CLAUDE.md');
  const manifest = read('scripts/test-manifest.sh');
  const lines = claude.split(/\r?\n/);
  const row = (label) => {
    const found = lines.find((line) => line.includes(`| ${label} |`));
    assert.ok(found, `mốc chết: không tìm thấy hàng | ${label} | trong §0`);
    return found;
  };
  const metric = (label, pattern) => {
    const match = pattern.exec(row(label));
    assert.ok(match, `mốc chết: hàng ${label} đổi hình dạng`);
    return match;
  };
  const manifestCount = (name) => {
    const match = new RegExp(`^${name}=(\\d+)$`, 'm').exec(manifest);
    assert.ok(match, `mốc chết: không tìm thấy ${name}`);
    return Number(match[1]);
  };

  const migrationFiles = fs.readdirSync(path.join(root, 'packages/db/migrations'))
    .filter((file) => file.endsWith('.sql'));
  const migrationRow = metric('migration',
    /\|\s*migration\s*\|\s*(\d+)\s+tệp,\s*mới nhất\s+`(\d{4})`\s*\|/);
  const latestMigration = Math.max(...migrationFiles.map((file) => Number(file.slice(0, 4))));
  assert.equal(Number(migrationRow[1]), migrationFiles.length,
    'số migration trong §0 phải bằng số file thực tế');
  assert.equal(Number(migrationRow[1]), manifestCount('MANIFEST_MIGRATION_COUNT'),
    '§0 và manifest phải cùng một số migration');
  assert.equal(Number(migrationRow[2]), latestMigration,
    'số hiệu migration mới nhất trong §0 phải bằng file cao nhất');

  const unitRow = metric('bộ unit', /\|\s*bộ unit\s*\|\s*(\d+)\s*\|/);
  const e2eRow = metric('bộ e2e', /\|\s*bộ e2e\s*\|\s*(\d+)\s*\|/);
  assert.equal(Number(unitRow[1]), manifestCount('MANIFEST_UNIT_COUNT'));
  assert.equal(Number(e2eRow[1]), manifestCount('MANIFEST_E2E_COUNT'));

  const docsRow = metric('tài liệu', /\|\s*tài liệu\s*\|\s*(\d+)\s+tệp\s*\|/);
  const docsCopyLine = lines.find((line) => /^\s*docs\/\s+\d+\s+tệp ghi chép\b/.test(line));
  assert.ok(docsCopyLine, 'mốc chết: không tìm thấy bản sao số tài liệu ở §2');
  const docsCopy = /^\s*docs\/\s+(\d+)\s+tệp ghi chép\b/.exec(docsCopyLine);
  assert.ok(docsCopy, 'mốc chết: bản sao số tài liệu đổi hình dạng');
  const docsCount = fs.readdirSync(path.join(root, 'docs'))
    .filter((file) => file.endsWith('.md')).length;
  assert.equal(Number(docsRow[1]), docsCount, 'số tài liệu trong §0 phải bằng docs/*.md');
  assert.equal(Number(docsCopy[1]), Number(docsRow[1]),
    'hai bản sao số tài liệu phải bằng nhau');

  const dbRow = metric('bất biến DB', /\|\s*bất biến DB\s*\|\s*(\d+)\s+bộ,\s*\d+\s+test TAP\s*\|/);
  const dbTestCount = fs.readdirSync(path.join(root, 'packages/db/test'))
    .filter((file) => file.endsWith('.test.js')).length;
  assert.equal(Number(dbRow[1]), dbTestCount,
    'số bộ bất biến DB trong §0 phải bằng số file test DB');
});

test('ci-local đối chiếu số test TAP DB với bảng số đo §0', () => {
  const source = read('scripts/ci-local.sh');
  const code = source.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  const step = code.slice(code.indexOf('step "3. Cô lập tenant'), code.indexOf('if [ "$FAST" -eq 1 ]'));
  assert.ok(step.length > 0, 'mốc chết: không tìm thấy bước 3 của ci-local.sh');
  assert.match(step, /db_pass=\$\(grep[^\n]*va-db\.log[^\n]*\)/,
    'bước 3 phải lấy số pass TAP từ log DB');
  const extraction = /db_declared=\$\(sed -nE '([^']+)' CLAUDE\.md \| head -1\)/.exec(step);
  assert.ok(extraction, 'bước 3 phải đọc số bất biến DB đã khai trong §0');
  const runSed = (command) => execFileSync(command, ['-nE', extraction[1], 'CLAUDE.md'], {
    cwd: root,
    encoding: 'utf8',
  });
  let sedOutput;
  try {
    sedOutput = runSed('sed');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const sedPath = ['C:\\Program Files\\Git\\usr\\bin\\sed.exe', 'C:\\Program Files\\Git\\bin\\sed.exe']
      .find((candidate) => fs.existsSync(candidate));
    if (!sedPath) assert.fail('mốc chết: không tìm thấy sed để chạy thật phép rút');
    sedOutput = runSed(sedPath);
  }
  const sedResults = sedOutput
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.equal(sedResults.length, 1,
    'mốc chết: phép rút số TAP phải khớp đúng một hàng trong CLAUDE.md');
  const declared = sedResults[0];
  assert.match(declared, /^\d+$/, 'mốc chết: phép rút số TAP từ CLAUDE.md không trả đúng một số');
  const dbRow = /^\|\s*bất biến DB\s*\|\s*(\d+)\s+bộ,\s*(\d+)\s+test TAP\s*\|/.exec(
    read('CLAUDE.md').split(/\r?\n/).find((line) => line.includes('| bất biến DB |')) || '',
  );
  assert.ok(dbRow, 'mốc chết: hàng bất biến DB đổi hình dạng');
  assert.equal(declared, dbRow[2],
    'ci-local phải rút số test TAP (số thứ hai), không phải số bộ (số thứ nhất)');
  assert.match(step, /\[\s*"\$db_pass"\s+!=\s+"\$db_declared"\s*\]/,
    'bước 3 phải so BẰNG số TAP với số khai trong §0');
  assert.match(step, /mốc chết/,
    'bước 3 phải fail-closed khi không rút được mốc số liệu');
});
