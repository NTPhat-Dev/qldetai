import Koa from 'koa'
import cors from '@koa/cors'

const app = new Koa()
const port = Number(process.env.PORT) || 3000

app.use(cors())

app.use(async (ctx) => {
  if (ctx.method === 'GET' && ctx.path === '/api/health') {
    ctx.body = { status: 'ok' }
    return
  }

  ctx.status = 404
  ctx.body = { error: 'Not found' }
})

app.listen(port, () => {
  console.log(`Koa API listening on http://localhost:${port}`)
})
