import Koa from 'koa'
import { bodyParser } from '@koa/bodyparser'
import { verifyServiceToken } from './service-client.js'

export const databaseUnavailable = (error) => Boolean(error && (
  /query read timeout|connection terminated|connection timeout|timeout exceeded when trying to connect/i.test(error.message ?? '')
  || error.code?.startsWith('08')
  || ['ECONNREFUSED','ECONNRESET','ETIMEDOUT','EHOSTUNREACH','ENETUNREACH','EPIPE','ENOTFOUND','EAI_AGAIN','ERR_SOCKET_CLOSED','57P01','57P02','57P03','57P05','53300','57014'].includes(error.code)
  || error.errors?.some(databaseUnavailable)
  || (error.cause && databaseUnavailable(error.cause))
))

export function createApp({ name, pool = null, readiness = null }) {
  const app = new Koa()
  app.use(async (ctx, next) => {
    try {
      await next()
    } catch (error) {
      const dbUnavailable = databaseUnavailable(error)
      const invalidInput = ['22P02','22007','22008','23514','22001'].includes(error.code)
      const status = error.status ?? (dbUnavailable ? 503 : invalidInput ? 400 : 500)
      if (status === 503) ctx.set('Retry-After', '3')
      ctx.status = status
      ctx.body = { error: status === 500 ? 'Lỗi dịch vụ nội bộ.' : dbUnavailable ? 'Kết nối cơ sở dữ liệu đang gián đoạn. Vui lòng thử lại sau ít phút.' : invalidInput ? 'Dữ liệu nhập không hợp lệ.' : error.message }
      if (status >= 500) console.error(`[${name}] request failed:`, error)
    }
  })
  app.use(bodyParser())
  app.use(async (ctx, next) => {
    if (ctx.path.startsWith('/internal/')) {
      try { ctx.state.service = verifyServiceToken(ctx.get('x-service-token')) }
      catch { ctx.throw(401, 'Yêu cầu nội bộ chưa được xác thực.') }
    }
    await next()
  })
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
