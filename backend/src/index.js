import 'dotenv/config'
import Koa from 'koa'
import cors from '@koa/cors'
import { bodyParser } from '@koa/bodyparser'
import bcrypt from 'bcryptjs'
import argon2 from 'argon2'
import * as OTPAuth from 'otpauth'
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import jwt from 'jsonwebtoken'
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto'
import { pool } from './db.js'

const app = new Koa()
const port = Number(process.env.PORT) || 3000
const jwtSecret = process.env.JWT_SECRET
const departmentInitials = (name) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).map((word) => word[0]).join('').slice(0, 8)
const argonOptions = { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32 }
const hashPassword = (password) => argon2.hash(password, { ...argonOptions, salt: randomBytes(16) })
const verifyPassword = async (password, hash) => hash?.startsWith('$argon2id$')
  ? { valid: await argon2.verify(hash, password), needsUpgrade: false }
  : { valid: await bcrypt.compare(password, hash ?? ''), needsUpgrade: true }
const totpKey = () => createHash('sha256').update(process.env.TOTP_ENCRYPTION_KEY || `${jwtSecret}:qldetai-totp-v1`).digest()
function encryptTotpSecret(secret) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', totpKey(), iv)
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted])
}
function decryptTotpSecret(value) {
  const data = Buffer.from(value)
  const decipher = createDecipheriv('aes-256-gcm', totpKey(), data.subarray(0, 12))
  decipher.setAuthTag(data.subarray(12, 28))
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8')
}
const totpMatches = (secret, token) => new OTPAuth.TOTP({ issuer: 'QL Đề Tài', label: 'Tài khoản', algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) }).validate({ token, window: 1 }) !== null
const webauthnRPID = process.env.WEBAUTHN_RP_ID || 'localhost'
const webauthnOrigin = process.env.WEBAUTHN_ORIGIN || 'http://localhost:5173'
const pendingClaims = (token) => {
  const claims = jwt.verify(token, jwtSecret)
  if (!claims.mfaPending) throw new Error('Yêu cầu xác thực đã hết hạn hoặc không hợp lệ.')
  return claims
}
const issueAccessToken = (account) => jwt.sign({ sub: account.id, role: account.vai_tro, mustChangePassword: account.doi_mat_khau_lan_dau }, jwtSecret, { expiresIn: '8h' })

