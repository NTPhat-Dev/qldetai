// Real integration tests. Every Docker mutation is scoped to a new disposable project.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, createHmac, createSign, generateKeyPairSync } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const project = `qldetai-verify-${randomBytes(5).toString('hex')}`
assert.match(project, /^qldetai-verify-[0-9a-f]{10}$/)
const port = await new Promise((resolve, reject) => {
  const listener = createServer().on('error', reject)
  listener.listen(0, '127.0.0.1', () => {
    const port = listener.address().port
    listener.close(() => resolve(port))
  })
})
const serviceKeys = Object.fromEntries(['identity','academic','registration','gateway'].flatMap((service) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  return [[`INTERNAL_${service.toUpperCase()}_PRIVATE_KEY`, Buffer.from(privateKey).toString('base64')], [`INTERNAL_${service.toUpperCase()}_PUBLIC_KEY`, Buffer.from(publicKey).toString('base64')]]
}))
const env = {
  ...process.env, WEB_PORT: String(port), POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
  TOTP_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  ...serviceKeys,
  WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: `http://localhost:${port}`,
}
const base = `http://127.0.0.1:${port}`
const results = []
const fixtures = {}
const password = `Test-${randomBytes(16).toString('hex')}`
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function totpCode(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, value = 0
  const bytes = []
  for (const char of base32.replace(/=+$/, '').toUpperCase()) {
    value = (value << 5) | alphabet.indexOf(char)
    bits += 5
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255) }
  }
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30000)))
  const hash = createHmac('sha1', Buffer.from(bytes)).update(counter).digest()
  const offset = hash.at(-1) & 15
  return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0')
}
function run(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '-p', project, '--profile', 'soa', ...args], { cwd: root, env, windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(output) : reject(new Error(`Docker ${args.join(' ')} failed (${code}): ${output.slice(-6000)}`)))
    child.stdin.end(input)
  })
}
async function call(route, { token, method = 'GET', body, timeout = 16000 } = {}) {
  const started = Date.now()
  const response = await fetch(`${base}${route}`, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout),
  })
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data, elapsed: Date.now() - started }
}
function expect(response, status, label) {
  assert.equal(response.status, status, `${label}: expected ${status}, got ${response.status} (${response.data?.error ?? ''})`)
  return response.data
}
async function check(name, action) {
  const started = Date.now()
  try {
    await action()
    results.push({ name, passed: true, milliseconds: Date.now() - started })
    console.log(`PASS ${name} (${Date.now() - started}ms)`)
  } catch (error) {
    const serviceLogs = await run(['logs', '--no-color', '--tail', '35', 'registration-service']).catch(() => '')
    if (serviceLogs) console.error(`Registration service logs (last 35 lines):\n${serviceLogs.slice(-5000)}`)
    results.push({ name, passed: false, milliseconds: Date.now() - started, error: error.message })
    console.error(`FAIL ${name}: ${error.message}`)
    throw error
  }
}
async function waitReady() {
  const deadline = Date.now() + 180000
  while (Date.now() < deadline) {
    try { if ((await call('/api/ready', { timeout: 5000 })).status === 200) return } catch {}
    await sleep(1000)
  }
  throw new Error('Services did not become ready within 180 seconds')
}
async function internalHealth(service, endpoint = '/health') {
  const ports = { 'identity-service': 3101, 'academic-service': 3102, 'registration-service': 3103 }
  return Number((await run(['exec', '-T', 'api-gateway', 'node', '-e', `fetch('http://${service}:${ports[service]}${endpoint}',{signal:AbortSignal.timeout(8000)}).then(r=>console.log(r.status)).catch(()=>console.log(0))`])).trim())
}
async function gatewayStatus(endpoint) {
  return Number((await run(['exec', '-T', 'api-gateway', 'node', '-e', `fetch('http://127.0.0.1:3100${endpoint}',{signal:AbortSignal.timeout(8000)}).then(r=>console.log(r.status)).catch(()=>console.log(0))`])).trim())
}
async function internalStatus(service, port, endpoint) {
  return Number((await run(['exec', '-T', 'api-gateway', 'node', '-e', `fetch('http://${service}:${port}${endpoint}',{signal:AbortSignal.timeout(8000)}).then(r=>console.log(r.status)).catch(()=>console.log(0))`])).trim())
}
async function sql(service, db, query) {
  return (await run(['exec', '-T', service, 'psql', '-U', db, '-d', db, '-tA', '-c', query])).trim()
}
async function login(username, secret, change = true) {
  const result = expect(await call('/api/auth/login', { method: 'POST', body: { username, password: secret } }), 200, 'login')
  if (result.mustChangePassword && change) {
    const changed = expect(await call('/api/auth/change-password', { method: 'POST', token: result.token, body: { newPassword: password } }), 200, 'first password change')
    return { ...result, token: changed.token, password }
  }
  return { ...result, password: secret }
}
async function provision(role, name) {
  const account = expect(await call('/api/admin/accounts', { token: fixtures.admin.token, method: 'POST', body: {
    role, name, departmentId: fixtures.department.id, ...(role === 'SINH_VIEN' ? { classId: fixtures.classroom.id } : {}),
  } }), 201, 'provision account')
  return { ...account, ...await login(account.username, account.temporaryPassword) }
}
async function topic(title, capacity = 1) {
  const topic = expect(await call('/api/portal/topics', { token: fixtures.lecturer.token, method: 'POST', body: {
    title, description: 'Disposable fault test fixture', roundId: fixtures.round.id, capacity,
  } }), 201, 'create topic')
  expect(await call(`/api/portal/topics/${topic.id}/publication`, { token: fixtures.lecturer.token, method: 'PATCH', body: { published: true } }), 200, 'publish topic')
  return topic
}
const register = (student, target, requestId = randomUUID(), reason = 'Integration test') => call('/api/portal/registrations', {
  token: student.token, method: 'POST', body: { requestId, topicId: target.id, roundId: fixtures.round.id, reason },
})
function alteredToken(token, patch) {
  const [header, payload] = token.split('.')
  const changed = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url')), ...patch })).toString('base64url')
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${changed}`)
  const signature = signer.sign(Buffer.from(serviceKeys.INTERNAL_IDENTITY_PRIVATE_KEY, 'base64')).toString('base64url')
  return `${header}.${changed}.${signature}`
}

console.log(`Isolated test project: ${project}; web ${base}`)
await mkdir(path.join(root, 'test-results'), { recursive: true })
let failed = false
try {
  await check('Fresh installation and independent databases', async () => {
    await run(['up', '-d', '--build', '--wait', '--wait-timeout', '180'])
    await waitReady()
    for (const name of ['identity', 'academic', 'registration']) {
      const schemas = await sql(`${name}-db`, name, "SELECT schema_name FROM information_schema.schemata WHERE schema_name IN ('identity','academic','registration') ORDER BY schema_name")
      assert.equal(schemas, name, `${name} database must only own its domain schema`)
    }
    const containers = (await run(['ps', '--format', 'json'])).split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    assert.equal(containers.length, 8)
    assert.equal(containers.filter((row) => row.Publishers?.some((port) => port.PublishedPort > 0)).length, 1, 'Only web may publish a host port')
  })
  await check('Admin bootstrap, first password change and role boundaries', async () => {
    const temporaryPassword = randomBytes(16).toString('hex')
    const created = JSON.parse(await run(['exec', '-T', 'identity-service', 'node', 'scripts/create-admin.js'], JSON.stringify({ username: 'admin.test', name: 'Integration admin', temporaryPassword })))
    assert.equal(created.created, true)
    fixtures.admin = await login('admin.test', temporaryPassword)
    expect(await call('/api/admin/overview', { token: fixtures.admin.token }), 200, 'admin overview')
    assert.ok([401, 404].includes(await gatewayStatus('/internal/v1/identity/overview')), 'gateway must not expose internal data')
    assert.equal(await internalStatus('identity-service', 3101, '/internal/v1/identity/overview'), 401, 'internal service requires a signed service token')
    const publicInternal = await fetch(`${base}/internal/v1/identity/overview`)
    assert.notEqual(publicInternal.headers.get('content-type')?.split(';')[0], 'application/json', 'web must not return internal data')
    const mfaPending = alteredToken(fixtures.admin.token, { mfaPending: true })
    assert.ok([401, 403].includes((await call('/api/admin/rounds', { token: mfaPending })).status), 'MFA challenge token cannot authorize domain APIs')
    const badLogin = await call('/api/auth/login', { method: 'POST', body: { username: 'admin.test', password: 'wrong-password' } })
    expect(badLogin, 401, 'invalid password')
    assert.equal(badLogin.data.error, 'Sai tên đăng nhập hoặc mật khẩu.')
  })
  await check('Create organization, accounts, round and published topic', async () => {
    fixtures.department = expect(await call('/api/admin/departments', { token: fixtures.admin.token, method: 'POST', body: { name: 'Công nghệ thông tin' } }), 201, 'department')
    expect(await call('/api/admin/departments', { token: fixtures.admin.token, method: 'POST', body: { name: ' CONG   NGHE THONG TIN ' } }), 409, 'normalized duplicate department')
    fixtures.classroom = expect(await call('/api/admin/classes', { token: fixtures.admin.token, method: 'POST', body: { departmentId: fixtures.department.id } }), 201, 'class')
    fixtures.lecturer = await provision('GIANG_VIEN', 'Test lecturer')
    fixtures.otherLecturer = await provision('GIANG_VIEN', 'Other lecturer')
    fixtures.students = []
    for (let index = 0; index < 12; index++) fixtures.students.push(await provision('SINH_VIEN', `Test student ${index + 1}`))
    const year = new Date().getUTCFullYear()
    fixtures.round = expect(await call('/api/admin/rounds', { token: fixtures.admin.token, method: 'POST', body: {
      semesterNumber: 1, semesterStart: `${year}-01-01`, semesterEnd: `${year}-12-31`,
      opensAt: new Date(Date.now() - 3600000).toISOString(), closesAt: new Date(Date.now() + 86400000).toISOString(),
    } }), 201, 'round')
    expect(await call(`/api/admin/rounds/${fixtures.round.id}`, { token: fixtures.admin.token, method: 'PATCH', body: { isOpen: true } }), 200, 'open round')
    fixtures.singleSeat = await topic('Exactly one seat', 1)
    expect(await call('/api/admin/accounts', { token: fixtures.students[0].token }), 403, 'student cannot administer')
    expect(await call('/api/portal/overview', { token: fixtures.admin.token }), 403, 'admin cannot access student portal')
  })
  await check('12 simultaneous registrations for the final seat', async () => {
    const requestIds = fixtures.students.map(() => randomUUID())
    const attempts = await Promise.all(fixtures.students.map((student, index) => register(student, fixtures.singleSeat, requestIds[index])))
    assert.equal(attempts.filter((response) => response.status === 201).length, 1, 'Exactly one request must win')
    assert.equal(attempts.filter((response) => response.status === 409).length, 11, 'Remaining requests must receive a conflict')
    fixtures.winnerIndex = attempts.findIndex((response) => response.status === 201)
    fixtures.winner = fixtures.students[fixtures.winnerIndex]
    fixtures.registration = attempts[fixtures.winnerIndex].data
    fixtures.winnerRequestId = requestIds[fixtures.winnerIndex]
    assert.equal(await sql('registration-db', 'registration', "SELECT count(*) FROM registration.registrations WHERE status IN ('CHO_DUYET','DA_DUYET')"), '1')
    expect(await register(fixtures.winner, fixtures.singleSeat, fixtures.winnerRequestId), 200, 'safe retry after lost response')
    expect(await register(fixtures.winner, fixtures.singleSeat, fixtures.winnerRequestId, 'different payload'), 409, 'idempotency payload mismatch')
  })
  await check('Ownership, publication fence, cancellation and history', async () => {
    expect(await call(`/api/portal/topics/${fixtures.singleSeat.id}/publication`, { token: fixtures.lecturer.token, method: 'PATCH', body: { published: false } }), 409, 'cannot hide a topic with active registration')
    expect(await call(`/api/portal/registrations/${fixtures.registration.id}/decision`, { token: fixtures.otherLecturer.token, method: 'PATCH', body: { status: 'DA_DUYET' } }), 403, 'other lecturer cannot decide')
    expect(await call(`/api/portal/registrations/${fixtures.registration.id}/decision`, { token: fixtures.lecturer.token, method: 'PATCH', body: { status: 'TU_CHOI' } }), 400, 'rejection requires reason')
    expect(await call(`/api/portal/registrations/${fixtures.registration.id}/cancel`, { token: fixtures.winner.token, method: 'PATCH' }), 200, 'cancel pending registration')
    fixtures.registration = expect(await register(fixtures.winner, fixtures.singleSeat), 201, 'cancellation releases the seat')
    const decisions = await Promise.all(Array.from({ length: 3 }, () => call(`/api/portal/registrations/${fixtures.registration.id}/decision`, { token: fixtures.lecturer.token, method: 'PATCH', body: { status: 'TU_CHOI', note: 'Needs more preparation' } })))
    assert.equal(decisions.filter((response) => response.status === 200).length, 1)
    assert.equal(decisions.filter((response) => response.status === 409).length, 2)
    assert.ok((await sql('registration-db', 'registration', `SELECT string_agg(COALESCE(note,''),'|') FROM registration.history WHERE registration_id='${fixtures.registration.id}'`)).includes('Needs more preparation'), 'Decision reason must be auditable')
    expect(await call('/api/admin/registrations', { token: fixtures.admin.token }), 200, 'admin registration monitoring')
  })
  await check('Registration database outage: bounded failure, retry and no duplicates', async () => {
    fixtures.recoveryTopic = await topic('Pending request recovery', 20)
    const requestId = randomUUID()
    await run(['stop', '-t', '2', 'registration-db'])
    try {
      assert.equal(await internalHealth('registration-service'), 200, 'Liveness survives DB outage')
      assert.equal(await internalHealth('registration-service', '/ready'), 503, 'Readiness reports disconnected DB')
      const response = await register(fixtures.students[0], fixtures.recoveryTopic, requestId)
      expect(response, 503, 'POST cannot claim success while DB is down')
      assert.ok(response.elapsed < 14000, 'Outage response must have bounded latency')
      expect(await call('/api/admin/departments', { token: fixtures.admin.token }), 200, 'Unrelated academic domain remains available')
      expect(await call(`/api/admin/rounds/${fixtures.round.id}`, { token: fixtures.admin.token, method: 'PATCH', body: { isOpen: false } }), 503, 'closing the round fails safely while Registration is down')
    } finally { await run(['start', 'registration-db']) }
    await waitReady()
    expect(await register(fixtures.students[0], fixtures.recoveryTopic, requestId), 201, 'queued request after recovery')
    expect(await register(fixtures.students[0], fixtures.recoveryTopic, requestId), 200, 'replayed queued request')
    assert.equal(await sql('registration-db', 'registration', `SELECT count(*) FROM registration.registrations WHERE id='${requestId}'`), '1')
    expect(await call(`/api/admin/rounds/${fixtures.round.id}`, { token: fixtures.admin.token, method: 'PATCH', body: { isOpen: false } }), 200, 'close round after recovery')
    expect(await register(fixtures.students[2], fixtures.recoveryTopic), 409, 'closed round rejects new registrations')
    expect(await call(`/api/admin/rounds/${fixtures.round.id}`, { token: fixtures.admin.token, method: 'PATCH', body: { isOpen: true } }), 200, 'reopen round')
    expect(await register(fixtures.students[2], fixtures.recoveryTopic), 201, 'reopened round resumes admissions')
  })
  await check('Academic DB and service outages recover without restart of consumers', async () => {
    await run(['stop', '-t', '2', 'academic-db'])
    try {
      assert.equal(await internalHealth('academic-service'), 200)
      assert.equal(await internalHealth('academic-service', '/ready'), 503)
      expect(await call('/api/admin/departments', { token: fixtures.admin.token }), 503, 'academic DB unavailable')
      expect(await call('/api/portal/profile', { token: fixtures.students[0].token }), 200, 'identity domain independent')
    } finally { await run(['start', 'academic-db']) }
    await waitReady()
    await run(['stop', '-t', '2', 'academic-service'])
    try { expect(await call('/api/portal/overview', { token: fixtures.students[0].token }), 503, 'dependency service unavailable') }
    finally { await run(['start', 'academic-service']) }
    await waitReady()
    expect(await call('/api/portal/overview', { token: fixtures.students[0].token }), 200, 'consumer reconnects')
  })
  await check('Identity database outage fails closed and reconnects', async () => {
    await run(['stop', '-t', '2', 'identity-db'])
    try {
      assert.equal(await internalHealth('identity-service'), 200)
      assert.equal(await internalHealth('identity-service', '/ready'), 503)
      expect(await call('/api/auth/login', { method: 'POST', body: { username: fixtures.winner.username, password } }), 503, 'login during DB outage')
      expect(await call('/api/admin/accounts', { token: fixtures.admin.token }), 503, 'do not authorize with stale identity')
    } finally { await run(['start', 'identity-db']) }
    await waitReady()
    await login(fixtures.winner.username, password)
  })
  if (process.argv.includes('--browser')) await check('Browser roles, mobile layout, cached topics and local pending replay', async () => {
    const { browserSmoke } = await import('./browser-smoke.mjs')
    await browserSmoke({ base, fixtures, password, run, waitReady, call, root })
  })
  await check('Lock, unlock, reset password and old session revocation', async () => {
    const student = fixtures.students[10]
    expect(await call(`/api/admin/accounts/${student.id}/status`, { token: fixtures.admin.token, method: 'PATCH', body: { status: 'BI_KHOA' } }), 200, 'lock student')
    assert.ok([401, 403].includes((await call('/api/portal/overview', { token: student.token })).status))
    expect(await call('/api/auth/login', { method: 'POST', body: { username: student.username, password } }), 401, 'locked account cannot log in')
    expect(await call(`/api/admin/accounts/${student.id}/status`, { token: fixtures.admin.token, method: 'PATCH', body: { status: 'HOAT_DONG' } }), 200, 'unlock student')
    const reset = expect(await call(`/api/admin/accounts/${student.id}/reset-password`, { token: fixtures.admin.token, method: 'POST' }), 200, 'reset password')
    assert.ok(reset.temporaryPassword?.length >= 12)
    expect(await call('/api/portal/overview', { token: student.token }), 401, 'old session remains revoked')
    await login(student.username, reset.temporaryPassword)
  })
  await check('TOTP setup, MFA challenge, one-use recovery and removal', async () => {
    const student = fixtures.students[9]
    const setup = expect(await call('/api/portal/security/totp/setup', { token: student.token, method: 'POST', body: { currentPassword: password } }), 200, 'begin TOTP setup')
    assert.match(setup.secret, /^[A-Z2-7]+$/)
    const confirmed = expect(await call('/api/portal/security/totp/confirm', { token: student.token, method: 'POST', body: { code: totpCode(setup.secret) } }), 200, 'confirm TOTP')
    assert.equal(confirmed.recoveryCodes.length, 10)
    const challenged = expect(await call('/api/auth/login', { method: 'POST', body: { username: student.username, password } }), 200, 'login requires MFA')
    assert.equal(challenged.mfaRequired, true)
    expect(await call('/api/portal/overview', { token: challenged.mfaToken }), 401, 'MFA challenge cannot access portal')
    const verified = expect(await call('/api/auth/mfa/totp', { method: 'POST', token: challenged.mfaToken, body: { code: totpCode(setup.secret) } }), 200, 'TOTP verification')
    expect(await call('/api/portal/profile', { token: verified.token }), 200, 'verified session may access portal')
    const recoveryChallenge = expect(await call('/api/auth/login', { method: 'POST', body: { username: student.username, password } }), 200, 'second MFA challenge')
    expect(await call('/api/auth/mfa/totp', { method: 'POST', token: recoveryChallenge.mfaToken, body: { code: confirmed.recoveryCodes[0] } }), 200, 'recovery code works once')
    expect(await call('/api/auth/mfa/totp', { method: 'POST', token: recoveryChallenge.mfaToken, body: { code: confirmed.recoveryCodes[0] } }), 401, 'recovery code cannot be reused')
    const invalidCodes = []
    for (let attempt = 0; attempt < 6; attempt++) invalidCodes.push(await call('/api/auth/mfa/totp', { method: 'POST', token: recoveryChallenge.mfaToken, body: { code: 'invalid' } }))
    assert.equal(invalidCodes.filter((response) => response.status === 401).length, 5, 'MFA rejects wrong codes')
    assert.equal(invalidCodes.at(-1).status, 429, 'MFA attempts are throttled')
    expect(await call('/api/portal/security/totp/disable', { token: verified.token, method: 'POST', body: { currentPassword: password, code: totpCode(setup.secret) } }), 200, 'disable TOTP')
    const after = expect(await call('/api/auth/login', { method: 'POST', body: { username: student.username, password } }), 200, 'login after removing TOTP')
    assert.equal(after.mfaRequired, undefined)
  })
  await check('Service restart preserves data and migrations are repeatable', async () => {
    const before = await sql('registration-db', 'registration', 'SELECT count(*) FROM registration.registrations')
    await run(['restart', 'identity-service', 'academic-service', 'registration-service', 'api-gateway', 'web'])
    await waitReady()
    expect(await call('/api/admin/overview', { token: fixtures.admin.token }), 200, 'admin session and data survive service restart')
    assert.equal(await sql('registration-db', 'registration', 'SELECT count(*) FROM registration.registrations'), before, 'registration volume persists')
    assert.equal(await sql('identity-db', 'identity', "SELECT count(*) FROM information_schema.columns WHERE table_schema='identity' AND table_name='users' AND column_name='token_version'"), '1', 'identity migration remains applied')
  })
  await check('Security headers, login throttling and service isolation', async () => {
    const page = await fetch(`${base}/`)
    assert.ok(page.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"), 'CSP blocks framing')
    assert.equal(page.headers.get('x-frame-options'), 'DENY')
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(page.headers.get('cache-control'), 'no-store')
    const preflight = await fetch(`${base}/api/auth/login`, { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } })
    assert.equal(preflight.headers.get('access-control-allow-origin'), null, 'No wildcard CORS')
    const uid = (await run(['exec', '-T', 'identity-service', 'id', '-u'])).trim()
    assert.notEqual(uid, '0', 'Identity must run without root privileges')
    const impersonation = await run(['exec', '-T', 'api-gateway', 'node', '--input-type=module', '-'], `import jwt from 'jsonwebtoken'; const key=Buffer.from(process.env.INTERNAL_PRIVATE_KEY,'base64').toString('utf8'); const token=jwt.sign({service:'academic',purpose:'service-call'},key,{audience:'qldetai-services',expiresIn:'1m',algorithm:'RS256'}); const response=await fetch('http://registration-service:3103/internal/v1/registrations/admission/rounds/00000000-0000-4000-8000-000000000001',{method:'POST',headers:{'x-service-token':token,'content-type':'application/json'},body:'{"closed":false}'}); console.log(response.status)`)
    assert.equal(impersonation.trim(), '401', 'Gateway cannot impersonate Academic')
    const forged = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: fixtures.admin.id, role: 'QUAN_TRI' })).toString('base64url')}.`
    expect(await call('/api/admin/overview', { token: forged }), 401, 'unsigned JWT is rejected')
    const tampered = `${fixtures.admin.token.slice(0, -4)}AAAA`
    expect(await call('/api/admin/overview', { token: tampered }), 401, 'tampered JWT is rejected')
    expect(await call('/api/auth/login', { method: 'POST', body: { username: "' OR 1=1 --", password: 'irrelevant' } }), 401, 'SQL injection is not interpreted as a query')
    const wrong = []
    for (let attempt = 0; attempt < 9; attempt++) {
      const response = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Real-IP': `198.51.100.${attempt + 1}` }, body: JSON.stringify({ username: 'security-probe', password: 'wrong-password' }) })
      wrong.push(response.status)
      if (attempt === 8) assert.ok(Number(response.headers.get('retry-after')) > 0, 'Throttling tells the client when to retry')
    }
    assert.equal(wrong.filter((status) => status === 429).length, 1, 'Forged client IP does not bypass throttling')
    assert.equal(wrong.filter((status) => status === 401).length, 8)
    const recheck = []
    for (let attempt = 0; attempt < 9; attempt++) recheck.push(await call('/api/portal/security/totp/setup', { token: fixtures.students[11].token, method: 'POST', body: { currentPassword: 'wrong-password' } }))
    assert.equal(recheck.filter((response) => response.status === 403).length, 8, 'Password recheck rejects wrong values')
    assert.equal(recheck.at(-1).status, 429, 'Password recheck attempts are throttled')
  })
} catch (error) {
  failed = true
  console.error(error.message)
} finally {
  if (!process.argv.includes('--keep')) {
    // Safety guard: only the random test project can ever be removed.
    assert.match(project, /^qldetai-verify-[0-9a-f]{10}$/)
    await run(['down', '--volumes', '--remove-orphans']).catch((error) => { failed = true; console.error(error.message) })
  }
  await mkdir(path.join(root, 'test-results'), { recursive: true })
  await writeFile(path.join(root, 'test-results', 'soa-faults.json'), JSON.stringify({ project, timestamp: new Date().toISOString(), passed: !failed, results }, null, 2))
  console.log(`${results.filter((item) => item.passed).length}/${results.length} checks passed; report: test-results/soa-faults.json`)
}
process.exitCode = failed ? 1 : 0
