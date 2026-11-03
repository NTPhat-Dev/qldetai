import { createApp } from '../../shared/create-app.js'
import { createServiceFetch } from '../../shared/service-client.js'
import { authorize } from '../../shared/authorize.js'

const fetch = createServiceFetch('gateway')
const targets = { identity: 'http://identity-service:3101', academic: 'http://academic-service:3102', registrations: 'http://registration-service:3103' }
const ready = async () => {
  await Promise.all(Object.values(targets).map((target) => fetch(`${target}/ready`, { signal: AbortSignal.timeout(2000) })))
}
const app = createApp({ name: 'gateway', readiness: ready })

app.use(async (ctx) => {
  if (ctx.method === 'GET' && ctx.path === '/api/ready') {
    await ready()
    ctx.body = { status: 'ready', services: 'connected' }
    return
  }
  if (ctx.method === 'GET' && ctx.path === '/api/admin/overview') {
    await authorize(ctx, ['QUAN_TRI'], fetch)
    const [identity, academic, registration, rounds] = await Promise.all([
      fetch(`${targets.identity}/internal/v1/identity/overview`).then((response) => response.json()),
      fetch(`${targets.academic}/internal/v1/academic/overview`).then((response) => response.json()),
      fetch(`${targets.registrations}/internal/v1/registrations/overview`).then((response) => response.json()),
      fetch(`${targets.academic}/api/admin/rounds`, { headers: { authorization: ctx.get('authorization') } }).then((response) => response.json()),
    ])
    ctx.body = { stats: { ...identity, ...academic.stats, pendingRegistrations: registration.pending, rounds: rounds.length }, recentTopics: academic.recentTopics }
    return
  }

  // Internal service contracts never cross the public gateway.
  const section = ctx.path.replace(/^\/api\//, '')
  let target
  if (/^auth\//.test(section)) target = targets.identity
  else if (/^admin\/(departments(?:\/[^/]+\/classes)?|classes|rounds(?:\/[^/]+)?)$/.test(section) || /^portal\/(rounds|topics(?:\/[^/]+(?:\/publication)?)?)$/.test(section)) target = targets.academic
  else if (/^admin\/accounts(?:\/[^/]+\/(status|reset-password))?$/.test(section) || /^portal\/(profile|security(?:\/.*)?)$/.test(section)) target = targets.identity
  else if (/^(admin\/registrations|portal\/(overview|registrations(?:\/[^/]+\/(cancel|decision|history))?))$/.test(section)) target = targets.registrations
  if (!ctx.path.startsWith('/api/') || !target) { ctx.status = 404; ctx.body = { error: 'Không tìm thấy chức năng.' }; return }

  const headers = new Headers()
  for (const name of ['authorization','content-type','x-request-id']) if (ctx.get(name)) headers.set(name, ctx.get(name))
  headers.set('x-real-ip', ctx.get('x-real-ip') || ctx.ip)
  try {
    const response = await globalThis.fetch(`${target}${ctx.path}${ctx.querystring ? `?${ctx.querystring}` : ''}`, {
      method: ctx.method, headers, signal: AbortSignal.timeout(10000),
      body: ['GET','HEAD'].includes(ctx.method) ? undefined : JSON.stringify(ctx.request.body ?? {}),
    })
    ctx.status = response.status
    ctx.type = response.headers.get('content-type') ?? 'application/json'
    if (response.headers.has('retry-after')) ctx.set('Retry-After', response.headers.get('retry-after'))
    const body = await response.text()
    if (!body) ctx.body = null
    else { try { ctx.body = JSON.parse(body) } catch { ctx.body = body } }
  } catch {
    ctx.status = 503; ctx.set('Retry-After','3')
    ctx.body = { error: 'Dịch vụ đang khôi phục kết nối. Vui lòng thử lại.' }
  }
})

const port = Number(process.env.PORT) || 3100
const server = app.listen(port, () => console.log(`API gateway listening on ${port}`))
for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => server.close())
