import Koa from 'koa'
import cors from '@koa/cors'
import { bodyParser } from '@koa/bodyparser'

export function createApp({ name, pool = null, readiness = null }) {
  const app = new Koa()
  app.use(async (ctx, next) => {
    try {
      await next()
    } catch (error) {
      const status = error.status ?? (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', '57P01', '08006'].includes(error.code) ? 503 : 500)
      ctx.status = status
      ctx.body = { error: status === 500 ? 'Lỗi dịch vụ nội bộ.' : error.message }
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