app.use(async (ctx, next) => {
  try {
    await next()
  } catch (error) {
    const status = error.status ?? 500
    ctx.status = status
    ctx.body = { error: status < 500 ? error.message : 'Lỗi máy chủ nội bộ.' }
    if (status >= 500) console.error(error)
  }
})
app.use(cors())
app.use(bodyParser())
app.use(async (ctx, next) => {
  if (ctx.method === 'POST' && ctx.path === '/api/auth/login') {
    const { username, password } = ctx.request.body ?? {}
    if (!username || !password) {
      ctx.status = 400
      ctx.body = { error: 'Vui lòng nhập tên đăng nhập và mật khẩu.' }
      return
    }
    const result = await pool.query(
      `SELECT a.id, a.ten_dang_nhap, a.bam_mat_khau, a.vai_tro, a.trang_thai, a.doi_mat_khau_lan_dau,
              COALESCE(s.ho_ten, l.ho_ten, ad.ho_ten, a.ten_dang_nhap) AS ho_ten
       FROM qldetai.tai_khoan a
       LEFT JOIN qldetai.ho_so_sinh_vien s ON s.tai_khoan_id=a.id
       LEFT JOIN qldetai.ho_so_giang_vien l ON l.tai_khoan_id=a.id
       LEFT JOIN qldetai.ho_so_quan_tri ad ON ad.tai_khoan_id=a.id
       WHERE a.ten_dang_nhap = lower(btrim($1)) LIMIT 1`,
      [username],
    )
    const account = result.rows[0]
    let passwordCheck = { valid: false, needsUpgrade: false }
    try { if (account?.bam_mat_khau) passwordCheck = await verifyPassword(password, account.bam_mat_khau) } catch { passwordCheck = { valid: false, needsUpgrade: false } }
    if (!account || account.trang_thai !== 'HOAT_DONG' || !passwordCheck.valid) {
      ctx.status = 401
      ctx.body = { error: 'Tên đăng nhập hoặc mật khẩu không đúng.' }
      return
    }
    if (!jwtSecret) ctx.throw(500, 'JWT_SECRET is not configured')
    if (passwordCheck.needsUpgrade) {
      const upgradedHash = await hashPassword(password)
      await pool.query('UPDATE qldetai.tai_khoan SET bam_mat_khau=$1,cap_nhat_luc=now() WHERE id=$2 AND bam_mat_khau=$3', [upgradedHash, account.id, account.bam_mat_khau])
    }
    const factors = await pool.query(`SELECT EXISTS(SELECT 1 FROM qldetai.yeu_to_totp WHERE tai_khoan_id=$1 AND xac_nhan_luc IS NOT NULL) AS totp,
                                            EXISTS(SELECT 1 FROM qldetai.khoa_passkey WHERE tai_khoan_id=$1) AS passkey`, [account.id])
    if (factors.rows[0].totp || factors.rows[0].passkey) {
      ctx.body = { mfaRequired: true, role: account.vai_tro, methods: factors.rows[0], mfaToken: jwt.sign({ sub: account.id, role: account.vai_tro, mustChangePassword: account.doi_mat_khau_lan_dau, mfaPending: true }, jwtSecret, { expiresIn: '5m' }) }
      return
    }
    ctx.body = {
      token: issueAccessToken(account),
      role: account.vai_tro,
      mustChangePassword: account.doi_mat_khau_lan_dau,
      user: { id: account.id, name: account.ho_ten, username: account.ten_dang_nhap },
    }
    return
  }

  if (ctx.method === 'POST' && ctx.path === '/api/auth/change-password') {
    const token = ctx.get('authorization').replace(/^Bearer\s+/i, '')
    let claims
    try { claims = jwt.verify(token, jwtSecret) } catch {
      ctx.status = 401
      ctx.body = { error: 'Phiên đăng nhập hết hạn hoặc không hợp lệ.' }
      return
    }
    const { currentPassword, newPassword } = ctx.request.body ?? {}
    if (!currentPassword || !newPassword || newPassword.length < 12) ctx.throw(400, 'Mật khẩu mới phải có ít nhất 12 ký tự.')
    const account = await pool.query('SELECT bam_mat_khau FROM qldetai.tai_khoan WHERE id=$1', [claims.sub])
    const checked = account.rowCount ? await verifyPassword(currentPassword, account.rows[0].bam_mat_khau ?? '') : { valid: false }
    if (!checked.valid) ctx.throw(400, 'Mật khẩu hiện tại không chính xác.')
    const hash = await hashPassword(newPassword)
    await pool.query('UPDATE qldetai.tai_khoan SET bam_mat_khau=$1, doi_mat_khau_lan_dau=false, doi_mat_khau_luc=now(), cap_nhat_luc=now() WHERE id=$2', [hash, claims.sub])
    ctx.body = { token: jwt.sign({ sub: claims.sub, role: claims.role, mustChangePassword: false }, jwtSecret, { expiresIn: '8h' }) }
    return
  }

  if (ctx.method === 'POST' && ctx.path === '/api/auth/mfa/totp') {
    const bearer = ctx.get('authorization').replace(/^Bearer\s+/i, '')
    let claims
    try { claims = pendingClaims(bearer) } catch { ctx.throw(401, 'Phiên xác thực hai lớp đã hết hạn.') }
    const { code } = ctx.request.body ?? {}
    const factor = await pool.query('SELECT bi_mat_ma_hoa FROM qldetai.yeu_to_totp WHERE tai_khoan_id=$1 AND xac_nhan_luc IS NOT NULL', [claims.sub])
    let valid = false
    if (factor.rowCount && /^\d{6}$/.test(String(code ?? ''))) valid = totpMatches(decryptTotpSecret(factor.rows[0].bi_mat_ma_hoa), String(code))
    if (!valid && code) {
      const recoveryHash = createHash('sha256').update(String(code).trim().toUpperCase()).digest()
      const consumed = await pool.query('UPDATE qldetai.ma_khoi_phuc SET da_dung_luc=now() WHERE tai_khoan_id=$1 AND ma_bam=$2 AND da_dung_luc IS NULL RETURNING id', [claims.sub, recoveryHash])
      valid = Boolean(consumed.rowCount)
    }
    if (!valid) ctx.throw(401, 'Mã xác thực không đúng hoặc đã được sử dụng.')
    const account = await pool.query('SELECT id,vai_tro,doi_mat_khau_lan_dau FROM qldetai.tai_khoan WHERE id=$1 AND trang_thai=\'HOAT_DONG\'', [claims.sub])
    if (!account.rowCount) ctx.throw(401, 'Tài khoản không còn hoạt động.')
    ctx.body = { token: issueAccessToken(account.rows[0]), role: account.rows[0].vai_tro, mustChangePassword: account.rows[0].doi_mat_khau_lan_dau }
    return
  }

  if (ctx.method === 'POST' && ctx.path === '/api/auth/mfa/passkey/options') {
    const bearer = ctx.get('authorization').replace(/^Bearer\s+/i, '')
    let claims
    try { claims = pendingClaims(bearer) } catch { ctx.throw(401, 'Phiên xác thực hai lớp đã hết hạn.') }
    const passkeys = await pool.query('SELECT ma_thong_tin,kenh FROM qldetai.khoa_passkey WHERE tai_khoan_id=$1', [claims.sub])
    if (!passkeys.rowCount) ctx.throw(400, 'Tài khoản chưa đăng ký Passkey.')
    const options = await generateAuthenticationOptions({ rpID: webauthnRPID, userVerification: 'required', allowCredentials: passkeys.rows.map((item) => ({ id: Buffer.from(item.ma_thong_tin).toString('utf8'), transports: item.kenh })) })
    ctx.body = { options, challengeToken: jwt.sign({ sub: claims.sub, role: claims.role, mustChangePassword: claims.mustChangePassword, mfaPending: true, webauthnChallenge: options.challenge, purpose: 'mfa-passkey' }, jwtSecret, { expiresIn: '5m' }) }
    return
  }

  if (ctx.method === 'POST' && ctx.path === '/api/auth/mfa/passkey/verify') {
    const { challengeToken, response } = ctx.request.body ?? {}
    let claims
    try { claims = jwt.verify(challengeToken, jwtSecret); if (!claims.mfaPending || claims.purpose !== 'mfa-passkey' || !claims.webauthnChallenge) throw new Error('invalid') } catch { ctx.throw(401, 'Phiên Passkey đã hết hạn.') }
    const passkey = await pool.query('SELECT id,ma_thong_tin,khoa_cong_khai,bo_dem_chu_ky,kenh FROM qldetai.khoa_passkey WHERE tai_khoan_id=$1 AND ma_thong_tin=$2', [claims.sub, Buffer.from(String(response?.id ?? ''), 'utf8')])
    if (!passkey.rowCount) ctx.throw(401, 'Không nhận diện được Passkey.')
    let verification
    try {
      verification = await verifyAuthenticationResponse({ response, expectedChallenge: claims.webauthnChallenge, expectedOrigin: webauthnOrigin, expectedRPID: webauthnRPID, requireUserVerification: true, credential: { id: Buffer.from(passkey.rows[0].ma_thong_tin).toString('utf8'), publicKey: new Uint8Array(passkey.rows[0].khoa_cong_khai), counter: Number(passkey.rows[0].bo_dem_chu_ky), transports: passkey.rows[0].kenh } })
    } catch { ctx.throw(401, 'Xác thực Passkey thất bại.') }
    if (!verification?.verified) ctx.throw(401, 'Xác thực Passkey thất bại.')
    await pool.query('UPDATE qldetai.khoa_passkey SET bo_dem_chu_ky=$1,su_dung_gan_nhat=now() WHERE id=$2', [verification.authenticationInfo.newCounter, passkey.rows[0].id])
    const account = await pool.query('SELECT id,vai_tro,doi_mat_khau_lan_dau FROM qldetai.tai_khoan WHERE id=$1 AND trang_thai=\'HOAT_DONG\'', [claims.sub])
    if (!account.rowCount) ctx.throw(401, 'Tài khoản không còn hoạt động.')
    ctx.body = { token: issueAccessToken(account.rows[0]), role: account.rows[0].vai_tro, mustChangePassword: account.rows[0].doi_mat_khau_lan_dau }
    return
  }

  if (ctx.path.startsWith('/api/admin/')) {
    const token = ctx.get('authorization').replace(/^Bearer\s+/i, '')
    try {
      const claims = jwt.verify(token, jwtSecret)
      if (claims.role !== 'QUAN_TRI' || claims.mustChangePassword) ctx.throw(403)
      ctx.state.adminId = claims.sub
    } catch {
      ctx.status = 401
      ctx.body = { error: 'Phiên đăng nhập hết hạn hoặc không hợp lệ.' }
      return
    }
  }
  if (ctx.path.startsWith('/api/portal/')) {
    const token = ctx.get('authorization').replace(/^Bearer\s+/i, '')
    try {
      const claims = jwt.verify(token, jwtSecret)
      if (!['SINH_VIEN', 'GIANG_VIEN'].includes(claims.role) || claims.mustChangePassword) ctx.throw(403)
      ctx.state.accountId = claims.sub
      ctx.state.role = claims.role
    } catch {
      ctx.status = 401
      ctx.body = { error: 'Phiên đăng nhập hết hạn hoặc không hợp lệ.' }
      return
    }
  }
  await next()
})

