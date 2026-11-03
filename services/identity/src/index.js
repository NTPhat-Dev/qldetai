import { createApp } from '../../shared/create-app.js'
import { createDatabasePool } from '../../shared/database.js'
import { createServiceFetch } from '../../shared/service-client.js'
import { migrate } from '../../shared/migrations.js'
import bcrypt from 'bcryptjs'
import argon2 from 'argon2'
import jwt from 'jsonwebtoken'
import * as OTPAuth from 'otpauth'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'

const pool = createDatabasePool('identity')
await migrate(pool, 'identity')
const fetch = createServiceFetch('identity')
const app = createApp({ name: 'identity', pool })
const identityPrivateKey = Buffer.from(process.env.INTERNAL_PRIVATE_KEY ?? '', 'base64').toString('utf8')
const identityPublicKey = Buffer.from(process.env.INTERNAL_PUBLIC_IDENTITY ?? '', 'base64').toString('utf8')
const webauthnRPID = process.env.WEBAUTHN_RP_ID || 'localhost'
const webauthnOrigin = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173'
const hashPassword = (password) => argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32, salt: randomBytes(16) })
const dummyPasswordHash = await hashPassword(randomBytes(24).toString('base64url'))
const verifyPassword = async (password, hash) => hash?.startsWith('$argon2id$')
  ? { valid: await argon2.verify(hash, password), needsUpgrade: false }
  : { valid: await bcrypt.compare(password, hash ?? ''), needsUpgrade: true }
const signToken = (user, overrides = {}) => jwt.sign({ sub: user.id, role: user.role, mustChangePassword: user.must_change_password, tokenVersion: user.token_version ?? 0, ...overrides }, identityPrivateKey, { expiresIn: '8h', algorithm: 'RS256' })
const encryptionKey = () => createHash('sha256').update(process.env.TOTP_ENCRYPTION_KEY).digest()
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
const clientIp = (ctx) => {
  const forwarded = ctx.get('x-real-ip')
  return /^[0-9a-f:.]{3,45}$/i.test(forwarded) ? forwarded : ctx.ip
}
const bucket = (kind, value) => createHash('sha256').update(`${kind}\0${value}`).digest('hex')
async function reserveAttempt(ctx, kind, subject, limit) {
  const key = bucket(kind, subject)
  const result = await pool.query(`INSERT INTO identity.auth_rate_limits(bucket,attempts,window_started_at)
    VALUES($1,1,clock_timestamp()) ON CONFLICT(bucket) DO UPDATE SET
    attempts=CASE WHEN identity.auth_rate_limits.window_started_at < clock_timestamp()-interval '5 minutes'
      THEN 1 ELSE identity.auth_rate_limits.attempts+1 END,
    window_started_at=CASE WHEN identity.auth_rate_limits.window_started_at < clock_timestamp()-interval '5 minutes'
      THEN clock_timestamp() ELSE identity.auth_rate_limits.window_started_at END
    RETURNING attempts, GREATEST(1,CEIL(EXTRACT(EPOCH FROM (window_started_at+interval '5 minutes'-clock_timestamp()))))::integer AS retry_after`, [key])
  if (result.rows[0].attempts > limit) {
    ctx.set('Retry-After', String(result.rows[0].retry_after))
    ctx.throw(429, 'Đã thử quá nhiều lần. Vui lòng chờ rồi thử lại.')
  }
  return key
}
const clearAttempt = (key) => pool.query('DELETE FROM identity.auth_rate_limits WHERE bucket=$1', [key])
async function requireCurrentPassword(ctx, userId, password, errorMessage) {
  const key = await reserveAttempt(ctx, 'password-recheck', `${userId}:${clientIp(ctx)}`, 8)
  const result = await pool.query('SELECT username,display_name,password_hash FROM identity.users WHERE id=$1', [userId])
  let valid = false
  try { valid = Boolean(result.rowCount && (await verifyPassword(password ?? '', result.rows[0].password_hash)).valid) } catch {}
  if (!valid) ctx.throw(403, errorMessage)
  await clearAttempt(key)
  return result.rows[0]
}
await pool.query("DELETE FROM identity.auth_rate_limits WHERE window_started_at < clock_timestamp()-interval '1 day'")

