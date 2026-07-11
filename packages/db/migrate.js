/**
 * Migration runner — forward-only.
 *
 *   node migrate.js up   [--seed <file>]   áp dụng các migration còn thiếu
 *   node migrate.js status                  liệt kê đã áp dụng / còn chờ
 *
 * Vì sao forward-only (không có down migration):
 *   `docs/03` đã chốt rollback = khôi phục backup hoặc deploy lại image cũ, và
 *   migration phải tương thích ngược một phiên bản. Down migration là một cơ chế
 *   rollback THỨ HAI, mâu thuẫn với cái thứ nhất và thường sai lúc cần nhất
 *   (2 giờ sáng, đang cháy). Bỏ nó đi cho bớt một thứ có thể hỏng.
 *
 * An toàn:
 *   - advisory lock: hai runner chạy song song không giẫm lên nhau.
 *   - checksum: migration đã áp dụng mà bị sửa nội dung → dừng ngay (drift).
 *     Migration là bất biến; sửa lịch sử là cách âm thầm làm lệch prod với dev.
 *   - mỗi migration chạy trong MỘT transaction: lỗi giữa chừng → rollback sạch.
 *   - chạy bằng app_owner (chủ schema), KHÔNG phải app_rw.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
const ADVISORY_LOCK_ID = 4_072_025; // tuỳ ý, cố định cho dự án này
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function log(event, fields = {}) {
  process.stdout.write(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }) + '\n');
}

function migrationFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort(); // tên bắt đầu bằng số 4 chữ số → sort chuỗi = đúng thứ tự
}

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text PRIMARY KEY,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function up(client, { seedFile } = {}) {
  await ensureTable(client);

  const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));

  let count = 0;
  for (const file of migrationFiles()) {
    const version = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');

    // File migration rỗng luôn là nhầm lẫn (thường là artifact mountpoint 0 byte).
    // Ghi nhận nó vào schema_migrations là âm thầm chôn một lỗi. Dừng ngay.
    if (sql.trim() === '') {
      throw new Error(`migration ${version} rỗng — xoá nó hoặc thêm nội dung`);
    }

    const checksum = sha256(sql);

    if (applied.has(version)) {
      if (applied.get(version) !== checksum) {
        throw new Error(
          `DRIFT: migration ${version} đã áp dụng nhưng nội dung đã đổi. ` +
            `Migration là bất biến — tạo migration MỚI thay vì sửa cái cũ.`,
        );
      }
      continue;
    }

    // Mỗi migration trong một transaction riêng: đến đâu chắc đến đó.
    await client.query('BEGIN');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)', [
        version,
        checksum,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${version} thất bại: ${err.message}`);
    }
    log('migration_applied', { version });
    count++;
  }

  if (seedFile) {
    // Seed KHÔNG được ghi vào schema_migrations: nó chỉ dành cho dev, phải
    // idempotent (ON CONFLICT DO NOTHING), và không bao giờ chạy ở production.
    const sql = fs.readFileSync(seedFile, 'utf8');
    await client.query(sql);
    log('seed_applied', { file: path.basename(seedFile) });
  }

  log('up_done', { applied: count });
}

async function status(client) {
  await ensureTable(client);
  const { rows } = await client.query('SELECT version, checksum FROM schema_migrations');
  const applied = new Map(rows.map((r) => [r.version, r.checksum]));

  for (const file of migrationFiles()) {
    const version = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const cur = sha256(sql);
    let state;
    if (!applied.has(version)) state = 'PENDING';
    else if (applied.get(version) !== cur) state = 'DRIFT';
    else state = 'applied';
    log('status', { version, state });
  }
}

async function main() {
  const cmd = process.argv[2] ?? 'up';
  const seedIdx = process.argv.indexOf('--seed');
  const seedFile = seedIdx !== -1 ? process.argv[seedIdx + 1] : undefined;

  const url = process.env.DATABASE_URL_OWNER;
  if (!url) throw new Error('thiếu DATABASE_URL_OWNER');

  const client = new pg.Client({ connectionString: url });
  await client.connect();

  // Chặn hai runner chạy đồng thời (deploy song song, CI trùng nhau).
  await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_ID]);
  try {
    if (cmd === 'up') await up(client, { seedFile });
    else if (cmd === 'status') await status(client);
    else throw new Error(`lệnh không rõ: ${cmd} (dùng: up | status)`);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]);
    await client.end();
  }
}

main().catch((err) => {
  log('error', { message: err.message });
  process.exit(1);
});
