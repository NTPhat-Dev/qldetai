import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { api, fetchWithTimeout, newRequestId, shouldRetainQueuedRequest } from '../src/api.ts'

test('request IDs work over LAN HTTP without randomUUID and keep UUID v4 bits', () => {
  const id = newRequestId({ getRandomValues(bytes) { return bytes.fill(255) } })
  assert.equal(id, 'ffffffff-ffff-4fff-bfff-ffffffffffff')
})

test('queued registration survives service failures and expired sessions; business rejections finish it', () => {
  for (const status of [401,403,408,429,500,502,503,504]) assert.equal(shouldRetainQueuedRequest(status), true)
  for (const status of [200,201,400,404,409,422]) assert.equal(shouldRetainQueuedRequest(status), false)
})

test('hung HTTP requests are aborted so offline retry can continue', async () => {
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    await assert.rejects(fetchWithTimeout(`http://127.0.0.1:${server.address().port}`, {}, 40), { name: 'AbortError' })
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('business errors remain errors instead of a successful save', async () => {
  const previous = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify({ error: 'Đề tài đã đủ số lượng.' }), { status: 409 })
  try { await assert.rejects(api('/portal/registrations', 'test', 'POST', {}), /Đề tài đã đủ số lượng/) }
  finally { globalThis.fetch = previous }
})
