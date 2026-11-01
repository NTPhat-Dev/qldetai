import { createApp } from '../../shared/create-app.js'
import { createDatabasePool } from '../../shared/database.js'
import bcrypt from 'bcryptjs'
import argon2 from 'argon2'
import jwt from 'jsonwebtoken'
import * as OTPAuth from 'otpauth'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'

const pool = createDatabasePool('identity')
const app = createApp({ name: 'identity', pool })
const jwtSecret = process.env.JWT_SECRET
const webauthnRPID = process.env.WEBAUTHN_RP_ID || 'localhost'
const webauthnOrigin = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173'
const hashPassword = (password) => argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32, salt: randomBytes(16) })
const verifyPassword = async (password, hash) => hash?.startsWith('$argon2id$')
  ? { valid: await argon2.verify(hash, password), needsUpgrade: false }
  : { valid: await bcrypt.compare(password, hash ?? ''), needsUpgrade: true }
const signToken = (user, overrides = {}) => jwt.sign({ sub: user.id, role: user.role, mustChangePassword: user.must_change_password, ...overrides }, jwtSecret, { expiresIn: '8h' })
const encryptionKey = () => createHash('sha256').update(process.env.TOTP_ENCRYPTION_KEY || `${jwtSecret}:qldetai-totp-v1`).digest()
function encryptSecret(secret) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv)
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}
function decryptSecret(value) {
  const data = Buffer.from(value)
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
}
const checkTotp = (secret, token) => new OTPAuth.TOTP({ issuer: 'QL Đề Tài', label: 'Tài khoản', algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).validate({ token, window: 1 }) !== null

function verifyBearer(ctx, { allowPending = false } = {}) {
  try {
    const token = ctx.get('authorization').replace(/^Bearer\s+/i, '')
    const claims = jwt.verify(token, jwtSecret)
    if (!allowPending && claims.mfaPending) throw new Error('pending')
    return claims
  } catch { ctx.throw(401, 'Phiên đăng nhập hết hạn hoặc không hợp lệ.') }
}

app.use(async (ctx, next) => {
  if (ctx.method === 'POST' && ctx.path === '/api/auth/login') {
    const { username, password } = ctx.request.body ?? {}
    if (!username || !password) ctx.throw(400, 'Vui lòng nhập tên đăng nhập và mật khẩu.')
    const result = await pool.query('SELECT id,username,password_hash,role,status,must_change_password,display_name FROM identity.users WHERE username=lower(btrim($1)) LIMIT 1', [username])
    const user = result.rows[0]
    let checked = { valid: false, needsUpgrade: false }
    try { if (user?.password_hash) checked = await verifyPassword(password, user.password_hash) } catch { checked = { valid: false, needsUpgrade: false } }
    if (!user || user.status !== 'HOAT_DONG' || !checked.valid) ctx.throw(401, 'Tên đăng nhập hoặc mật khẩu không đúng.')
    if (checked.needsUpgrade) await pool.query('UPDATE identity.users SET password_hash=$1,updated_at=now() WHERE id=$2', [await hashPassword(password), user.id])
    const factors = await pool.query('SELECT EXISTS(SELECT 1 FROM identity.totp_factors WHERE user_id=$1 AND confirmed_at IS NOT NULL) AS totp, EXISTS(SELECT 1 FROM identity.passkeys WHERE user_id=$1) AS passkey', [user.id])
    if (factors.rows[0].totp || factors.rows[0].passkey) {
      ctx.body = { mfaRequired: true, role: user.role, methods: factors.rows[0], mfaToken: jwt.sign({ sub: user.id, role: user.role, mustChangePassword: user.must_change_password, mfaPending: true }, jwtSecret, { expiresIn: '5m' }) }
    } else ctx.body = { token: signToken(user), role: user.role, mustChangePassword: user.must_change_password, user: { id: user.id, name: user.display_name, username: user.username } }
    return
  }
  if (ctx.path.startsWith('/api/auth/')) {
    if (ctx.method === 'POST' && ctx.path === '/api/auth/change-password') {
      const claims = verifyBearer(ctx)
      const { currentPassword, newPassword } = ctx.request.body ?? {}
      if (!newPassword || newPassword.length < 12) ctx.throw(400, 'Mật khẩu mới phải có ít nhất 12 ký tự.')
      const result = await pool.query('SELECT password_hash,must_change_password FROM identity.users WHERE id=$1', [claims.sub])
      if (!result.rowCount) ctx.throw(401, 'Tài khoản không còn tồn tại.')
      if (!claims.mustChangePassword || !result.rows[0].must_change_password) {
        if (!currentPassword) ctx.throw(400, 'Vui lòng nhập mật khẩu hiện tại.')
        const checked = result.rowCount ? await verifyPassword(currentPassword, result.rows[0].password_hash) : { valid: false }
        if (!checked.valid) ctx.throw(400, 'Mật khẩu hiện tại không chính xác.')
      }
      await pool.query('UPDATE identity.users SET password_hash=$1,must_change_password=false,updated_at=now() WHERE id=$2', [await hashPassword(newPassword), claims.sub])
      ctx.body = { token: jwt.sign({ sub: claims.sub, role: claims.role, mustChangePassword: false }, jwtSecret, { expiresIn: '8h' }) }
      return
    }
    if (ctx.method === 'POST' && ctx.path === '/api/auth/mfa/totp') {
      const claims = verifyBearer(ctx, { allowPending: true })
      if (!claims.mfaPending) ctx.throw(401, 'Phiên xác thực hai lớp đã hết hạn.')
      const { code } = ctx.request.body ?? {}
      const factor = await pool.query('SELECT encrypted_secret FROM identity.totp_factors WHERE user_id=$1 AND confirmed_at IS NOT NULL', [claims.sub])
      let valid = Boolean(factor.rowCount && /^\d{6}$/.test(String(code ?? '')) && checkTotp(decryptSecret(factor.rows[0].encrypted_secret), String(code)))
      if (!valid && code) {
        const hash = createHash('sha256').update(String(code).trim().toUpperCase()).digest()
        valid = Boolean((await pool.query('UPDATE identity.recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id', [claims.sub, hash])).rowCount)
      }
      if (!valid) ctx.throw(401, 'Mã xác thực không đúng hoặc đã được sử dụng.')
      const user = await pool.query("SELECT id,role,must_change_password FROM identity.users WHERE id=$1 AND status='HOAT_DONG'", [claims.sub])
      if (!user.rowCount) ctx.throw(401, 'Tài khoản không còn hoạt động.')
      ctx.body = { token: signToken(user.rows[0]), role: user.rows[0].role, mustChangePassword: user.rows[0].must_change_password }
      return
    }
    if (ctx.method === 'POST' && ctx.path === '/api/auth/mfa/passkey/options') {
      const claims = verifyBearer(ctx, { allowPending: true })
      if (!claims.mfaPending) ctx.throw(401, 'Phiên xác thực hai lớp đã hết hạn.')
      const passkeys = await pool.query('SELECT credential_id,transports FROM identity.passkeys WHERE user_id=$1', [claims.sub])
      if (!passkeys.rowCount) ctx.throw(400, 'Tài khoản chưa đăng ký Passkey.')
      const options = await generateAuthenticationOptions({ rpID: webauthnRPID, userVerification: 'required', allowCredentials: passkeys.rows.map((item) => ({ id: Buffer.from(item.credential_id).toString('utf8'), transports: item.transports })) })
      ctx.body = { options, challengeToken: jwt.sign({ sub: claims.sub, role: claims.role, mustChangePassword: claims.mustChangePassword, mfaPending: true, webauthnChallenge: options.challenge, purpose: 'mfa-passkey' }, jwtSecret, { expiresIn: '5m' }) }
      return
    }
    if (ctx.method === 'POST' && ctx.path === '/api/auth/mfa/passkey/verify') {
      const { challengeToken, response } = ctx.request.body ?? {}
      let claims
      try { claims = jwt.verify(challengeToken, jwtSecret); if (!claims.mfaPending || claims.purpose !== 'mfa-passkey' || !claims.webauthnChallenge) throw new Error('invalid') } catch { ctx.throw(401, 'Phiên Passkey đã hết hạn.') }
      const passkey = await pool.query('SELECT id,credential_id,public_key,sign_count,transports FROM identity.passkeys WHERE user_id=$1 AND credential_id=$2', [claims.sub, Buffer.from(String(response?.id ?? ''), 'utf8')])
      if (!passkey.rowCount) ctx.throw(401, 'Không nhận diện được Passkey.')
      let verification
      try { verification = await verifyAuthenticationResponse({ response, expectedChallenge: claims.webauthnChallenge, expectedOrigin: webauthnOrigin, expectedRPID: webauthnRPID, requireUserVerification: true, credential: { id: Buffer.from(passkey.rows[0].credential_id).toString('utf8'), publicKey: new Uint8Array(passkey.rows[0].public_key), counter: Number(passkey.rows[0].sign_count), transports: passkey.rows[0].transports } }) } catch { ctx.throw(401, 'Xác thực Passkey thất bại.') }
      if (!verification?.verified) ctx.throw(401, 'Xác thực Passkey thất bại.')
      await pool.query('UPDATE identity.passkeys SET sign_count=$1,last_used_at=now() WHERE id=$2', [verification.authenticationInfo.newCounter, passkey.rows[0].id])
      const user = await pool.query("SELECT id,role,must_change_password FROM identity.users WHERE id=$1 AND status='HOAT_DONG'", [claims.sub])
      if (!user.rowCount) ctx.throw(401, 'Tài khoản không còn hoạt động.')
      ctx.body = { token: signToken(user.rows[0]), role: user.rows[0].role, mustChangePassword: user.rows[0].must_change_password }
      return
    }
  }

  if (ctx.path.startsWith('/api/portal/') || ctx.path.startsWith('/api/admin/accounts')) {
    const claims = verifyBearer(ctx)
    if (ctx.path.startsWith('/api/admin/') && (claims.role !== 'QUAN_TRI' || claims.mustChangePassword)) ctx.throw(403, 'Bạn không có quyền thực hiện thao tác này.')
    if (ctx.path.startsWith('/api/portal/') && !['SINH_VIEN', 'GIANG_VIEN'].includes(claims.role)) ctx.throw(403, 'Bạn không có quyền truy cập cổng này.')
    ctx.state.identity = claims
  }

  if (ctx.method === 'GET' && ctx.path === '/api/portal/profile') {
    const result = await pool.query('SELECT role,profile_code AS code,display_name AS name,phone,class_name AS class,department_id,academic_title,degree,specialization FROM identity.users WHERE id=$1', [ctx.state.identity.sub])
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy hồ sơ cá nhân.')
    const user = result.rows[0]
    const department = user.department_id ? await fetch('http://academic-service:3102/internal/v1/academic/departments').then((response) => response.json()).catch(() => []) : []
    ctx.body = { role: user.role, profile: {
      role: user.role, code: user.code, name: user.name, phone: user.phone, class: user.class,
      department: department.find((item) => item.id === user.department_id)?.name ?? null,
      ...(user.role === 'GIANG_VIEN' ? { academic_title: user.academic_title, degree: user.degree, specialization: user.specialization } : {}),
    } }
    return
  }
  if (ctx.method === 'PATCH' && ctx.path === '/api/portal/profile') {
    const { phone, academicTitle, degree, specialization } = ctx.request.body ?? {}
    await pool.query(`UPDATE identity.users SET phone=NULLIF(btrim($1),''),
      academic_title=CASE WHEN role='GIANG_VIEN' THEN NULLIF(btrim($2),'') ELSE academic_title END,
      degree=CASE WHEN role='GIANG_VIEN' THEN NULLIF(btrim($3),'') ELSE degree END,
      specialization=CASE WHEN role='GIANG_VIEN' THEN NULLIF(btrim($4),'') ELSE specialization END,
      updated_at=now() WHERE id=$5`, [phone ?? '', academicTitle ?? '', degree ?? '', specialization ?? '', ctx.state.identity.sub])
    ctx.body = { saved: true }
    return
  }

  if (ctx.method === 'GET' && ctx.path === '/api/portal/security') {
    const [totp, passkeys, recovery] = await Promise.all([
      pool.query('SELECT confirmed_at IS NOT NULL AS enabled FROM identity.totp_factors WHERE user_id=$1', [ctx.state.identity.sub]),
      pool.query('SELECT id,label,created_at,last_used_at AS last_used FROM identity.passkeys WHERE user_id=$1 ORDER BY created_at', [ctx.state.identity.sub]),
      pool.query('SELECT count(*)::int AS remaining FROM identity.recovery_codes WHERE user_id=$1 AND used_at IS NULL', [ctx.state.identity.sub]),
    ])
    ctx.body = { totpEnabled: Boolean(totp.rows[0]?.enabled), passkeys: passkeys.rows, recoveryCodesRemaining: recovery.rows[0].remaining }
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/security/totp/setup') {
    const { currentPassword } = ctx.request.body ?? {}
    const result = await pool.query('SELECT username,password_hash FROM identity.users WHERE id=$1', [ctx.state.identity.sub])
    if (!result.rowCount || !(await verifyPassword(currentPassword ?? '', result.rows[0].password_hash)).valid) ctx.throw(403, 'Nhập đúng mật khẩu hiện tại để bật Google Authenticator.')
    const existing = await pool.query('SELECT confirmed_at FROM identity.totp_factors WHERE user_id=$1', [ctx.state.identity.sub])
    if (existing.rows[0]?.confirmed_at) ctx.throw(409, 'Google Authenticator đã được bật.')
    const secret = new OTPAuth.Secret({ size: 20 }).base32
    const totp = new OTPAuth.TOTP({ issuer: 'QL Đề Tài', label: result.rows[0].username, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) })
    await pool.query(`INSERT INTO identity.totp_factors(user_id,encrypted_secret,encryption_version,confirmed_at) VALUES($1,$2,'AES-256-GCM-v1',NULL)
      ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret,encryption_version=EXCLUDED.encryption_version,confirmed_at=NULL,created_at=now()`, [ctx.state.identity.sub, encryptSecret(secret)])
    ctx.body = { secret, otpauthUrl: totp.toString() }
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/security/totp/confirm') {
    const { code } = ctx.request.body ?? {}
    const pending = await pool.query('SELECT encrypted_secret FROM identity.totp_factors WHERE user_id=$1 AND confirmed_at IS NULL', [ctx.state.identity.sub])
    if (!pending.rowCount || !checkTotp(decryptSecret(pending.rows[0].encrypted_secret), String(code ?? ''))) ctx.throw(400, 'Mã Google Authenticator không đúng.')
    const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(6).toString('hex').toUpperCase())
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('UPDATE identity.totp_factors SET confirmed_at=now() WHERE user_id=$1 AND confirmed_at IS NULL', [ctx.state.identity.sub])
      await client.query('DELETE FROM identity.recovery_codes WHERE user_id=$1', [ctx.state.identity.sub])
      for (const recoveryCode of recoveryCodes) await client.query('INSERT INTO identity.recovery_codes(user_id,code_hash) VALUES($1,$2)', [ctx.state.identity.sub, createHash('sha256').update(recoveryCode).digest()])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    ctx.body = { enabled: true, recoveryCodes }
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/security/totp/disable') {
    const { currentPassword, code } = ctx.request.body ?? {}
    const user = await pool.query('SELECT password_hash FROM identity.users WHERE id=$1', [ctx.state.identity.sub])
    if (!user.rowCount || !(await verifyPassword(currentPassword ?? '', user.rows[0].password_hash)).valid) ctx.throw(403, 'Mật khẩu hiện tại không đúng.')
    const factor = await pool.query('SELECT encrypted_secret FROM identity.totp_factors WHERE user_id=$1 AND confirmed_at IS NOT NULL', [ctx.state.identity.sub])
    if (!factor.rowCount || !checkTotp(decryptSecret(factor.rows[0].encrypted_secret), String(code ?? ''))) ctx.throw(400, 'Mã Google Authenticator không đúng.')
    await pool.query('DELETE FROM identity.totp_factors WHERE user_id=$1', [ctx.state.identity.sub])
    await pool.query('DELETE FROM identity.recovery_codes WHERE user_id=$1', [ctx.state.identity.sub])
    ctx.body = { enabled: false }
    return
  }

  if (ctx.method === 'POST' && ctx.path === '/api/portal/security/passkeys/options') {
    const { currentPassword } = ctx.request.body ?? {}
    const user = await pool.query('SELECT username,display_name,password_hash FROM identity.users WHERE id=$1', [ctx.state.identity.sub])
    if (!user.rowCount || !(await verifyPassword(currentPassword ?? '', user.rows[0].password_hash)).valid) ctx.throw(403, 'Nhập đúng mật khẩu hiện tại để thêm Passkey.')
    const known = await pool.query('SELECT credential_id,transports FROM identity.passkeys WHERE user_id=$1', [ctx.state.identity.sub])
    const options = await generateRegistrationOptions({ rpName: 'QL Đề Tài', rpID: webauthnRPID, userName: user.rows[0].username, userDisplayName: user.rows[0].display_name, userID: new Uint8Array(Buffer.from(ctx.state.identity.sub.replaceAll('-', ''), 'hex')), attestationType: 'none', excludeCredentials: known.rows.map((item) => ({ id: Buffer.from(item.credential_id).toString('utf8'), transports: item.transports })), authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } })
    ctx.body = { options, challengeToken: jwt.sign({ sub: ctx.state.identity.sub, challenge: options.challenge, purpose: 'passkey-register' }, jwtSecret, { expiresIn: '5m' }) }
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/security/passkeys/verify') {
    const { challengeToken, response, label } = ctx.request.body ?? {}
    let challenge
    try { challenge = jwt.verify(challengeToken, jwtSecret); if (challenge.sub !== ctx.state.identity.sub || challenge.purpose !== 'passkey-register') throw new Error('invalid') } catch { ctx.throw(401, 'Phiên đăng ký Passkey đã hết hạn.') }
    let verification
    try { verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: webauthnOrigin, expectedRPID: webauthnRPID, requireUserVerification: true }) } catch { ctx.throw(400, 'Không xác minh được Passkey.') }
    if (!verification?.verified || !verification.registrationInfo) ctx.throw(400, 'Đăng ký Passkey thất bại.')
    const credential = verification.registrationInfo.credential
    try { await pool.query('INSERT INTO identity.passkeys(user_id,credential_id,public_key,sign_count,transports,label) VALUES($1,$2,$3,$4,$5,$6)', [ctx.state.identity.sub, Buffer.from(credential.id, 'utf8'), Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], String(label ?? 'Passkey').slice(0, 80)]) }
    catch (error) { if (error.code === '23505') ctx.throw(409, 'Passkey này đã được thêm.'); throw error }
    ctx.body = { saved: true }
    return
  }
  const passkeyDelete = ctx.path.match(/^\/api\/portal\/security\/passkeys\/([^/]+)$/)
  if (passkeyDelete && ctx.method === 'DELETE') {
    const { currentPassword } = ctx.request.body ?? {}
    const user = await pool.query('SELECT password_hash FROM identity.users WHERE id=$1', [ctx.state.identity.sub])
    if (!user.rowCount || !(await verifyPassword(currentPassword ?? '', user.rows[0].password_hash)).valid) ctx.throw(403, 'Mật khẩu hiện tại không đúng.')
    await pool.query('DELETE FROM identity.passkeys WHERE id=$1 AND user_id=$2', [passkeyDelete[1], ctx.state.identity.sub])
    ctx.body = { deleted: true }
    return
  }

  if (ctx.method === 'GET' && ctx.path === '/api/admin/accounts') {
    const result = await pool.query('SELECT id,username,role,status,created_at,display_name AS name,profile_code,department_id FROM identity.users ORDER BY created_at DESC LIMIT 100')
    const departments = await fetch('http://academic-service:3102/internal/v1/academic/departments').then((response) => response.json()).catch(() => [])
    ctx.body = result.rows.map((user) => ({ ...user, department: departments.find((item) => item.id === user.department_id)?.name ?? null }))
    return
  }
  const internalUser = ctx.path.match(/^\/internal\/v1\/identity\/users\/([0-9a-f-]+)$/i)
  if (ctx.method === 'GET' && internalUser) {
    const result = await pool.query('SELECT id,username,role,status,display_name,profile_code,department_id,class_name,phone,academic_title,degree,specialization FROM identity.users WHERE id=$1', [internalUser[1]])
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy tài khoản.')
    ctx.body = result.rows[0]
    return
  }
  if (ctx.method === 'GET' && ctx.path === '/internal/v1/identity/overview') {
    const result = await pool.query("SELECT count(*) FILTER (WHERE role='SINH_VIEN')::int AS students,count(*) FILTER (WHERE role='GIANG_VIEN')::int AS lecturers FROM identity.users")
    ctx.body = result.rows[0]
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/admin/accounts') {
    const { role, name, departmentId, classId, phone, academicTitle, degree, specialization } = ctx.request.body ?? {}
    if (!name?.trim()) ctx.throw(400, 'Điền đầy đủ thông tin tài khoản và hồ sơ.')
    if (!['SINH_VIEN', 'GIANG_VIEN'].includes(role)) ctx.throw(400, 'Vai trò cấp mới không hợp lệ.')
    if (!departmentId) ctx.throw(400, 'Chọn khoa cho tài khoản.')
    const departments = await fetch('http://academic-service:3102/internal/v1/academic/departments').then((response) => response.json())
    if (!departments.some((item) => item.id === departmentId)) ctx.throw(400, 'Khoa đã chọn không tồn tại.')
    let className = null
    if (role === 'SINH_VIEN') {
      if (!classId) ctx.throw(400, 'Chọn lớp cho sinh viên.')
      const classes = await fetch(`http://academic-service:3102/internal/v1/academic/departments/${departmentId}/classes`).then((response) => response.json())
      className = classes.find((item) => item.id === classId)?.name
      if (!className) ctx.throw(400, 'Lớp không thuộc khoa đã chọn.')
    }
    const profileCode = `${role === 'SINH_VIEN' ? 'SV' : 'GV'}${randomInt(0, 100_000_000).toString().padStart(8, '0')}`
    const username = profileCode.toLowerCase()
    const temporaryPassword = randomBytes(12).toString('base64url')
    const result = await pool.query(`INSERT INTO identity.users(username,password_hash,role,status,must_change_password,display_name,profile_code,department_id,phone,academic_title,degree,specialization,class_name)
      VALUES($1,$2,$3,'HOAT_DONG',true,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`, [username, await hashPassword(temporaryPassword), role, name.trim(), profileCode, departmentId, phone?.trim() || null, academicTitle?.trim() || null, degree?.trim() || null, specialization?.trim() || null, className])
    ctx.status = 201
    ctx.body = { id: result.rows[0].id, username, role, profileCode, temporaryPassword }
    return
  }
  await next()
})

app.use(async (ctx) => {
  const userMatch = ctx.path.match(/^\/internal\/v1\/identity\/users\/([0-9a-f-]+)$/i)
  if (ctx.method === 'GET' && userMatch) {
    const result = await pool.query(
      'SELECT id, username, role, status, display_name, profile_code FROM identity.users WHERE id=$1',
      [userMatch[1]],
    )
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy tài khoản.')
    ctx.body = result.rows[0]
    return
  }
  ctx.status = 404
  ctx.body = { error: 'Not found' }
})

const port = Number(process.env.PORT) || 3101
const server = app.listen(port, () => console.log(`Identity service listening on ${port}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => void pool.end()))