app.use(async (ctx) => {
  if (ctx.method === 'GET' && ctx.path === '/api/health') {
    ctx.body = { status: 'ok' }
    return
  }

  if (ctx.method === 'GET' && ctx.path === '/api/db-check') {
    try {
      const result = await pool.query(`
        SELECT current_database() AS database,
               to_regnamespace('qldetai') IS NOT NULL AS schema_exists
      `)
      ctx.body = { status: 'connected', ...result.rows[0] }
    } catch {
      ctx.status = 503
      ctx.body = { status: 'disconnected', error: 'Database connection failed' }
    }
    return
  }

  if (ctx.method === 'GET' && ctx.path === '/api/admin/overview') {
    const [students, lecturers, topics, pending, rounds, recentTopics] = await Promise.all([
      pool.query("SELECT count(*)::int AS total FROM qldetai.tai_khoan WHERE vai_tro='SINH_VIEN'"),
      pool.query("SELECT count(*)::int AS total FROM qldetai.tai_khoan WHERE vai_tro='GIANG_VIEN'"),
      pool.query('SELECT count(*)::int AS total FROM qldetai.de_tai'),
      pool.query("SELECT count(*)::int AS total FROM qldetai.dang_ky_de_tai WHERE trang_thai='CHO_DUYET'"),
      pool.query('SELECT count(*)::int AS total FROM qldetai.dot_dang_ky'),
      pool.query(`SELECT d.ma_de_tai AS code, d.tieu_de AS title, d.da_cong_bo AS published,
                         k.ten_khoa AS department, d.tao_luc AS created_at
                  FROM qldetai.de_tai d LEFT JOIN qldetai.khoa k ON k.id=d.khoa_id
                  ORDER BY d.tao_luc DESC LIMIT 6`),
    ])
    ctx.body = {
      stats: {
        students: students.rows[0].total,
        lecturers: lecturers.rows[0].total,
        topics: topics.rows[0].total,
        pendingRegistrations: pending.rows[0].total,
        rounds: rounds.rows[0].total,
      },
      recentTopics: recentTopics.rows,
    }
    return
  }

  if (ctx.path === '/api/admin/departments' && ctx.method === 'GET') {
    const result = await pool.query('SELECT id, ma_khoa AS code, ten_khoa AS name FROM qldetai.khoa ORDER BY ten_khoa')
    ctx.body = result.rows
    return
  }

  if (ctx.path === '/api/admin/departments' && ctx.method === 'POST') {
    const { name } = ctx.request.body ?? {}
    if (!name?.trim()) ctx.throw(400, 'Nhập tên khoa.')
    const normalizedName = name.trim()
    const prefix = departmentInitials(normalizedName)
    if (!prefix) ctx.throw(400, 'Tên khoa cần có chữ cái để sinh mã.')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`department:${prefix}`])
      const duplicate = await client.query('SELECT 1 FROM qldetai.khoa WHERE qldetai.unaccent_immutable(lower(btrim(ten_khoa)))=qldetai.unaccent_immutable(lower(btrim($1)))', [normalizedName])
      if (duplicate.rowCount) ctx.throw(409, 'Tên khoa này đã tồn tại.')
      const sequence = await client.query(
        "SELECT COALESCE(max(substring(ma_khoa from length($1)+1)::bigint),0)+1 AS next FROM qldetai.khoa WHERE ma_khoa ~ ($1 || '[0-9]+$')",
        [prefix],
      )
      const code = `${prefix}${sequence.rows[0].next}`
      const result = await client.query(
        'INSERT INTO qldetai.khoa(ma_khoa, ten_khoa) VALUES($1, $2) RETURNING id, ma_khoa AS code, ten_khoa AS name',
        [code, normalizedName],
      )
      await client.query('COMMIT')
      ctx.status = 201
      ctx.body = result.rows[0]
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return
  }

  const departmentClasses = ctx.path.match(/^\/api\/admin\/departments\/([^/]+)\/classes$/)
  if (departmentClasses && ctx.method === 'GET') {
    const result = await pool.query('SELECT id, ma_lop AS code, ten_lop AS name FROM qldetai.lop_hoc WHERE khoa_id=$1 ORDER BY ten_lop', [departmentClasses[1]])
    ctx.body = result.rows
    return
  }

  if (ctx.path === '/api/admin/classes' && ctx.method === 'POST') {
    const { departmentId } = ctx.request.body ?? {}
    if (!departmentId) ctx.throw(400, 'Chọn khoa.')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`class:${departmentId}`])
      const department = await client.query("SELECT regexp_replace(ma_khoa,'[0-9]+$','') AS prefix FROM qldetai.khoa WHERE id=$1", [departmentId])
      if (!department.rowCount) ctx.throw(400, 'Khoa đã chọn không tồn tại.')
      const prefix = department.rows[0].prefix
      const sequence = await client.query(
        "SELECT COALESCE(max(substring(ma_lop from '-K([0-9]+)$')::integer),0)+1 AS next FROM qldetai.lop_hoc WHERE khoa_id=$1 AND ma_lop ~ ('^' || $2 || '-K[0-9]+$')",
        [departmentId, prefix],
      )
      const code = `${prefix}-K${sequence.rows[0].next}`
      const result = await client.query(
        'INSERT INTO qldetai.lop_hoc(khoa_id,ma_lop,ten_lop) VALUES($1,$2,$2) RETURNING id,ma_lop AS code,ten_lop AS name',
        [departmentId, code],
      )
      await client.query('COMMIT')
      ctx.status = 201
      ctx.body = result.rows[0]
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
    return
  }

  if (ctx.path === '/api/admin/rounds' && ctx.method === 'GET') {
    const result = await pool.query(`SELECT r.id,r.ma_dot AS code,r.mo_luc AS opens_at,r.dong_luc AS closes_at,r.dang_mo AS is_open,
                                            h.ma_hoc_ky AS semester_code,h.ten_hoc_ky AS semester_name,h.bat_dau AS semester_start,h.ket_thuc AS semester_end
                                     FROM qldetai.dot_dang_ky r JOIN qldetai.hoc_ky h ON h.id=r.hoc_ky_id
                                     ORDER BY r.mo_luc DESC`)
    ctx.body = result.rows
    return
  }

  if (ctx.path === '/api/admin/rounds' && ctx.method === 'POST') {
    const { semesterCode, semesterName, semesterStart, semesterEnd, code, opensAt, closesAt } = ctx.request.body ?? {}
    if (![semesterCode, semesterName, semesterStart, semesterEnd, code, opensAt, closesAt].every((value) => typeof value === 'string' && value.trim())) ctx.throw(400, 'Điền đầy đủ thông tin học kỳ và đợt đăng ký.')
    if (new Date(semesterStart) >= new Date(semesterEnd) || new Date(opensAt) >= new Date(closesAt)) ctx.throw(400, 'Thời điểm kết thúc phải sau thời điểm bắt đầu.')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      let term = await client.query('SELECT id,ten_hoc_ky,bat_dau::text,ket_thuc::text FROM qldetai.hoc_ky WHERE ma_hoc_ky=$1', [semesterCode.trim()])
      if (!term.rowCount) {
        term = await client.query('INSERT INTO qldetai.hoc_ky(ma_hoc_ky,ten_hoc_ky,bat_dau,ket_thuc) VALUES($1,$2,$3,$4) RETURNING id', [semesterCode.trim(), semesterName.trim(), semesterStart, semesterEnd])
      } else if (term.rows[0].ten_hoc_ky !== semesterName.trim() || term.rows[0].bat_dau !== semesterStart || term.rows[0].ket_thuc !== semesterEnd) {
        ctx.throw(409, 'Mã học kỳ đã tồn tại với tên hoặc thời gian khác.')
      }
      const round = await client.query(
        `INSERT INTO qldetai.dot_dang_ky(hoc_ky_id,ma_dot,mo_luc,dong_luc,dang_mo)
         VALUES($1,$2,$3,$4,false) RETURNING id,ma_dot AS code,mo_luc AS opens_at,dong_luc AS closes_at,dang_mo AS is_open`,
        [term.rows[0].id, code.trim(), opensAt, closesAt],
      )
      await client.query('COMMIT')
      ctx.status = 201
      ctx.body = round.rows[0]
    } catch (error) {
      await client.query('ROLLBACK')
      if (error.code === '23505') ctx.throw(409, 'Mã đợt đã tồn tại trong học kỳ này.')
      throw error
    } finally { client.release() }
    return
  }

  const roundState = ctx.path.match(/^\/api\/admin\/rounds\/([^/]+)$/)
  if (roundState && ctx.method === 'PATCH') {
    const { isOpen } = ctx.request.body ?? {}
    if (typeof isOpen !== 'boolean') ctx.throw(400, 'Trạng thái đợt đăng ký không hợp lệ.')
    const result = await pool.query('UPDATE qldetai.dot_dang_ky SET dang_mo=$1 WHERE id=$2 RETURNING id,ma_dot AS code,dang_mo AS is_open', [isOpen, roundState[1]])
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy đợt đăng ký.')
    ctx.body = result.rows[0]
    return
  }

  if (ctx.path === '/api/admin/accounts' && ctx.method === 'GET') {
    const result = await pool.query(`
      SELECT a.id, a.ten_dang_nhap AS username, a.vai_tro::text AS role,
             a.trang_thai::text AS status, a.tao_luc AS created_at,
             COALESCE(s.ho_ten, l.ho_ten, ad.ho_ten) AS name,
             COALESCE(s.ma_sinh_vien, l.ma_giang_vien, ad.ma_quan_tri) AS profile_code,
             k.ten_khoa AS department
      FROM qldetai.tai_khoan a
      LEFT JOIN qldetai.ho_so_sinh_vien s ON s.tai_khoan_id=a.id
      LEFT JOIN qldetai.ho_so_giang_vien l ON l.tai_khoan_id=a.id
      LEFT JOIN qldetai.ho_so_quan_tri ad ON ad.tai_khoan_id=a.id
      LEFT JOIN qldetai.khoa k ON k.id=COALESCE(s.khoa_id,l.khoa_id)
      ORDER BY a.tao_luc DESC LIMIT 100
    `)
    ctx.body = result.rows
    return
  }

  if (ctx.path === '/api/admin/accounts' && ctx.method === 'POST') {
    const { role, name, departmentId, classId, phone, academicTitle, degree, specialization } = ctx.request.body ?? {}
    if (!name?.trim()) {
      ctx.throw(400, 'Điền đầy đủ thông tin tài khoản và hồ sơ.')
    }
    if (!['SINH_VIEN', 'GIANG_VIEN'].includes(role)) ctx.throw(400, 'Vai trò cấp mới không hợp lệ.')
    if (!departmentId) ctx.throw(400, 'Chọn khoa cho tài khoản.')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SET LOCAL search_path=qldetai,public')
      const department = await client.query('SELECT 1 FROM qldetai.khoa WHERE id=$1', [departmentId])
      if (!department.rowCount) ctx.throw(400, 'Khoa đã chọn không tồn tại.')
      let className = null
      if (role === 'SINH_VIEN') {
        if (!classId) ctx.throw(400, 'Chọn lớp cho sinh viên.')
        const selectedClass = await client.query('SELECT ten_lop FROM qldetai.lop_hoc WHERE id=$1 AND khoa_id=$2', [classId, departmentId])
        if (!selectedClass.rowCount) ctx.throw(400, 'Lớp không thuộc khoa đã chọn.')
        className = selectedClass.rows[0].ten_lop
      }
      const prefix = role === 'SINH_VIEN' ? 'SV' : 'GV'
      const codeColumn = role === 'SINH_VIEN' ? 'ma_sinh_vien' : 'ma_giang_vien'
      let profileCode
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const candidate = `${prefix}${randomInt(0, 100_000_000).toString().padStart(8, '0')}`
        const existing = await client.query(`SELECT 1 FROM qldetai.${role === 'SINH_VIEN' ? 'ho_so_sinh_vien' : 'ho_so_giang_vien'} WHERE ${codeColumn}=$1`, [candidate])
        if (!existing.rowCount) { profileCode = candidate; break }
      }
      if (!profileCode) ctx.throw(503, 'Chưa sinh được mã hồ sơ, vui lòng thử lại.')
      const username = profileCode.toLowerCase()
      const temporaryPassword = randomBytes(12).toString('base64url')
      const hash = await hashPassword(temporaryPassword)
      const account = await client.query(
        `INSERT INTO qldetai.tai_khoan(ten_dang_nhap,bam_mat_khau,vai_tro,trang_thai,doi_mat_khau_lan_dau,nguoi_tao)
         VALUES(lower(btrim($1)),$2,$3,'HOAT_DONG',true,$4) RETURNING id`,
        [username, hash, role, ctx.state.adminId],
      )
      if (role === 'SINH_VIEN') {
        await client.query(
          'INSERT INTO qldetai.ho_so_sinh_vien(tai_khoan_id,ma_sinh_vien,ho_ten,khoa_id,lop,dien_thoai) VALUES($1,$2,$3,$4,$5,$6)',
          [account.rows[0].id, profileCode.trim(), name.trim(), departmentId, className?.trim() || null, phone?.trim() || null],
        )
      } else {
        await client.query(
          `INSERT INTO qldetai.ho_so_giang_vien(tai_khoan_id,ma_giang_vien,ho_ten,khoa_id,dien_thoai,hoc_ham,hoc_vi,chuyen_mon)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
          [account.rows[0].id, profileCode.trim(), name.trim(), departmentId, phone?.trim() || null, academicTitle?.trim() || null, degree?.trim() || null, specialization?.trim() || null],
        )
      }
      await client.query('COMMIT')
      ctx.status = 201
      ctx.body = { id: account.rows[0].id, username, role, profileCode, temporaryPassword }
    } catch (error) {
      await client.query('ROLLBACK')
      if (error.code === '23505') ctx.throw(409, 'Tên đăng nhập hoặc mã hồ sơ đã được sử dụng.')
      throw error
    } finally {
      client.release()
    }
    return
  }

  if (ctx.path === '/api/portal/topics' && ctx.method === 'POST') {
    if (ctx.state.role !== 'GIANG_VIEN') ctx.throw(403, 'Chỉ giảng viên được tạo đề tài.')
    const { code, title, description, opensAt, closesAt, capacity } = ctx.request.body ?? {}
    if (!code?.trim() || !title?.trim() || !opensAt || !closesAt) ctx.throw(400, 'Nhập mã, tên và thời hạn đề tài.')
    if (new Date(opensAt) >= new Date(closesAt)) ctx.throw(400, 'Thời điểm đóng phải sau thời điểm mở.')
    const parsedCapacity = capacity === '' || capacity == null ? null : Number(capacity)
    if (parsedCapacity !== null && (!Number.isInteger(parsedCapacity) || parsedCapacity < 1)) ctx.throw(400, 'Sức chứa phải là số nguyên dương.')
    const lecturer = await pool.query('SELECT khoa_id FROM qldetai.ho_so_giang_vien WHERE tai_khoan_id=$1', [ctx.state.accountId])
    if (!lecturer.rowCount) ctx.throw(403, 'Không tìm thấy hồ sơ giảng viên.')
    try {
      const result = await pool.query(
        `INSERT INTO qldetai.de_tai(ma_de_tai,tieu_de,mo_ta,giang_vien_id,khoa_id,mo_luc,dong_luc,suc_chua,da_cong_bo)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,false)
         RETURNING id,ma_de_tai AS code,tieu_de AS title,mo_ta AS description,da_cong_bo AS published,mo_luc AS opens_at,dong_luc AS closes_at,suc_chua AS capacity`,
        [code.trim(), title.trim(), description?.trim() || null, ctx.state.accountId, lecturer.rows[0].khoa_id, opensAt, closesAt, parsedCapacity],
      )
      ctx.status = 201
      ctx.body = result.rows[0]
    } catch (error) {
      if (error.code === '23505') ctx.throw(409, 'Mã đề tài đã được sử dụng.')
      throw error
    }
    return
  }

  const topicPublication = ctx.path.match(/^\/api\/portal\/topics\/([^/]+)\/publication$/)
  if (topicPublication && ctx.method === 'PATCH') {
    if (ctx.state.role !== 'GIANG_VIEN') ctx.throw(403, 'Chỉ giảng viên được thay đổi trạng thái đề tài.')
    const { published } = ctx.request.body ?? {}
    if (typeof published !== 'boolean') ctx.throw(400, 'Trạng thái công bố không hợp lệ.')
    const topic = await pool.query('SELECT id FROM qldetai.de_tai WHERE id=$1 AND giang_vien_id=$2', [topicPublication[1], ctx.state.accountId])
    if (!topic.rowCount) ctx.throw(404, 'Không tìm thấy đề tài của bạn.')
    if (!published) {
      const active = await pool.query("SELECT 1 FROM qldetai.dang_ky_de_tai WHERE de_tai_id=$1 AND trang_thai IN ('CHO_DUYET','DA_DUYET') LIMIT 1", [topicPublication[1]])
      if (active.rowCount) ctx.throw(409, 'Không thể ẩn đề tài đang có đăng ký chờ duyệt hoặc đã được duyệt.')
    }
    const result = await pool.query('UPDATE qldetai.de_tai SET da_cong_bo=$1 WHERE id=$2 RETURNING da_cong_bo AS published', [published, topicPublication[1]])
    ctx.body = result.rows[0]
    return
  }

  if (ctx.path === '/api/portal/registrations' && ctx.method === 'POST') {
    if (ctx.state.role !== 'SINH_VIEN') ctx.throw(403, 'Chỉ sinh viên được gửi đăng ký.')
    const { topicId, roundId, reason } = ctx.request.body ?? {}
    if (!topicId || !roundId) ctx.throw(400, 'Chọn đề tài và đợt đăng ký.')
    try {
      const result = await pool.query('SELECT qldetai.dang_ky_de_tai($1,$2,$3,$4) AS id', [ctx.state.accountId, topicId, roundId, reason?.trim() || null])
      ctx.status = 201
      ctx.body = { id: result.rows[0].id, status: 'CHO_DUYET' }
    } catch (error) {
      if (['P0001', '23505', '23503'].includes(error.code)) ctx.throw(error.code === '23503' ? 400 : 409, error.message)
      throw error
    }
    return
  }

  const registrationCancel = ctx.path.match(/^\/api\/portal\/registrations\/([^/]+)\/cancel$/)
  if (registrationCancel && ctx.method === 'PATCH') {
    if (ctx.state.role !== 'SINH_VIEN') ctx.throw(403, 'Chỉ sinh viên được hủy đăng ký của mình.')
    const result = await pool.query(
      `UPDATE qldetai.dang_ky_de_tai SET trang_thai='DA_HUY',quyet_dinh_luc=now(),nguoi_quyet_dinh=$1
       WHERE id=$2 AND sinh_vien_id=$1 AND trang_thai='CHO_DUYET' RETURNING id,trang_thai AS status`,
      [ctx.state.accountId, registrationCancel[1]],
    )
    if (!result.rowCount) ctx.throw(409, 'Chỉ có thể hủy đăng ký đang chờ duyệt của bạn.')
    ctx.body = result.rows[0]
    return
  }

  const registrationDecision = ctx.path.match(/^\/api\/portal\/registrations\/([^/]+)\/decision$/)
  if (registrationDecision && ctx.method === 'PATCH') {
    if (ctx.state.role !== 'GIANG_VIEN') ctx.throw(403, 'Chỉ giảng viên được xử lý đăng ký.')
    const { status, note } = ctx.request.body ?? {}
    if (!['DA_DUYET', 'TU_CHOI'].includes(status)) ctx.throw(400, 'Quyết định không hợp lệ.')
    const result = await pool.query(
      `UPDATE qldetai.dang_ky_de_tai r SET trang_thai=$1,
         ly_do=CASE WHEN NULLIF(btrim($2),'') IS NULL THEN r.ly_do ELSE concat_ws(E'\\n',NULLIF(r.ly_do,''),'Ghi chú giảng viên: '||btrim($2)) END,
         quyet_dinh_luc=now(),nguoi_quyet_dinh=$3
       FROM qldetai.de_tai d WHERE r.id=$4 AND r.de_tai_id=d.id AND d.giang_vien_id=$3 AND r.trang_thai='CHO_DUYET'
       RETURNING r.id,r.trang_thai AS status,r.ly_do AS note,r.quyet_dinh_luc AS decided_at`,
      [status, note ?? null, ctx.state.accountId, registrationDecision[1]],
    )
    if (!result.rowCount) ctx.throw(409, 'Không tìm thấy đơn chờ duyệt thuộc đề tài của bạn.')
    ctx.body = result.rows[0]
    return
  }

  if (ctx.path === '/api/portal/profile' && ctx.method === 'GET') {
    const result = ctx.state.role === 'SINH_VIEN'
      ? await pool.query(`SELECT s.ma_sinh_vien AS code,s.ho_ten AS name,s.dien_thoai AS phone,s.lop AS class,k.ten_khoa AS department
                          FROM qldetai.ho_so_sinh_vien s JOIN qldetai.khoa k ON k.id=s.khoa_id WHERE s.tai_khoan_id=$1`, [ctx.state.accountId])
      : await pool.query(`SELECT g.ma_giang_vien AS code,g.ho_ten AS name,g.dien_thoai AS phone,g.hoc_ham AS academic_title,g.hoc_vi AS degree,g.chuyen_mon AS specialization,k.ten_khoa AS department
                          FROM qldetai.ho_so_giang_vien g JOIN qldetai.khoa k ON k.id=g.khoa_id WHERE g.tai_khoan_id=$1`, [ctx.state.accountId])
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy hồ sơ cá nhân.')
    ctx.body = { role: ctx.state.role, profile: result.rows[0] }
    return
  }

  if (ctx.path === '/api/portal/profile' && ctx.method === 'PATCH') {
    const { phone, academicTitle, degree, specialization } = ctx.request.body ?? {}
    if (ctx.state.role === 'SINH_VIEN') {
      await pool.query('UPDATE qldetai.ho_so_sinh_vien SET dien_thoai=NULLIF(btrim($1),\'\') WHERE tai_khoan_id=$2', [phone ?? '', ctx.state.accountId])
    } else {
      await pool.query(`UPDATE qldetai.ho_so_giang_vien SET dien_thoai=NULLIF(btrim($1),''),hoc_ham=NULLIF(btrim($2),''),hoc_vi=NULLIF(btrim($3),''),chuyen_mon=NULLIF(btrim($4),'') WHERE tai_khoan_id=$5`, [phone ?? '', academicTitle ?? '', degree ?? '', specialization ?? '', ctx.state.accountId])
    }
    ctx.body = { saved: true }
    return
  }

  if (ctx.path === '/api/portal/security' && ctx.method === 'GET') {
    const [totp, passkeys, recovery] = await Promise.all([
      pool.query('SELECT xac_nhan_luc IS NOT NULL AS enabled FROM qldetai.yeu_to_totp WHERE tai_khoan_id=$1', [ctx.state.accountId]),
      pool.query('SELECT id,nhan AS label,tao_luc AS created_at,su_dung_gan_nhat AS last_used FROM qldetai.khoa_passkey WHERE tai_khoan_id=$1 ORDER BY tao_luc', [ctx.state.accountId]),
      pool.query('SELECT count(*)::int AS remaining FROM qldetai.ma_khoi_phuc WHERE tai_khoan_id=$1 AND da_dung_luc IS NULL', [ctx.state.accountId]),
    ])
    ctx.body = { totpEnabled: Boolean(totp.rows[0]?.enabled), passkeys: passkeys.rows, recoveryCodesRemaining: recovery.rows[0].remaining }
    return
  }

  if (ctx.path === '/api/portal/security/totp/setup' && ctx.method === 'POST') {
    const { currentPassword } = ctx.request.body ?? {}
    const account = await pool.query('SELECT ten_dang_nhap,bam_mat_khau FROM qldetai.tai_khoan WHERE id=$1', [ctx.state.accountId])
    const checked = account.rowCount ? await verifyPassword(currentPassword ?? '', account.rows[0].bam_mat_khau ?? '') : { valid: false }
    if (!checked.valid) ctx.throw(403, 'Nhập đúng mật khẩu hiện tại để bật Google Authenticator.')
    const existing = await pool.query('SELECT xac_nhan_luc FROM qldetai.yeu_to_totp WHERE tai_khoan_id=$1', [ctx.state.accountId])
    if (existing.rows[0]?.xac_nhan_luc) ctx.throw(409, 'Google Authenticator đã được bật.')
    const secret = new OTPAuth.Secret({ size: 20 }).base32
    const totp = new OTPAuth.TOTP({ issuer: 'QL Đề Tài', label: account.rows[0].ten_dang_nhap, algorithm: 'SHA1', digits: 6, period: 30, secret: OTPAuth.Secret.fromBase32(secret) })
    await pool.query(`INSERT INTO qldetai.yeu_to_totp(tai_khoan_id,bi_mat_ma_hoa,ma_khoa_ma_hoa,xac_nhan_luc)
                      VALUES($1,$2,'AES-256-GCM-v1',NULL) ON CONFLICT(tai_khoan_id) DO UPDATE SET bi_mat_ma_hoa=EXCLUDED.bi_mat_ma_hoa,ma_khoa_ma_hoa=EXCLUDED.ma_khoa_ma_hoa,xac_nhan_luc=NULL,tao_luc=now()`, [ctx.state.accountId, encryptTotpSecret(secret)])
    ctx.body = { secret, otpauthUrl: totp.toString() }
    return
  }

  if (ctx.path === '/api/portal/security/totp/confirm' && ctx.method === 'POST') {
    const { code } = ctx.request.body ?? {}
    const pending = await pool.query('SELECT bi_mat_ma_hoa FROM qldetai.yeu_to_totp WHERE tai_khoan_id=$1 AND xac_nhan_luc IS NULL', [ctx.state.accountId])
    if (!pending.rowCount || !totpMatches(decryptTotpSecret(pending.rows[0].bi_mat_ma_hoa), String(code ?? ''))) ctx.throw(400, 'Mã Google Authenticator không đúng.')
    const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(6).toString('hex').toUpperCase())
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('UPDATE qldetai.yeu_to_totp SET xac_nhan_luc=now() WHERE tai_khoan_id=$1 AND xac_nhan_luc IS NULL', [ctx.state.accountId])
      await client.query('DELETE FROM qldetai.ma_khoi_phuc WHERE tai_khoan_id=$1', [ctx.state.accountId])
      for (const recoveryCode of recoveryCodes) await client.query('INSERT INTO qldetai.ma_khoi_phuc(tai_khoan_id,ma_bam) VALUES($1,$2)', [ctx.state.accountId, createHash('sha256').update(recoveryCode).digest()])
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
    ctx.body = { enabled: true, recoveryCodes }
    return
  }

  if (ctx.path === '/api/portal/security/totp/disable' && ctx.method === 'POST') {
    const { currentPassword, code } = ctx.request.body ?? {}
    const account = await pool.query('SELECT bam_mat_khau FROM qldetai.tai_khoan WHERE id=$1', [ctx.state.accountId])
    const checked = account.rowCount ? await verifyPassword(currentPassword ?? '', account.rows[0].bam_mat_khau ?? '') : { valid: false }
    if (!checked.valid) ctx.throw(403, 'Mật khẩu hiện tại không đúng.')
    const factor = await pool.query('SELECT bi_mat_ma_hoa FROM qldetai.yeu_to_totp WHERE tai_khoan_id=$1 AND xac_nhan_luc IS NOT NULL', [ctx.state.accountId])
    if (!factor.rowCount || !totpMatches(decryptTotpSecret(factor.rows[0].bi_mat_ma_hoa), String(code ?? ''))) ctx.throw(400, 'Mã Google Authenticator không đúng.')
    await pool.query('DELETE FROM qldetai.yeu_to_totp WHERE tai_khoan_id=$1', [ctx.state.accountId])
    await pool.query('DELETE FROM qldetai.ma_khoi_phuc WHERE tai_khoan_id=$1', [ctx.state.accountId])
    ctx.body = { enabled: false }
    return
  }

  if (ctx.path === '/api/portal/security/passkeys/options' && ctx.method === 'POST') {
    const { currentPassword } = ctx.request.body ?? {}
    const account = await pool.query(`SELECT a.ten_dang_nhap,COALESCE(s.ho_ten,g.ho_ten,a.ten_dang_nhap) AS display_name,a.bam_mat_khau
                                      FROM qldetai.tai_khoan a LEFT JOIN qldetai.ho_so_sinh_vien s ON s.tai_khoan_id=a.id
                                      LEFT JOIN qldetai.ho_so_giang_vien g ON g.tai_khoan_id=a.id WHERE a.id=$1`, [ctx.state.accountId])
    const checked = account.rowCount ? await verifyPassword(currentPassword ?? '', account.rows[0].bam_mat_khau ?? '') : { valid: false }
    if (!checked.valid) ctx.throw(403, 'Nhập đúng mật khẩu hiện tại để thêm Passkey.')
    const known = await pool.query('SELECT ma_thong_tin,kenh FROM qldetai.khoa_passkey WHERE tai_khoan_id=$1', [ctx.state.accountId])
    const options = await generateRegistrationOptions({ rpName: 'QL Đề Tài', rpID: webauthnRPID, userName: account.rows[0].ten_dang_nhap, userDisplayName: account.rows[0].display_name, userID: new Uint8Array(Buffer.from(ctx.state.accountId.replaceAll('-', ''), 'hex')), attestationType: 'none', excludeCredentials: known.rows.map((item) => ({ id: Buffer.from(item.ma_thong_tin).toString('utf8'), transports: item.kenh })), authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' } })
    ctx.body = { options, challengeToken: jwt.sign({ sub: ctx.state.accountId, challenge: options.challenge, purpose: 'passkey-register' }, jwtSecret, { expiresIn: '5m' }) }
    return
  }

  if (ctx.path === '/api/portal/security/passkeys/verify' && ctx.method === 'POST') {
    const { challengeToken, response, label } = ctx.request.body ?? {}
    let claims
    try { claims = jwt.verify(challengeToken, jwtSecret); if (claims.sub !== ctx.state.accountId || claims.purpose !== 'passkey-register') throw new Error('invalid') } catch { ctx.throw(401, 'Phiên đăng ký Passkey đã hết hạn.') }
    let verification
    try { verification = await verifyRegistrationResponse({ response, expectedChallenge: claims.challenge, expectedOrigin: webauthnOrigin, expectedRPID: webauthnRPID, requireUserVerification: true }) } catch { ctx.throw(400, 'Không xác minh được Passkey.') }
    if (!verification?.verified || !verification.registrationInfo) ctx.throw(400, 'Đăng ký Passkey thất bại.')
    const credential = verification.registrationInfo.credential
    try {
      await pool.query('INSERT INTO qldetai.khoa_passkey(tai_khoan_id,ma_thong_tin,khoa_cong_khai,bo_dem_chu_ky,kenh,nhan) VALUES($1,$2,$3,$4,$5,$6)', [ctx.state.accountId, Buffer.from(credential.id, 'utf8'), Buffer.from(credential.publicKey), credential.counter, credential.transports ?? [], String(label ?? 'Passkey').slice(0, 80)])
    } catch (error) { if (error.code === '23505') ctx.throw(409, 'Passkey này đã được thêm.'); throw error }
    ctx.body = { saved: true }
    return
  }

  const passkeyDelete = ctx.path.match(/^\/api\/portal\/security\/passkeys\/([^/]+)$/)
  if (passkeyDelete && ctx.method === 'DELETE') {
    const { currentPassword } = ctx.request.body ?? {}
    const account = await pool.query('SELECT bam_mat_khau FROM qldetai.tai_khoan WHERE id=$1', [ctx.state.accountId])
    const checked = account.rowCount ? await verifyPassword(currentPassword ?? '', account.rows[0].bam_mat_khau ?? '') : { valid: false }
    if (!checked.valid) ctx.throw(403, 'Mật khẩu hiện tại không đúng.')
    await pool.query('DELETE FROM qldetai.khoa_passkey WHERE id=$1 AND tai_khoan_id=$2', [passkeyDelete[1], ctx.state.accountId])
    ctx.body = { deleted: true }
    return
  }

  if (ctx.method === 'GET' && ctx.path === '/api/portal/overview') {
    if (ctx.state.role === 'SINH_VIEN') {
      const [profile, topics, registrations] = await Promise.all([
        pool.query('SELECT ho_ten, ma_sinh_vien, lop FROM qldetai.ho_so_sinh_vien WHERE tai_khoan_id=$1', [ctx.state.accountId]),
        pool.query(`SELECT d.id, d.ma_de_tai AS code, d.tieu_de AS title, d.mo_ta AS description,
                           g.ho_ten AS lecturer, k.ten_khoa AS department,
                           r.id AS round_id, r.ma_dot AS round_code,
                           GREATEST(d.mo_luc,r.mo_luc,COALESCE(h.mo_luc,'-infinity'::timestamptz)) AS opens_at,
                           LEAST(d.dong_luc,r.dong_luc,COALESCE(h.dong_luc,'infinity'::timestamptz)) AS closes_at,
                           d.suc_chua AS capacity,
                           (SELECT count(*)::int FROM qldetai.dang_ky_de_tai x WHERE x.de_tai_id=d.id AND x.dot_dang_ky_id=r.id AND x.trang_thai IN ('CHO_DUYET','DA_DUYET')) AS registered
                    FROM qldetai.de_tai d JOIN qldetai.ho_so_giang_vien g ON g.tai_khoan_id=d.giang_vien_id
                    JOIN qldetai.khoa k ON k.id=d.khoa_id
                    JOIN qldetai.dot_dang_ky r ON r.dang_mo
                    LEFT JOIN qldetai.thoi_han_de_tai_dot h ON h.de_tai_id=d.id AND h.dot_dang_ky_id=r.id
                    WHERE d.da_cong_bo AND (h.de_tai_id IS NULL OR h.duoc_phep)
                      AND now()>=GREATEST(d.mo_luc,r.mo_luc,COALESCE(h.mo_luc,'-infinity'::timestamptz))
                      AND now()<LEAST(d.dong_luc,r.dong_luc,COALESCE(h.dong_luc,'infinity'::timestamptz))
                    ORDER BY d.tao_luc DESC LIMIT 100`),
        pool.query(`SELECT r.id, r.dot_dang_ky_id AS round_id, d.ma_de_tai AS code, d.tieu_de AS title, r.trang_thai AS status, r.gui_luc AS submitted_at
                    FROM qldetai.dang_ky_de_tai r JOIN qldetai.de_tai d ON d.id=r.de_tai_id
                    WHERE r.sinh_vien_id=$1 ORDER BY r.gui_luc DESC LIMIT 12`, [ctx.state.accountId]),
      ])
      ctx.body = { role: ctx.state.role, profile: profile.rows[0] ?? null, topics: topics.rows, registrations: registrations.rows }
      return
    }
    const [profile, topics, registrations] = await Promise.all([
      pool.query('SELECT ho_ten, ma_giang_vien FROM qldetai.ho_so_giang_vien WHERE tai_khoan_id=$1', [ctx.state.accountId]),
      pool.query(`SELECT d.id,d.ma_de_tai AS code,d.tieu_de AS title,d.mo_ta AS description,d.da_cong_bo AS published,d.mo_luc AS opens_at,d.dong_luc AS closes_at,d.suc_chua AS capacity,
                         count(r.id) FILTER (WHERE r.trang_thai='CHO_DUYET')::int AS pending,
                         count(r.id) FILTER (WHERE r.trang_thai IN ('CHO_DUYET','DA_DUYET'))::int AS registered
                  FROM qldetai.de_tai d LEFT JOIN qldetai.dang_ky_de_tai r ON r.de_tai_id=d.id
                  WHERE d.giang_vien_id=$1 GROUP BY d.id ORDER BY d.tao_luc DESC`, [ctx.state.accountId]),
      pool.query(`SELECT r.id,r.trang_thai AS status,r.ly_do AS reason,r.gui_luc AS submitted_at,s.ma_sinh_vien AS student_code,s.ho_ten AS student_name,
                         d.id AS topic_id,d.ma_de_tai AS topic_code,d.tieu_de AS topic_title,dot.ma_dot AS round_code
                  FROM qldetai.dang_ky_de_tai r JOIN qldetai.de_tai d ON d.id=r.de_tai_id
                  JOIN qldetai.ho_so_sinh_vien s ON s.tai_khoan_id=r.sinh_vien_id JOIN qldetai.dot_dang_ky dot ON dot.id=r.dot_dang_ky_id
                  WHERE d.giang_vien_id=$1 ORDER BY r.gui_luc DESC LIMIT 100`, [ctx.state.accountId]),
    ])
    ctx.body = { role: ctx.state.role, profile: profile.rows[0] ?? null, topics: topics.rows, registrations: registrations.rows }
    return
  }

  ctx.status = 404
  ctx.body = { error: 'Not found' }
})

app.listen(port, () => {
  console.log(`Koa API listening on http://localhost:${port}`)
})
