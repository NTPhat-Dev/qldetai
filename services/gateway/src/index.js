import { createApp } from '../../shared/create-app.js'
import jwt from 'jsonwebtoken'

const targets = {
  identity: 'http://identity-service:3101',
  academic: 'http://academic-service:3102',
  registrations: 'http://registration-service:3103',
}
const app = createApp({
  name: 'gateway',
  readiness: async () => {
    const checks = await Promise.all(Object.values(targets).map((target) => fetch(`${target}/ready`, { signal: AbortSignal.timeout(2_000) })))
    if (checks.some((response) => !response.ok)) throw new Error('A domain service is not ready')
  },
})

app.use(async (ctx) => {
  if (ctx.method === 'GET' && ctx.path === '/api/ready') {
    ctx.body = { status: 'ready', services: 'connected' }
    return
  }
  if (ctx.method === 'GET' && ctx.path === '/api/admin/overview') {
    try {
      const claims = jwt.verify(ctx.get('authorization').replace(/^Bearer\s+/i, ''), process.env.JWT_SECRET)
      if (claims.role !== 'QUAN_TRI' || claims.mustChangePassword) ctx.throw(403, 'Bạn không có quyền truy cập.')
      const [identity, academic, registration] = await Promise.all([
        fetch('http://identity-service:3101/internal/v1/identity/overview').then((response) => response.json()),
        fetch('http://academic-service:3102/internal/v1/academic/overview').then((response) => response.json()),
        fetch('http://registration-service:3103/internal/v1/registrations/overview').then((response) => response.json()),
      ])
      ctx.body = { stats: { ...identity, ...academic.stats, pendingRegistrations: registration.pending, rounds: (await fetch('http://academic-service:3102/api/admin/rounds', { headers: { authorization: ctx.get('authorization') } }).then((response) => response.json())).length }, recentTopics: academic.recentTopics }
    } catch (error) { ctx.status = error.status === 403 ? 403 : error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError' ? 401 : 503; ctx.body = { error: ctx.status === 503 ? 'Chưa tải được tổng quan các dịch vụ.' : 'Phiên đăng nhập hết hạn hoặc không hợp lệ.' } }
    return
  }

  if (ctx.path.startsWith('/api/auth/')) {
    const headers = new Headers()
    for (const name of ['authorization', 'content-type', 'x-request-id']) {
      const value = ctx.get(name)
      if (value) headers.set(name, value)
    }
    try {
      const response = await fetch(`${targets.identity}${ctx.path}${ctx.querystring ? `?${ctx.querystring}` : ''}`, {
        method: ctx.method,
        headers,
        body: ['GET', 'HEAD'].includes(ctx.method) ? undefined : JSON.stringify(ctx.request.body ?? {}),
        signal: AbortSignal.timeout(10_000),
      })
      ctx.status = response.status
      ctx.type = response.headers.get('content-type') ?? 'application/json'
      const body = await response.text()
      if (!body) ctx.body = null
      else { try { ctx.body = JSON.parse(body) } catch { ctx.body = body } }
      return
    } catch {
      ctx.status = 503
      ctx.body = { error: 'Dịch vụ tài khoản đang tạm thời không sẵn sàng.' }
      return
    }
  }

  const publicDomain = ctx.path.match(/^\/api\/(admin\/(departments(?:\/[^/]+\/classes)?|classes|rounds(?:\/[^/]+)?|accounts)|portal\/(overview|topics(?:\/[^/]+\/publication)?|registrations(?:\/[^/]+\/(?:cancel|decision))?|profile|security(?:\/.*)?))$/)
  if (publicDomain) {
    const section = publicDomain[1]
    const target = section.startsWith('admin/departments') || section === 'admin/classes' || section.startsWith('admin/rounds') || section.startsWith('portal/topics')
      ? targets.academic
      : section.startsWith('admin/accounts') || section.startsWith('portal/profile') || section.startsWith('portal/security')
        ? targets.identity : targets.registrations
    const headers = new Headers()
    for (const name of ['authorization', 'content-type', 'x-request-id']) {
      const value = ctx.get(name)
      if (value) headers.set(name, value)
    }
    try {
      const response = await fetch(`${target}${ctx.path}${ctx.querystring ? `?${ctx.querystring}` : ''}`, {
        method: ctx.method, headers,
        body: ['GET', 'HEAD'].includes(ctx.method) ? undefined : JSON.stringify(ctx.request.body ?? {}),
        signal: AbortSignal.timeout(10_000),
      })
      ctx.status = response.status
      ctx.type = response.headers.get('content-type') ?? 'application/json'
      const body = await response.text()
      if (!body) ctx.body = null
      else { try { ctx.body = JSON.parse(body) } catch { ctx.body = body } }
    } catch {
      ctx.status = 503
      ctx.body = { error: 'Dịch vụ nghiệp vụ đang tạm thời không sẵn sàng.' }
    }
    return
  }

  const route = ctx.path.match(/^\/internal\/v1\/(identity|academic|registrations)(\/.*)?$/)
  if (!route) {
    ctx.status = 404
    ctx.body = { error: 'Not found' }
    return
  }

  const upstreamPath = `/internal/v1/${route[1]}${route[2] ?? ''}${ctx.querystring ? `?${ctx.querystring}` : ''}`
  const headers = new Headers()
  for (const name of ['authorization', 'content-type', 'idempotency-key', 'x-request-id']) {
    const value = ctx.get(name)
    if (value) headers.set(name, value)
  }

  let response
  try {
    response = await fetch(`${targets[route[1]]}${upstreamPath}`, {
      method: ctx.method,
      headers,
      body: ['GET', 'HEAD'].includes(ctx.method) ? undefined : JSON.stringify(ctx.request.body ?? {}),
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    ctx.status = 503
    ctx.set('Retry-After', '3')
    ctx.body = { error: `Dịch vụ ${route[1]} đang tạm thời không sẵn sàng.` }
    return
  }

  ctx.status = response.status
  const responseBody = await response.text()
  ctx.type = response.headers.get('content-type') ?? 'application/json'
  if (!responseBody) {
    ctx.body = null
  } else {
    try { ctx.body = JSON.parse(responseBody) } catch { ctx.body = responseBody }
  }
})

const port = Number(process.env.PORT) || 3100
const server = app.listen(port, () => console.log(`API gateway listening on ${port}`))
process.once('SIGINT', () => server.close())
process.once('SIGTERM', () => server.close())
