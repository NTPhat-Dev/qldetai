import { createApp } from '../../shared/create-app.js'
import { createDatabasePool } from '../../shared/database.js'
import jwt from 'jsonwebtoken'
import { randomInt } from 'node:crypto'

const pool = createDatabasePool('academic')
const app = createApp({ name: 'academic', pool })
const jwtSecret = process.env.JWT_SECRET
const claims = (ctx, roles) => {
  try {
    const value = jwt.verify(ctx.get('authorization').replace(/^Bearer\s+/i, ''), jwtSecret)
    if (value.mustChangePassword || !roles.includes(value.role)) ctx.throw(403, 'Bạn không có quyền thực hiện thao tác này.')
    return value
  } catch (error) { if (error.status === 403) throw error; ctx.throw(401, 'Phiên đăng nhập hết hạn hoặc không hợp lệ.') }
}
const initials = (name) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).map((word) => word[0]).join('').slice(0, 8)

app.use(async (ctx) => {
  if (ctx.path.startsWith('/api/admin/') || ctx.path.startsWith('/api/portal/topics')) {
    const user = claims(ctx, ctx.path.startsWith('/api/portal/') ? ['GIANG_VIEN'] : ['QUAN_TRI'])
    ctx.state.user = user
  }
  if (ctx.method === 'GET' && ctx.path === '/api/admin/departments') {
    ctx.body = (await pool.query('SELECT id,code,name FROM academic.departments ORDER BY name')).rows
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/admin/departments') {
    const name = String(ctx.request.body?.name ?? '').trim()
    const prefix = initials(name)
    if (!name || !prefix) ctx.throw(400, 'Nhập tên khoa hợp lệ.')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`department:${prefix}`])
      if ((await client.query('SELECT 1 FROM academic.departments WHERE lower(name)=lower($1)', [name])).rowCount) ctx.throw(409, 'Tên khoa này đã tồn tại.')
      const number = await client.query("SELECT COALESCE(max(substring(code from length($1)+1)::bigint),0)+1 AS next FROM academic.departments WHERE code ~ ($1 || '[0-9]+$')", [prefix])
      const row = (await client.query('INSERT INTO academic.departments(code,name) VALUES($1,$2) RETURNING id,code,name', [`${prefix}${number.rows[0].next}`, name])).rows[0]
      await client.query('COMMIT'); ctx.status = 201; ctx.body = row
    } catch (error) { await client.query('ROLLBACK'); if (error.code === '23505') ctx.throw(409, 'Tên hoặc mã khoa đã tồn tại.'); throw error } finally { client.release() }
    return
  }
  const classesPath = ctx.path.match(/^\/api\/admin\/departments\/([^/]+)\/classes$/)
  if (ctx.method === 'GET' && classesPath) {
    ctx.body = (await pool.query('SELECT id,code,name FROM academic.classes WHERE department_id=$1 ORDER BY name', [classesPath[1]])).rows
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/admin/classes') {
    const { departmentId } = ctx.request.body ?? {}
    const result = await pool.query("SELECT regexp_replace(code,'[0-9]+$','') AS prefix FROM academic.departments WHERE id=$1", [departmentId])
    if (!result.rowCount) ctx.throw(400, 'Khoa đã chọn không tồn tại.')
    const prefix = result.rows[0].prefix
    const sequence = await pool.query("SELECT COALESCE(max(substring(code from '-K([0-9]+)$')::integer),0)+1 AS next FROM academic.classes WHERE department_id=$1 AND code ~ ('^' || $2 || '-K[0-9]+$')", [departmentId, prefix])
    ctx.status = 201
    ctx.body = (await pool.query('INSERT INTO academic.classes(department_id,code,name) VALUES($1,$2,$2) RETURNING id,code,name', [departmentId, `${prefix}-K${sequence.rows[0].next}`])).rows[0]
    return
  }
  if (ctx.method === 'GET' && ctx.path === '/api/admin/rounds') {
    ctx.body = (await pool.query(`SELECT r.id,r.code,r.opens_at,r.closes_at,r.is_open,
      CASE WHEN NOT r.is_open THEN 'CLOSED' WHEN clock_timestamp()<r.opens_at THEN 'SCHEDULED' WHEN clock_timestamp()>=r.closes_at THEN 'EXPIRED' ELSE 'OPEN' END AS window_state,
      s.code AS semester_code,s.name AS semester_name,s.starts_on AS semester_start,s.ends_on AS semester_end
      FROM academic.rounds r JOIN academic.semesters s ON s.id=r.semester_id ORDER BY r.opens_at DESC`)).rows
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/admin/rounds') {
    const { semesterCode, semesterName, semesterStart, semesterEnd, code, opensAt, closesAt } = ctx.request.body ?? {}
    if (![semesterCode,semesterName,semesterStart,semesterEnd,code,opensAt,closesAt].every((value) => typeof value === 'string' && value.trim())) ctx.throw(400, 'Điền đầy đủ thông tin học kỳ và đợt đăng ký.')
    if (new Date(semesterStart) >= new Date(semesterEnd) || new Date(opensAt) >= new Date(closesAt)) ctx.throw(400, 'Thời điểm kết thúc phải sau thời điểm bắt đầu.')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      let semester = await client.query('SELECT id,name,starts_on::text,ends_on::text FROM academic.semesters WHERE code=$1', [semesterCode.trim()])
      if (!semester.rowCount) semester = await client.query('INSERT INTO academic.semesters(code,name,starts_on,ends_on) VALUES($1,$2,$3,$4) RETURNING id,name,starts_on::text,ends_on::text', [semesterCode.trim(),semesterName.trim(),semesterStart,semesterEnd])
      else if (semester.rows[0].name !== semesterName.trim() || semester.rows[0].starts_on !== semesterStart || semester.rows[0].ends_on !== semesterEnd) ctx.throw(409, 'Mã học kỳ đã tồn tại với thông tin khác.')
      const round = await client.query('INSERT INTO academic.rounds(semester_id,code,opens_at,closes_at) VALUES($1,$2,$3,$4) RETURNING id,code,opens_at,closes_at,is_open', [semester.rows[0].id,code.trim(),opensAt,closesAt])
      await client.query('COMMIT'); ctx.status = 201; ctx.body = round.rows[0]
    } catch (error) { await client.query('ROLLBACK'); if (error.code === '23505') ctx.throw(409, 'Mã đợt đã tồn tại trong học kỳ này.'); throw error } finally { client.release() }
    return
  }
  const roundState = ctx.path.match(/^\/api\/admin\/rounds\/([^/]+)$/)
  if (ctx.method === 'PATCH' && roundState) {
    if (typeof ctx.request.body?.isOpen !== 'boolean') ctx.throw(400, 'Trạng thái đợt đăng ký không hợp lệ.')
    const result = await pool.query('UPDATE academic.rounds SET is_open=$1 WHERE id=$2 RETURNING id,code,is_open', [ctx.request.body.isOpen,roundState[1]])
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy đợt đăng ký.')
    ctx.body = result.rows[0]; return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/topics') {
    const { code,title,description,opensAt,closesAt,capacity } = ctx.request.body ?? {}
    if (!code?.trim() || !title?.trim() || !opensAt || !closesAt || new Date(opensAt)>=new Date(closesAt)) ctx.throw(400, 'Nhập mã, tên và thời hạn đề tài hợp lệ.')
    const profile = await fetch(`http://identity-service:3101/internal/v1/identity/users/${ctx.state.user.sub}`, { headers: { authorization: ctx.get('authorization') } }).then((response) => response.json())
    if (!profile.department_id) ctx.throw(403, 'Tài khoản chưa có khoa.')
    const result = await pool.query('INSERT INTO academic.topics(code,title,description,lecturer_id,department_id,opens_at,closes_at,capacity) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,code,title,published', [code.trim(),title.trim(),description?.trim()||null,ctx.state.user.sub,profile.department_id,opensAt,closesAt,capacity===''||capacity==null?null:Number(capacity)])
    ctx.status = 201; ctx.body = result.rows[0]; return
  }
  const publication = ctx.path.match(/^\/api\/portal\/topics\/([^/]+)\/publication$/)
  if (ctx.method === 'PATCH' && publication) {
    const { published } = ctx.request.body ?? {}
    if (typeof published !== 'boolean') ctx.throw(400, 'Trạng thái công bố không hợp lệ.')
    if (!published) {
      const active = await fetch(`http://registration-service:3103/internal/v1/registrations/topics/${publication[1]}/active`).then((response) => response.json())
      if (active.count) ctx.throw(409, 'Không thể ẩn đề tài đã có đăng ký hiệu lực.')
    }
    const result = await pool.query('UPDATE academic.topics SET published=$1 WHERE id=$2 AND lecturer_id=$3 RETURNING published', [published,publication[1],ctx.state.user.sub])
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy đề tài của giảng viên.')
    ctx.body = result.rows[0]; return
  }
  if (ctx.method === 'GET' && ctx.path === '/internal/v1/academic/departments') {
    const result = await pool.query('SELECT id, code, name FROM academic.departments ORDER BY name')
    ctx.body = result.rows
    return
  }
  if (ctx.method === 'GET' && ctx.path === '/internal/v1/academic/overview') {
    const [counts, recent] = await Promise.all([
      pool.query('SELECT count(*)::int AS topics FROM academic.topics'),
      pool.query('SELECT t.code,t.title,t.published,d.name AS department,t.created_at FROM academic.topics t JOIN academic.departments d ON d.id=t.department_id ORDER BY t.created_at DESC LIMIT 6'),
    ])
    ctx.body = { stats: { topics: counts.rows[0].topics }, recentTopics: recent.rows }
    return
  }
  if (ctx.method === 'GET' && ctx.path === '/internal/v1/academic/student-topics') {
    const result = await pool.query(`SELECT t.id,t.code,t.title,t.description,t.lecturer_id,t.department_id,t.opens_at,t.closes_at,t.capacity,
      d.name AS department,r.id AS round_id,r.code AS round_code,
      GREATEST(t.opens_at,r.opens_at,COALESCE(w.opens_at,'-infinity'::timestamptz)) AS effective_opens_at,
      LEAST(t.closes_at,r.closes_at,COALESCE(w.closes_at,'infinity'::timestamptz)) AS effective_closes_at
      FROM academic.topics t JOIN academic.departments d ON d.id=t.department_id JOIN academic.rounds r ON r.is_open
      LEFT JOIN academic.topic_round_windows w ON w.topic_id=t.id AND w.round_id=r.id
      WHERE t.published AND (w.topic_id IS NULL OR w.allowed)
      AND clock_timestamp()>=GREATEST(t.opens_at,r.opens_at,COALESCE(w.opens_at,'-infinity'::timestamptz))
      AND clock_timestamp()<LEAST(t.closes_at,r.closes_at,COALESCE(w.closes_at,'infinity'::timestamptz)) ORDER BY t.created_at DESC LIMIT 100`)
    ctx.body = result.rows
    return
  }
  const lecturerTopics = ctx.path.match(/^\/internal\/v1\/academic\/lecturers\/([0-9a-f-]+)\/topics$/i)
  if (ctx.method === 'GET' && lecturerTopics) {
    const topics = (await pool.query('SELECT id,code,title,description,published,opens_at,closes_at,capacity FROM academic.topics WHERE lecturer_id=$1 ORDER BY created_at DESC', [lecturerTopics[1]])).rows
    ctx.body = await Promise.all(topics.map(async (topic) => {
      const counts = await fetch(`http://registration-service:3103/internal/v1/registrations/topics/${topic.id}/counts`).then((response) => response.json()).catch(() => ({ pending: 0, registered: 0 }))
      return { ...topic, ...counts }
    }))
    return
  }
  const internalClasses = ctx.path.match(/^\/internal\/v1\/academic\/departments\/([^/]+)\/classes$/)
  if (ctx.method === 'GET' && internalClasses) {
    ctx.body = (await pool.query('SELECT id,code,name FROM academic.classes WHERE department_id=$1 ORDER BY name', [internalClasses[1]])).rows
    return
  }
  const topicMatch = ctx.path.match(/^\/internal\/v1\/academic\/topics\/([0-9a-f-]+)$/i)
  if (ctx.method === 'GET' && topicMatch) {
    const result = await pool.query(
      'SELECT id, code, title, lecturer_id, department_id, opens_at, closes_at, capacity, published FROM academic.topics WHERE id=$1',
      [topicMatch[1]],
    )
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy đề tài.')
    ctx.body = result.rows[0]
    return
  }
  const roundMatch = ctx.path.match(/^\/internal\/v1\/academic\/rounds\/([0-9a-f-]+)$/i)
  if (ctx.method === 'GET' && roundMatch) {
    const result = await pool.query('SELECT r.id,r.code,r.opens_at,r.closes_at,r.is_open,s.code AS semester_code,s.name AS semester_name FROM academic.rounds r JOIN academic.semesters s ON s.id=r.semester_id WHERE r.id=$1', [roundMatch[1]])
    if (!result.rowCount) ctx.throw(404, 'Không tìm thấy đợt đăng ký.')
    ctx.body = result.rows[0]
    return
  }
  ctx.status = 404
  ctx.body = { error: 'Not found' }
})

const port = Number(process.env.PORT) || 3102
const server = app.listen(port, () => console.log(`Academic service listening on ${port}`))
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => void pool.end()))
