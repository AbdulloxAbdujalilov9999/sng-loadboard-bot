import pg from 'pg';

// Same type fixes as server/src/db.js (int8 -> number, date stays a plain string).
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export function createBotPool(config) {
  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
    application_name: 'sng-one-telegram-bot',
  });
  pool.on('error', (err) => console.error('bot pg pool idle client error:', err.message));
  return pool;
}
