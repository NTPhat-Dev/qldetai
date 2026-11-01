import { createApp } from '../../shared/create-app.js'
import { createDatabasePool } from '../../shared/database.js'
import jwt from 'jsonwebtoken'
import { randomUUID } from 'node:crypto'

const pool = createDatabasePool('registration')
const app = createApp({ name: 'registration', pool })
const jwtSecret = process.env.JWT_SECRET
function authorize(ctx, roles) {
  try {
    const claims = jwt.verify(ctx.get('authorization').replace(/^Bearer\s+/i, ''), jwtSecret)
    if (claims.mustChangePassword || !roles.includes(claims.role)) ctx.throw(403, 'Bạn không có quyền thực hiện thao tác này.')
    return claims
  } catch (error) { if (error.status === 403) throw error; ctx.throw(401, 'Phiên đăng nhập hết hạn hoặc không hợp lệ.') }
}

app.use(async (ctx) => {
  if (ctx.path.startsWith('/api/portal/')) {
    const role = ctx.path.startsWith('/api/portal/overview') ? ['SINH_VIEN','GIANG_VIEN'] : ['SINH_VIEN','GIANG_VIEN']
    ctx.state.user = authorize(ctx, role)
  }
  if (ctx.method === 'GET' && ctx.path === '/api/portal/overview') {
    const user = await fetch(`http://identity-service:3101/internal/v1/identity/users/${ctx.state.user.sub}`, { headers: { authorization: ctx.get('authorization') } }).then((response) => response.json())
    if (user.error || user.status !== 'HOAT_DONG') ctx.throw(403, 'Tài khoản không còn hoạt động.')
    if (user.role === 'SINH_VIEN') {
      const [available, own, clock] = await Promise.all([
        fetch('http://academic-service:3102/internal/v1/academic/student-topics').then((response) => response.json()),
        pool.query('SELECT id,round_id,topic_code AS code,topic_title AS title,status,submitted_at FROM registration.registrations WHERE student_id=$1 ORDER BY submitted_at DESC LIMIT 12', [user.id]),
        pool.query('SELECT clock_timestamp() AS server_time'),
      ])
      const topics = await Promise.all(available.map(async (topic) => {
        const [lecturer, counts] = await Promise.all([
          fetch(`http://identity-service:3101/internal/v1/identity/users/${topic.lecturer_id}`).then((response) => response.json()),
          fetch(`http://registration-service:3103/internal/v1/registrations/topics/${topic.id}/counts`).then((response) => response.json()),
        ])
        return { ...topic, opens_at: topic.effective_opens_at, closes_at: topic.effective_closes_at, lecturer: lecturer.display_name, ...counts }
      }))
      ctx.body = { role: user.role, profile: { ho_ten: user.display_name, ma_sinh_vien: user.profile_code, lop: user.class_name }, topics, registrations: own.rows, serverTime: clock.rows[0].server_time }
      return
    }
    const [topics, clock] = await Promise.all([
      fetch(`http://academic-service:3102/internal/v1/academic/lecturers/${user.id}/topics`).then((response) => response.json()),
      pool.query('SELECT clock_timestamp() AS server_time'),
    ])
    const registrationRows = await pool.query('SELECT id,student_id,topic_id,round_id,status,reason,submitted_at,topic_code,topic_title,round_code FROM registration.registrations ORDER BY submitted_at DESC LIMIT 100')
    const visible = await Promise.all(registrationRows.rows.map(async (row) => {
      const topic = await fetch(`http://academic-service:3102/internal/v1/academic/topics/${row.topic_id}`).then((response) => response.json()).catch(() => null)
      if (!topic || topic.lecturer_id !== user.id) return null
      const student = await fetch(`http://identity-service:3101/internal/v1/identity/users/${row.student_id}`).then((response) => response.json()).catch(() => ({}))
      return { id: row.id, status: row.status, reason: row.reason, submitted_at: row.submitted_at, student_code: student.profile_code, student_name: student.display_name, topic_id: row.topic_id, topic_code: row.topic_code, topic_title: row.topic_title, round_code: row.round_code }
    }))
    ctx.body = { role: user.role, profile: { ho_ten: user.display_name, ma_giang_vien: user.profile_code }, topics, registrations: visible.filter(Boolean), serverTime: clock.rows[0].server_time }
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/registrations') {
    if (ctx.state.user.role !== 'SINH_VIEN') ctx.throw(403, 'Chỉ sinh viên được gửi đăng ký.')
    const { topicId, roundId, reason } = ctx.request.body ?? {}
    const requestId = ctx.request.body?.requestId ?? randomUUID()
    if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) ctx.throw(400, 'Mã yêu cầu đăng ký không hợp lệ.')
    const previous = await pool.query('SELECT id,status FROM registration.registrations WHERE id=$1 AND student_id=$2', [requestId,ctx.state.user.sub])
    if (previous.rowCount) { ctx.status = 200; ctx.body = previous.rows[0]; return }
    const [user, available] = await Promise.all([
      fetch(`http://identity-service:3101/internal/v1/identity/users/${ctx.state.user.sub}`).then((response) => response.json()),
      fetch('http://academic-service:3102/internal/v1/academic/student-topics').then((response) => response.json()),
    ])
    const topic = available.find((row) => row.id === topicId && row.round_id === roundId)
    if (!topic || !user.profile_code) ctx.throw(400, 'Đề tài không khả dụng trong đợt đã chọn.')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      // Serialize requests for the same topic/round so the last seat cannot be oversold.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${topicId}:${roundId}`])
      const replay = await client.query('SELECT id,status FROM registration.registrations WHERE id=$1 AND student_id=$2', [requestId,ctx.state.user.sub])
      if (replay.rowCount) {
        await client.query('COMMIT'); ctx.status = 200; ctx.body = replay.rows[0]; return
      }
      const existing = await client.query("SELECT 1 FROM registration.registrations WHERE student_id=$1 AND round_id=$2 AND status IN ('CHO_DUYET','DA_DUYET')", [ctx.state.user.sub,roundId])
      if (existing.rowCount) ctx.throw(409, 'Bạn đã có đăng ký hiệu lực trong đợt này.')
      const count = await client.query("SELECT count(*)::int AS total FROM registration.registrations WHERE topic_id=$1 AND round_id=$2 AND status IN ('CHO_DUYET','DA_DUYET')", [topicId,roundId])
      if (topic.capacity != null && count.rows[0].total >= topic.capacity) ctx.throw(409, 'Đề tài đã đủ sức chứa.')
      const result = await client.query(`INSERT INTO registration.registrations(id,student_id,topic_id,round_id,topic_code,topic_title,student_code,student_name,round_code,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id,status`, [requestId,ctx.state.user.sub,topicId,roundId,topic.code,topic.title,user.profile_code,user.display_name,topic.round_code,reason?.trim()||null])
      await client.query('COMMIT'); ctx.status = 201; ctx.body = result.rows[0]
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') ctx.throw(409, 'Bạn đã có đăng ký hiệu lực trong đợt này.'); throw error } finally { client.release() }
    return
  }
  const cancel = ctx.path.match(/^\/api\/portal\/registrations\/([0-9a-f-]+)\/cancel$/i)
  if (ctx.method === 'PATCH' && cancel) {
    if (ctx.state.user.role !== 'SINH_VIEN') ctx.throw(403, 'Chỉ sinh viên được hủy đơn.')
    const result = await pool.query("UPDATE registration.registrations SET status='DA_HUY',decided_at=now(),decided_by=$1 WHERE id=$2 AND student_id=$1 AND status='CHO_DUYET' RETURNING id,status", [ctx.state.user.sub,cancel[1]])
    if (!result.rowCount) ctx.throw(409, 'Không tìm thấy đơn chờ duyệt của bạn.')
    ctx.body = result.rows[0]; return
  }
  const decision = ctx.path.match(/^\/api\/portal\/registrations\/([0-9a-f-]+)\/decision$/i)
  if (ctx.method === 'PATCH' && decision) {
    if (ctx.state.user.role !== 'GIANG_VIEN') ctx.throw(403, 'Chỉ giảng viên được xử lý đơn.')
    const { status,note } = ctx.request.body ?? {}
    if (!['DA_DUYET','TU_CHOI'].includes(status)) ctx.throw(400, 'Trạng thái xử lý không hợp lệ.')
    const row = await pool.query("SELECT topic_id FROM registration.registrations WHERE id=$1 AND status='CHO_DUYET'", [decision[1]])
    if (!row.rowCount) ctx.throw(409, 'Không tìm thấy đơn chờ duyệt.')
    const topic = await fetch(`http://academic-service:3102/internal/v1/academic/topics/${row.rows[0].topic_id}`).then((response) => response.json())
    if (topic.lecturer_id !== ctx.state.user.sub) ctx.throw(403, 'Đơn này không thuộc đề tài bạn hướng dẫn.')
    const result = await pool.query("UPDATE registration.registrations SET status=$1,reason=COALESCE($2,reason),decided_at=now(),decided_by=$3 WHERE id=$4 AND status='CHO_DUYET' RETURNING id,status,reason AS note,decided_at", [status,note?.trim()||null,ctx.state.user.sub,decision[1]])
    ctx.body = result.rows[0]; return
  }
  if (ctx.method === 'GET' && ctx.path === '/internal/v1/registrations/health-summary') {
    const result = await pool.query(`
      SELECT count(*) FILTER (WHERE status='CHO_DUYET')::int AS pending,
             count(*)::int AS total
      FROM registration.registrations
    `)
    ctx.body = result.rows[0]
    return
  }
  const topicCounts = ctx.path.match(/^\/internal\/v1\/registrations\/topics\/([0-9a-f-]+)\/counts$/i)
  if (ctx.method === 'GET' && topicCounts) {
    const result = await pool.query("SELECT count(*) FILTER (WHERE status='CHO_DUYET')::int AS pending,count(*) FILTER (WHERE status IN ('CHO_DUYET','DA_DUYET'))::int AS registered FROM registration.registrations WHERE topic_id=$1", [topicCounts[1]])
    ctx.body = result.rows[0]
    return
  }
  const activeTopic = ctx.path.match(/^\/internal\/v1\/registrations\/topics\/([0-9a-f-]+)\/active$/i)
  if (ctx.method === 'GET' && activeTopic) {
    const result = await pool.query("SELECT count(*)::int AS count FROM registration.registrations WHERE topic_id=$1 AND status IN ('CHO_DUYET','DA_DUYET')", [activeTopic[1]])
    ctx.body = result.rows[0]
    return
  }
  if (ctx.method === 'GET' && ctx.path === '/internal/v1/registrations/overview') {
    const result = await pool.query("SELECT count(*) FILTER (WHERE status='CHO_DUYET')::int AS pending FROM registration.registrations")
    ctx.body = result.rows[0]
    return
  }
  ctx.status = 404
  ctx.body = { error: 'Not found' }
})

const port = Number(process.env.PORT) || 3103
const server = app.listen(port, () => console.log(`Registration service listening on ${port}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => void pool.end()))
