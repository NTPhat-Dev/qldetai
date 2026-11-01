import Koa from 'koa'
import cors from '@koa/cors'
import { bodyParser } from '@koa/bodyparser'

const databaseUnavailable = (error) =>
  error.code?.startsWith('08')
  || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE','57P01','57P02','57P03','53300'].includes(error.code)

export function createApp({ name, pool = null, readiness = null }) {
  const app = new Koa()
  app.use(async (ctx, next) => {
    try {
      await next()
    } catch (error) {
      const dbUnavailable = databaseUnavailable(error)
      const status = error.status ?? (dbUnavailable ? 503 : 500)
      if (dbUnavailable) ctx.set('Retry-After', '3')
      ctx.status = status
      ctx.body = { error: status === 500 ? 'Lỗi dịch vụ nội bộ.' : dbUnavailable ? 'Kết nối cơ sở dữ liệu đang gián đoạn. Vui lòng thử lại sau ít phút.' : error.message }
      if (status >= 500) console.error(`[${name}] request failed:`, error)
    }
  })
  app.use(cors())
  app.use(bodyParser())
  app.use(async (ctx, next) => {
    if (ctx.method === 'GET' && ctx.path === '/health') {
      ctx.body = { service: name, status: 'ok' }
      return
    }
    if (ctx.method === 'GET' && ctx.path === '/ready') {
      if (!pool && !readiness) {
        ctx.body = { service: name, status: 'ready' }
        return
      }
      try {
        if (readiness) await readiness()
        else await pool.query('SELECT 1')
        ctx.body = pool
          ? { service: name, status: 'ready', database: 'connected' }
          : { service: name, status: 'ready', dependencies: 'ready' }
      } catch {
        ctx.status = 503
        ctx.body = { service: name, status: 'not_ready', database: 'disconnected' }
      }
      return
    }
    await next()
  })
  return app
}