async function verifyBearer(ctx, { allowPending = false } = {}) {
  let claims
  try {
    claims = jwt.verify(ctx.get('authorization').replace(/^Bearer\s+/i, ''), identityPublicKey, { algorithms: ['RS256'] })
    if ((!allowPending && claims.mfaPending) || claims.purpose || typeof claims.sub !== 'string') throw new Error('pending')
  } catch { ctx.throw(401, 'Phiên đăng nhập hết hạn hoặc không hợp lệ.') }
  const current = await pool.query('SELECT role,status,must_change_password,token_version FROM identity.users WHERE id=$1', [claims.sub])
  const user = current.rows[0]
  if (!user || user.status !== 'HOAT_DONG' || user.role !== claims.role || (claims.tokenVersion ?? 0) !== user.token_version) ctx.throw(401, 'Phiên đăng nhập đã bị thu hồi.')
  return claims
}

app.use(async (ctx, next) => {
  if (ctx.method === 'POST' && ctx.path === '/api/auth/login') {
    const { username, password } = ctx.request.body ?? {}
    if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || !password || username.length>120 || password.length>1024) ctx.throw(400, 'Vui lòng nhập tên đăng nhập và mật khẩu.')
    await reserveAttempt(ctx, 'login-ip', clientIp(ctx), 100)
    const loginBucket = await reserveAttempt(ctx, 'login-account-ip', `${username.trim().toLowerCase()}:${clientIp(ctx)}`, 8)
    const result = await pool.query('SELECT id,username,password_hash,role,status,must_change_password,display_name,token_version FROM identity.users WHERE username=lower(btrim($1)) LIMIT 1', [username])
    const user = result.rows[0]
    let checked = { valid: false, needsUpgrade: false }
    try { checked = await verifyPassword(password, user?.password_hash ?? dummyPasswordHash) } catch { checked = { valid: false, needsUpgrade: false } }
    if (!user || user.status !== 'HOAT_DONG' || !checked.valid) ctx.throw(401, 'Sai tên đăng nhập hoặc mật khẩu.')
    await clearAttempt(loginBucket)
    if (checked.needsUpgrade) await pool.query('UPDATE identity.users SET password_hash=$1,updated_at=now() WHERE id=$2', [await hashPassword(password), user.id])
    const factors = await pool.query('SELECT EXISTS(SELECT 1 FROM identity.totp_factors WHERE user_id=$1 AND confirmed_at IS NOT NULL) AS totp, EXISTS(SELECT 1 FROM identity.passkeys WHERE user_id=$1) AS passkey', [user.id])
    if (factors.rows[0].totp || factors.rows[0].passkey) {
      ctx.body = { mfaRequired: true, role: user.role, methods: factors.rows[0], mfaToken: jwt.sign({ sub: user.id, role: user.role, mustChangePassword: user.must_change_password, tokenVersion: user.token_version, mfaPending: true }, identityPrivateKey, { expiresIn: '5m', algorithm: 'RS256' }) }
    } else ctx.body = { token: signToken(user), role: user.role, mustChangePassword: user.must_change_password, user: { id: user.id, name: user.display_name, username: user.username } }
    return
  }
  if (ctx.path.startsWith('/api/auth/')) {
    if (ctx.method === 'POST' && ctx.path === '/api/auth/change-password') {
      const claims = await verifyBearer(ctx)
      const { currentPassword, newPassword } = ctx.request.body ?? {}
      if (typeof newPassword !== 'string' || newPassword.length < 12 || newPassword.length > 256) ctx.throw(400, 'Mật khẩu mới phải có ít nhất 12 ký tự.')
      const result = await pool.query('SELECT password_hash,must_change_password FROM identity.users WHERE id=$1', [claims.sub])
      if (!result.rowCount) ctx.throw(401, 'Tài khoản không còn tồn tại.')
      if (!claims.mustChangePassword || !result.rows[0].must_change_password) {
        const passwordBucket = await reserveAttempt(ctx, 'password-change', `${claims.sub}:${clientIp(ctx)}`, 8)
        if (!currentPassword) ctx.throw(400, 'Vui lòng nhập mật khẩu hiện tại.')
        const checked = result.rowCount ? await verifyPassword(currentPassword, result.rows[0].password_hash) : { valid: false }
        if (!checked.valid) ctx.throw(400, 'Mật khẩu hiện tại không chính xác.')
        await clearAttempt(passwordBucket)
      }
      const updated = await pool.query(`WITH updated AS (UPDATE identity.users SET password_hash=$1,must_change_password=false,token_version=token_version+1,updated_at=now() WHERE id=$2 RETURNING *)
        , audit AS (INSERT INTO identity.security_events(user_id,actor_id,action) SELECT id,id,'PASSWORD_CHANGED' FROM updated)
        SELECT * FROM updated`, [await hashPassword(newPassword), claims.sub])
      ctx.body = { token: signToken(updated.rows[0]) }
      return
    }
    if (ctx.method === 'POST' && ctx.path === '/api/auth/mfa/totp') {
      const claims = await verifyBearer(ctx, { allowPending: true })
      if (!claims.mfaPending) ctx.throw(401, 'Phiên xác thực hai lớp đã hết hạn.')
      const mfaBucket = await reserveAttempt(ctx, 'mfa-totp', `${claims.sub}:${clientIp(ctx)}`, 6)
      const { code } = ctx.request.body ?? {}
      const factor = await pool.query('SELECT encrypted_secret FROM identity.totp_factors WHERE user_id=$1 AND confirmed_at IS NOT NULL', [claims.sub])
      let valid = Boolean(factor.rowCount && /^\d{6}$/.test(String(code ?? '')) && checkTotp(decryptSecret(factor.rows[0].encrypted_secret), String(code)))
      if (!valid && code) {
        const hash = createHash('sha256').update(String(code).trim().toUpperCase()).digest()
        valid = Boolean((await pool.query('UPDATE identity.recovery_codes SET used_at=now() WHERE user_id=$1 AND code_hash=$2 AND used_at IS NULL RETURNING id', [claims.sub, hash])).rowCount)
      }
      if (!valid) ctx.throw(401, 'Mã xác thực không đúng hoặc đã được sử dụng.')
      await clearAttempt(mfaBucket)
      const user = await pool.query("SELECT id,role,must_change_password,token_version FROM identity.users WHERE id=$1 AND status='HOAT_DONG'", [claims.sub])
      if (!user.rowCount || (claims.tokenVersion ?? 0) !== user.rows[0].token_version) ctx.throw(401, 'Tài khoản không còn hoạt động hoặc phiên đã bị thu hồi.')
      ctx.body = { token: signToken(user.rows[0]), role: user.rows[0].role, mustChangePassword: user.rows[0].must_change_password }
      return
    }
    if (ctx.method === 'POST' && ctx.path === '/api/auth/mfa/passkey/options') {
      const claims = await verifyBearer(ctx, { allowPending: true })
      if (!claims.mfaPending) ctx.throw(401, 'Phiên xác thực hai lớp đã hết hạn.')
      await reserveAttempt(ctx, 'mfa-passkey-options', `${claims.sub}:${clientIp(ctx)}`, 20)
      const passkeys = await pool.query('SELECT credential_id,transports FROM identity.passkeys WHERE user_id=$1', [claims.sub])
      if (!passkeys.rowCount) ctx.throw(400, 'Tài khoản chưa đăng ký Passkey.')
      // Keep older credentials usable until their owners replace them with a phone passkey.
      const phonePasskeys = passkeys.rows.filter((item) => item.transports?.includes('hybrid'))
      const eligiblePasskeys = phonePasskeys.length ? phonePasskeys : passkeys.rows
      const options = await generateAuthenticationOptions({ rpID: webauthnRPID, timeout: 120000, userVerification: 'required', allowCredentials: eligiblePasskeys.map((item) => ({ id: Buffer.from(item.credential_id).toString('utf8'), transports: item.transports })) })
      options.hints = ['hybrid']
      ctx.body = { options, challengeToken: jwt.sign({ sub: claims.sub, role: claims.role, mustChangePassword: claims.mustChangePassword, tokenVersion: claims.tokenVersion, mfaPending: true, webauthnChallenge: options.challenge, purpose: 'mfa-passkey' }, identityPrivateKey, { expiresIn: '5m', algorithm: 'RS256' }) }
      return
    }
    if (ctx.method === 'POST' && ctx.path === '/api/auth/mfa/passkey/verify') {
      const { challengeToken, response } = ctx.request.body ?? {}
      let claims
      try { claims = jwt.verify(challengeToken, identityPublicKey, { algorithms: ['RS256'] }); if (!claims.mfaPending || claims.purpose !== 'mfa-passkey' || !claims.webauthnChallenge) throw new Error('invalid') } catch { ctx.throw(401, 'Phiên Passkey đã hết hạn.') }
      const passkeyBucket = await reserveAttempt(ctx, 'mfa-passkey-verify', `${claims.sub}:${clientIp(ctx)}`, 6)
      const passkey = await pool.query('SELECT id,credential_id,public_key,sign_count,transports FROM identity.passkeys WHERE user_id=$1 AND credential_id=$2', [claims.sub, Buffer.from(String(response?.id ?? ''), 'utf8')])
      if (!passkey.rowCount) ctx.throw(401, 'Không nhận diện được Passkey.')
      let verification
      try { verification = await verifyAuthenticationResponse({ response, expectedChallenge: claims.webauthnChallenge, expectedOrigin: webauthnOrigin, expectedRPID: webauthnRPID, requireUserVerification: true, credential: { id: Buffer.from(passkey.rows[0].credential_id).toString('utf8'), publicKey: new Uint8Array(passkey.rows[0].public_key), counter: Number(passkey.rows[0].sign_count), transports: passkey.rows[0].transports } }) } catch { ctx.throw(401, 'Xác thực Passkey thất bại.') }
      if (!verification?.verified) ctx.throw(401, 'Xác thực Passkey thất bại.')
      await clearAttempt(passkeyBucket)
      await pool.query('UPDATE identity.passkeys SET sign_count=$1,last_used_at=now() WHERE id=$2', [verification.authenticationInfo.newCounter, passkey.rows[0].id])
      const user = await pool.query("SELECT id,role,must_change_password,token_version FROM identity.users WHERE id=$1 AND status='HOAT_DONG'", [claims.sub])
      if (!user.rowCount || (claims.tokenVersion ?? 0) !== user.rows[0].token_version) ctx.throw(401, 'Tài khoản không còn hoạt động hoặc phiên đã bị thu hồi.')
      ctx.body = { token: signToken(user.rows[0]), role: user.rows[0].role, mustChangePassword: user.rows[0].must_change_password }
      return
    }
  }

  if (ctx.path.startsWith('/api/portal/') || ctx.path.startsWith('/api/admin/accounts')) {
    const claims = await verifyBearer(ctx)
    if (ctx.path.startsWith('/api/admin/') && (claims.role !== 'QUAN_TRI' || claims.mustChangePassword)) ctx.throw(403, 'Bạn không có quyền thực hiện thao tác này.')
    if (ctx.path.startsWith('/api/portal/') && (claims.mustChangePassword || !['SINH_VIEN', 'GIANG_VIEN'].includes(claims.role))) ctx.throw(403, 'Bạn không có quyền truy cập cổng này.')
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
    if (phone && phone.trim() !== '' && !/^\d{10}$/.test(phone.trim())) ctx.throw(400, 'Số điện thoại phải gồm đúng 10 chữ số.')
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
      pool.query('SELECT id,label,transports,created_at,last_used_at AS last_used FROM identity.passkeys WHERE user_id=$1 ORDER BY created_at', [ctx.state.identity.sub]),
      pool.query('SELECT count(*)::int AS remaining FROM identity.recovery_codes WHERE user_id=$1 AND used_at IS NULL', [ctx.state.identity.sub]),
    ])
    ctx.body = { totpEnabled: Boolean(totp.rows[0]?.enabled), passkeys: passkeys.rows, recoveryCodesRemaining: recovery.rows[0].remaining }
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/security/totp/setup') {
    const { currentPassword } = ctx.request.body ?? {}
    const user = await requireCurrentPassword(ctx, ctx.state.identity.sub, currentPassword, 'Nhập đúng mật khẩu hiện tại để bật Google Authenticator.')
    const existing = await pool.query('SELECT confirmed_at FROM identity.totp_factors WHERE user_id=$1', [ctx.state.identity.sub])
    if (existing.rows[0]?.confirmed_at) ctx.throw(409, 'Google Authenticator đã được bật.')
    const secret = new OTPAuth.Secret({ size: 20 }).base32
    const totp = new OTPAuth.TOTP({ issuer: 'QL Đề Tài', label: user.username, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) })
    await pool.query(`INSERT INTO identity.totp_factors(user_id,encrypted_secret,encryption_version,confirmed_at) VALUES($1,$2,'AES-256-GCM-v1',NULL)
      ON CONFLICT(user_id) DO UPDATE SET encrypted_secret=EXCLUDED.encrypted_secret,encryption_version=EXCLUDED.encryption_version,confirmed_at=NULL,created_at=now()`, [ctx.state.identity.sub, encryptSecret(secret)])
    ctx.body = { secret, otpauthUrl: totp.toString() }
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/security/totp/confirm') {
    const { code } = ctx.request.body ?? {}
    const confirmBucket = await reserveAttempt(ctx, 'totp-confirm', `${ctx.state.identity.sub}:${clientIp(ctx)}`, 6)
    const pending = await pool.query('SELECT encrypted_secret FROM identity.totp_factors WHERE user_id=$1 AND confirmed_at IS NULL', [ctx.state.identity.sub])
    if (!pending.rowCount || !checkTotp(decryptSecret(pending.rows[0].encrypted_secret), String(code ?? ''))) ctx.throw(400, 'Mã Google Authenticator không đúng.')
    await clearAttempt(confirmBucket)
    const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(6).toString('hex').toUpperCase())
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const confirmed = await client.query('UPDATE identity.totp_factors SET confirmed_at=now() WHERE user_id=$1 AND confirmed_at IS NULL RETURNING user_id', [ctx.state.identity.sub])
      if (!confirmed.rowCount) ctx.throw(409, 'Yêu cầu thiết lập đã được xác nhận. Hãy tải lại cài đặt.')
      await client.query('DELETE FROM identity.recovery_codes WHERE user_id=$1', [ctx.state.identity.sub])
      for (const recoveryCode of recoveryCodes) await client.query('INSERT INTO identity.recovery_codes(user_id,code_hash) VALUES($1,$2)', [ctx.state.identity.sub, createHash('sha256').update(recoveryCode).digest()])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    ctx.body = { enabled: true, recoveryCodes }
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/security/totp/disable') {
    const { currentPassword, code } = ctx.request.body ?? {}
    await requireCurrentPassword(ctx, ctx.state.identity.sub, currentPassword, 'Mật khẩu hiện tại không đúng.')
    const disableBucket = await reserveAttempt(ctx, 'totp-disable', `${ctx.state.identity.sub}:${clientIp(ctx)}`, 6)
    const factor = await pool.query('SELECT encrypted_secret FROM identity.totp_factors WHERE user_id=$1 AND confirmed_at IS NOT NULL', [ctx.state.identity.sub])
    if (!factor.rowCount || !checkTotp(decryptSecret(factor.rows[0].encrypted_secret), String(code ?? ''))) ctx.throw(400, 'Mã Google Authenticator không đúng.')
    await clearAttempt(disableBucket)
    await pool.query('WITH codes AS (DELETE FROM identity.recovery_codes WHERE user_id=$1) DELETE FROM identity.totp_factors WHERE user_id=$1', [ctx.state.identity.sub])
    ctx.body = { enabled: false }
    return
  }

  if (ctx.method === 'POST' && ctx.path === '/api/portal/security/passkeys/options') {
    const { currentPassword } = ctx.request.body ?? {}
    const user = await requireCurrentPassword(ctx, ctx.state.identity.sub, currentPassword, 'Nhập đúng mật khẩu hiện tại để thêm Passkey.')
    const known = await pool.query('SELECT credential_id,transports FROM identity.passkeys WHERE user_id=$1', [ctx.state.identity.sub])
    const options = await generateRegistrationOptions({ rpName: 'QL Đề Tài', rpID: webauthnRPID, userName: user.username, userDisplayName: user.display_name, userID: new Uint8Array(Buffer.from(ctx.state.identity.sub.replaceAll('-', ''), 'hex')), timeout: 120000, attestationType: 'none', excludeCredentials: known.rows.map((item) => ({ id: Buffer.from(item.credential_id).toString('utf8'), transports: item.transports })), authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' }, preferredAuthenticatorType: 'remoteDevice' })
    ctx.body = { options, challengeToken: jwt.sign({ sub: ctx.state.identity.sub, challenge: options.challenge, purpose: 'passkey-register' }, identityPrivateKey, { expiresIn: '5m', algorithm: 'RS256' }) }
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/security/passkeys/verify') {
    const { challengeToken, response, label } = ctx.request.body ?? {}
    let challenge
    try { challenge = jwt.verify(challengeToken, identityPublicKey, { algorithms: ['RS256'] }); if (challenge.sub !== ctx.state.identity.sub || challenge.purpose !== 'passkey-register') throw new Error('invalid') } catch { ctx.throw(401, 'Phiên đăng ký Passkey đã hết hạn.') }
    let verification
    try { verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: webauthnOrigin, expectedRPID: webauthnRPID, requireUserVerification: true }) } catch { ctx.throw(400, 'Không xác minh được Passkey.') }
    if (!verification?.verified || !verification.registrationInfo) ctx.throw(400, 'Đăng ký Passkey thất bại.')
    if (response?.authenticatorAttachment !== 'cross-platform' || !Array.isArray(response?.response?.transports) || !response.response.transports.includes('hybrid')) {
      ctx.throw(400, 'Hãy chọn điện thoại trong hộp thoại trình duyệt, bật Bluetooth và quét mã QR để thêm Passkey.')
    }
    const credential = verification.registrationInfo.credential
    try { await pool.query('INSERT INTO identity.passkeys(user_id,credential_id,public_key,sign_count,transports,label) VALUES($1,$2,$3,$4,$5,$6)', [ctx.state.identity.sub, Buffer.from(credential.id, 'utf8'), Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], String(label ?? 'Passkey').slice(0, 80)]) }
    catch (error) { if (error.code === '23505') ctx.throw(409, 'Passkey này đã được thêm.'); throw error }
    ctx.body = { saved: true }
    return
  }
  const passkeyDelete = ctx.path.match(/^\/api\/portal\/security\/passkeys\/([^/]+)$/)
  if (passkeyDelete && ctx.method === 'DELETE') {
    const { currentPassword } = ctx.request.body ?? {}
    await requireCurrentPassword(ctx, ctx.state.identity.sub, currentPassword, 'Mật khẩu hiện tại không đúng.')
    await pool.query('DELETE FROM identity.passkeys WHERE id=$1 AND user_id=$2', [passkeyDelete[1], ctx.state.identity.sub])
    ctx.body = { deleted: true }
    return
  }

  const accountStatus = ctx.path.match(/^\/api\/admin\/accounts\/([0-9a-f-]+)\/status$/i)
  if (ctx.method === 'PATCH' && accountStatus) {
    const status = ctx.request.body?.status
    if (!['HOAT_DONG','KHOA','BI_KHOA'].includes(status)) ctx.throw(400, 'Trạng thái tài khoản không hợp lệ.')
    const result = await pool.query(`WITH changed AS (
      UPDATE identity.users SET status=$1,token_version=token_version+1,updated_at=now()
      WHERE id=$2 AND role IN ('SINH_VIEN','GIANG_VIEN') RETURNING id,username,status
    ), audit AS (INSERT INTO identity.security_events(user_id,actor_id,action)
      SELECT id,$3,'ACCOUNT_STATUS_' || status FROM changed)
    SELECT * FROM changed`, [status === 'BI_KHOA' ? 'KHOA' : status,accountStatus[1],ctx.state.identity.sub])
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy tài khoản sinh viên hoặc giảng viên.')
    ctx.body = result.rows[0]; return
  }
  const resetPassword = ctx.path.match(/^\/api\/admin\/accounts\/([0-9a-f-]+)\/reset-password$/i)
  if (ctx.method === 'POST' && resetPassword) {
    const temporaryPassword = randomBytes(18).toString('base64url')
    const result = await pool.query(`WITH changed AS (
      UPDATE identity.users SET password_hash=$1,must_change_password=true,token_version=token_version+1,updated_at=now()
      WHERE id=$2 AND role IN ('SINH_VIEN','GIANG_VIEN') RETURNING id,username
    ), audit AS (INSERT INTO identity.security_events(user_id,actor_id,action)
      SELECT id,$3,'PASSWORD_RESET' FROM changed)
    SELECT * FROM changed`, [await hashPassword(temporaryPassword),resetPassword[1],ctx.state.identity.sub])
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy tài khoản sinh viên hoặc giảng viên.')
    ctx.body = { username: result.rows[0].username, temporaryPassword }; return
  }
  if (ctx.method === 'GET' && ctx.path === '/api/admin/accounts') {
    const result = await pool.query('SELECT id,username,role,status,created_at,display_name AS name,profile_code,department_id FROM identity.users ORDER BY created_at DESC LIMIT 100')
    const departments = await fetch('http://academic-service:3102/internal/v1/academic/departments').then((response) => response.json()).catch(() => [])
    ctx.body = result.rows.map((user) => ({ ...user, department: departments.find((item) => item.id === user.department_id)?.name ?? null }))
    return
  }
  const internalUser = ctx.path.match(/^\/internal\/v1\/identity\/users\/([0-9a-f-]+)$/i)
  if (ctx.method === 'GET' && internalUser) {
    const result = await pool.query('SELECT id,username,role,status,must_change_password,token_version,display_name,profile_code,department_id,class_name,phone,academic_title,degree,specialization FROM identity.users WHERE id=$1', [internalUser[1]])
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
    if (phone && phone.trim() !== '' && !/^\d{10}$/.test(phone.trim())) ctx.throw(400, 'Số điện thoại phải gồm đúng 10 chữ số.')
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

app.use(async (ctx) => { ctx.status = 404; ctx.body = { error: 'Không tìm thấy chức năng.' } })

const port = Number(process.env.PORT) || 3101
const server = app.listen(port, () => console.log(`Identity service listening on ${port}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => void pool.end()))
