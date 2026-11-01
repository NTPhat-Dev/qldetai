import pg from 'pg'

const { Pool } = pg

export function createDatabasePool(serviceName) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.PG_POOL_MAX) || 10,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    application_name: `qldetai-${serviceName}`,
  })
  pool.on('error', (error) => console.error(`[${serviceName}] idle database connection failed:`, error.message))
  return pool
}
