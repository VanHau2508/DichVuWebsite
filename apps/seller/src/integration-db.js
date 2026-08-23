import pg from 'pg';

const url = process.env.DATABASE_URL_INTEGRATION;
export const integrationDb = url ? new pg.Pool({ connectionString: url, max: 6 }) : null;

export async function withIntegrationTenant(shopId, fn) {
  if (!integrationDb) throw Object.assign(new Error('chưa cấu hình DATABASE_URL_INTEGRATION'), { statusCode: 503 });
  const client = await integrationDb.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('app.shop_id', $1, true)`, [shopId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function resolveIntegrationWebhook(publicId) {
  if (!integrationDb) return null;
  const result = await integrationDb.query(
    `SELECT integration_id, shop_id, provider, credential_ciphertext
       FROM resolve_integration_webhook($1)`, [publicId],
  );
  return result.rows[0] ?? null;
}
