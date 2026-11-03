import { createApp } from '../../shared/create-app.js'
import { createDatabasePool } from '../../shared/database.js'
import { createServiceFetch } from '../../shared/service-client.js'
import { migrate } from '../../shared/migrations.js'
import { authorize } from '../../shared/authorize.js'
import { randomBytes } from 'node:crypto'

const pool = createDatabasePool('academic')
await migrate(pool, 'academic')
const fetch = createServiceFetch('academic')
const app = createApp({ name: 'academic', pool })
const normalizedName = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g,'d').toLowerCase().replace(/\s+/g,' ').trim()
const fence = (scope,id,closed) => fetch(`http://registration-service:3103/internal/v1/registrations/admission/${scope}/${id}`, { method: 'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify({closed}) })
async function policyChange(scope,id,change) {
  const client = await pool.connect()
  let damaged = false
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [`policy:${scope}:${id}`])
    return await change(client)
  } finally {
    try { await client.query('SELECT pg_advisory_unlock(hashtext($1))', [`policy:${scope}:${id}`]) } catch { damaged = true }
    client.release(damaged)
  }
}
const initials = (name) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[đĐ]/g, 'd').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean).map((word) => word[0]).join('').slice(0, 8)

app.use(async (ctx) => {
  if (ctx.path.startsWith('/api/admin/') || ctx.path.startsWith('/api/portal/topics') || ctx.path === '/api/portal/rounds') {
    const user = await authorize(ctx, ctx.path.startsWith('/api/portal/') ? ['GIANG_VIEN'] : ['QUAN_TRI'], fetch)
    ctx.state.user = user
  }
  if (ctx.method === 'GET' && ctx.path === '/api/portal/rounds') {
    ctx.body = (await pool.query(`SELECT r.id,r.code,r.opens_at,r.closes_at,r.is_open,s.code AS semester_code,s.name AS semester_name,s.starts_on AS semester_start,s.ends_on AS semester_end
      FROM academic.rounds r JOIN academic.semesters s ON s.id=r.semester_id
      WHERE r.closes_at>clock_timestamp() ORDER BY r.opens_at DESC`)).rows
    return
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
      if ((await client.query('SELECT name FROM academic.departments')).rows.some((row) => normalizedName(row.name) === normalizedName(name))) ctx.throw(409, 'Tên khoa này đã tồn tại.')
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
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`class:${prefix}`])
      const sequence = await client.query("SELECT COALESCE(max(substring(code from '-K([0-9]+)$')::integer),0)+1 AS next FROM academic.classes WHERE code ~ ('^' || $1 || '-K[0-9]+$')", [prefix])
      ctx.body = (await client.query('INSERT INTO academic.classes(department_id,code,name) VALUES($1,$2,$2) RETURNING id,code,name', [departmentId, `${prefix}-K${sequence.rows[0].next}`])).rows[0]
      await client.query('COMMIT'); ctx.status = 201
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error } finally { client.release() }
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
    let { semesterNumber, semesterStart, semesterEnd, opensAt, closesAt } = ctx.request.body ?? {}
    const semester = Number(semesterNumber)
    const semesterDatesValid = typeof semesterStart === 'string' && typeof semesterEnd === 'string'
      && Number.isFinite(Date.parse(semesterStart)) && Number.isFinite(Date.parse(semesterEnd))
    if (!opensAt && semesterDatesValid) opensAt = new Date(`${semesterStart}T00:00:00+07:00`).toISOString()
    if (!closesAt && semesterDatesValid) closesAt = new Date(`${semesterEnd}T23:59:59.999+07:00`).toISOString()
    const roundDatesValid = typeof opensAt === 'string' && typeof closesAt === 'string'
      && Number.isFinite(Date.parse(opensAt)) && Number.isFinite(Date.parse(closesAt))
    if (![1,2].includes(semester) || !semesterDatesValid || !roundDatesValid) ctx.throw(400, 'Chọn học kỳ và điền đầy đủ thời gian hợp lệ.')
    const semStartDate = new Date(`${semesterStart}T00:00:00+07:00`).getTime()
    const semEndDate = new Date(`${semesterEnd}T23:59:59.999+07:00`).getTime()
    const openDate = new Date(opensAt).getTime()
    const closeDate = new Date(closesAt).getTime()
    if (semStartDate >= semEndDate) { ctx.throw(400, 'Ngày bắt đầu học kỳ phải trước ngày kết thúc học kỳ.') }
    if (openDate >= closeDate) { ctx.throw(400, 'Thời gian đóng nhận đăng ký phải sau thời gian mở') }
    if (openDate < semStartDate) { ctx.throw(400, 'Thời gian mở nhận đăng ký phải sau ngày bắt đầu học kỳ' )}
    if (closeDate > semEndDate) { ctx.throw(400, 'Thời gian đóng đăng ký phải trước ngày kết thúc học kỳ.') }
    const calendarStartYear = new Date(`${semesterStart}T00:00:00Z`).getUTCFullYear()
    const calendarEndYear = new Date(`${semesterEnd}T00:00:00Z`).getUTCFullYear()
    const schoolYearStart = semester === 1 ? calendarStartYear : calendarEndYear - 1
    const semesterName = `Học kỳ ${semester} năm học ${schoolYearStart}-${schoolYearStart + 1}`
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`semester:${semester}:${semesterStart}:${semesterEnd}`])
      let semesterRow = await client.query("SELECT id FROM academic.semesters WHERE starts_on=$1 AND ends_on=$2 AND name ILIKE $3", [semesterStart,semesterEnd,`Học kỳ ${semester}%`])
      if (!semesterRow.rowCount) {
        const semesterCode = `HK-${randomBytes(8).toString('hex').toUpperCase()}`
        semesterRow = await client.query('INSERT INTO academic.semesters(code,name,starts_on,ends_on) VALUES($1,$2,$3,$4) RETURNING id', [semesterCode,semesterName,semesterStart,semesterEnd])
      }
      const roundCode = `DOT-${randomBytes(8).toString('hex').toUpperCase()}`
      const round = await client.query('INSERT INTO academic.rounds(semester_id,code,opens_at,closes_at) VALUES($1,$2,$3,$4) RETURNING id,code,opens_at,closes_at,is_open', [semesterRow.rows[0].id,roundCode,opensAt,closesAt])
      await client.query('COMMIT'); ctx.status = 201; ctx.body = round.rows[0]
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code === '23505') ctx.throw(409, 'Mã tự sinh bị trùng. Hãy thử tạo lại đợt.'); throw error } finally { client.release() }
    return
  }
  const roundState = ctx.path.match(/^\/api\/admin\/rounds\/([^/]+)$/)
  if (ctx.method === 'PATCH' && roundState) {
    if (typeof ctx.request.body?.isOpen !== 'boolean') ctx.throw(400, 'Trạng thái đợt đăng ký không hợp lệ.')
    ctx.body = await policyChange('round',roundState[1],async (client) => {
      if (!(await client.query('SELECT id FROM academic.rounds WHERE id=$1', [roundState[1]])).rowCount) ctx.throw(404, 'Không tìm thấy đợt đăng ký.')
      if (!ctx.request.body.isOpen) await fence('rounds',roundState[1],true)
      const result = await client.query('UPDATE academic.rounds SET is_open=$1 WHERE id=$2 RETURNING id,code,is_open', [ctx.request.body.isOpen,roundState[1]])
      if (ctx.request.body.isOpen) await fence('rounds',roundState[1],false)
      return result.rows[0]
    }); return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/topics') {
    const { title,description,roundId,capacity,opensAt,closesAt } = ctx.request.body ?? {}
    const numericCapacity = Number(capacity)
    if (typeof title !== 'string' || !title.trim() || title.length > 240 || (typeof description === 'string' && description.length > 10000) || typeof roundId !== 'string') ctx.throw(400, 'Nhập tên đề tài và chọn đợt đăng ký.')
    if (capacity == null || String(capacity).trim() === '' || !Number.isSafeInteger(numericCapacity) || numericCapacity < 1) ctx.throw(400, 'Số lượng phải là số nguyên từ 1 trở lên.')
    const roundResult = await pool.query('SELECT r.id,r.code,r.opens_at,r.closes_at,s.starts_on,s.ends_on FROM academic.rounds r JOIN academic.semesters s ON s.id=r.semester_id WHERE r.id=$1 AND r.closes_at>clock_timestamp()', [roundId])
    if (!roundResult.rowCount) ctx.throw(400, 'Đợt đăng ký không tồn tại hoặc đã hết hạn.')
    let topicOpensAt = roundResult.rows[0].opens_at
    let topicClosesAt = roundResult.rows[0].closes_at
    if (opensAt || closesAt) {
      if (!opensAt || !closesAt) ctx.throw(400, 'Vui lòng điền đầy đủ thời gian mở và đóng nhận đăng ký.')
      const oDate = new Date(opensAt).getTime()
      const cDate = new Date(closesAt).getTime()
      if (isNaN(oDate) || isNaN(cDate)) ctx.throw(400, 'Thời gian nhận đăng ký không hợp lệ.')
      if (oDate >= cDate) ctx.throw(400, 'Thời gian đóng nhận đăng ký phải sau thời gian mở.')
      const semStart = new Date(`${roundResult.rows[0].starts_on}T00:00:00+07:00`).getTime()
      const semEnd = new Date(`${roundResult.rows[0].ends_on}T23:59:59.999+07:00`).getTime()
      if (oDate < semStart) ctx.throw(400, 'Thời gian mở nhận đăng ký phải sau ngày bắt đầu học kỳ.')
      if (cDate > semEnd) ctx.throw(400, 'Thời gian đóng nhận đăng ký phải trước ngày kết thúc học kỳ.')
      topicOpensAt = new Date(opensAt).toISOString()
      topicClosesAt = new Date(closesAt).toISOString()
    }
    const profile = await fetch(`http://identity-service:3101/internal/v1/identity/users/${ctx.state.user.sub}`, { headers: { authorization: ctx.get('authorization') } }).then((response) => response.json())
    if (!profile.department_id) ctx.throw(403, 'Tài khoản chưa có khoa.')
    let result
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = `DE-${randomBytes(6).toString('hex').toUpperCase()}`
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        result = await client.query('INSERT INTO academic.topics(code,title,description,lecturer_id,department_id,opens_at,closes_at,capacity) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id,code,title,published', [code,title.trim(),typeof description === 'string' ? description.trim() || null : null,ctx.state.user.sub,profile.department_id,topicOpensAt,topicClosesAt,numericCapacity])
        await client.query('INSERT INTO academic.topic_round_windows(topic_id,round_id,opens_at,closes_at,allowed) VALUES($1,$2,$3,$4,true)', [result.rows[0].id,roundResult.rows[0].id,topicOpensAt,topicClosesAt])
        await client.query('COMMIT')
        break
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {})
        if (error.code !== '23505' || attempt === 4) throw error
      } finally { client.release() }
    }
    ctx.status = 201; ctx.body = result.rows[0]; return
  }
  const editTopic = ctx.path.match(/^\/api\/portal\/topics\/([0-9a-f-]+)$/i)
  if (ctx.method === 'PATCH' && editTopic) {
    const { title,description,capacity,opensAt,closesAt } = ctx.request.body ?? {}
    if (typeof title !== 'string' || !title.trim() || title.length > 240 || !Number.isSafeInteger(Number(capacity)) || Number(capacity)<1 || typeof description !== 'string' || description.length>10000) ctx.throw(400, 'Nhập tên, mô tả và số lượng hợp lệ.')
    ctx.body = await policyChange('topic',editTopic[1],async (client) => {
    const own = await client.query('SELECT t.id,t.published,t.opens_at,t.closes_at,s.starts_on,s.ends_on FROM academic.topics t LEFT JOIN academic.topic_round_windows w ON w.topic_id=t.id LEFT JOIN academic.rounds r ON r.id=w.round_id LEFT JOIN academic.semesters s ON s.id=r.semester_id WHERE t.id=$1 AND t.lecturer_id=$2', [editTopic[1],ctx.state.user.sub])
    if (!own.rowCount) ctx.throw(404,'Không tìm thấy đề tài của bạn.')
    if (own.rows[0].published) ctx.throw(409,'Chỉ được sửa đề tài ở trạng thái bản nháp.')
    let topicOpensAt = own.rows[0].opens_at
    let topicClosesAt = own.rows[0].closes_at
    if (opensAt && closesAt) {
      const oDate = new Date(opensAt).getTime()
      const cDate = new Date(closesAt).getTime()
      if (isNaN(oDate) || isNaN(cDate) || oDate >= cDate) ctx.throw(400, 'Thời gian nhận đăng ký không hợp lệ.')
      if (own.rows[0].starts_on && oDate < new Date(`${own.rows[0].starts_on}T00:00:00+07:00`).getTime()) ctx.throw(400, 'Thời gian mở nhận đăng ký phải sau ngày bắt đầu học kỳ.')
      if (own.rows[0].ends_on && cDate > new Date(`${own.rows[0].ends_on}T23:59:59.999+07:00`).getTime()) ctx.throw(400, 'Thời gian đóng nhận đăng ký phải trước ngày kết thúc học kỳ.')
      topicOpensAt = new Date(opensAt).toISOString()
      topicClosesAt = new Date(closesAt).toISOString()
    }
    await fence('topics',editTopic[1],true)
    const result = await client.query('UPDATE academic.topics SET title=$1,description=$2,capacity=$3,opens_at=$4,closes_at=$5 WHERE id=$6 AND lecturer_id=$7 AND NOT published RETURNING id,code,title,description,capacity,opens_at,closes_at,published', [title.trim(),description.trim()||null,Number(capacity),topicOpensAt,topicClosesAt,editTopic[1],ctx.state.user.sub])
    await client.query('UPDATE academic.topic_round_windows SET opens_at=$1,closes_at=$2 WHERE topic_id=$3', [topicOpensAt,topicClosesAt,editTopic[1]])
    if (!result.rowCount) ctx.throw(409,'Trạng thái đề tài đã thay đổi. Hãy tải lại.')
    return result.rows[0]
    }); return
  }
  const publication = ctx.path.match(/^\/api\/portal\/topics\/([^/]+)\/publication$/)
  if (ctx.method === 'PATCH' && publication) {
    const { published } = ctx.request.body ?? {}
    if (typeof published !== 'boolean') ctx.throw(400, 'Trạng thái công bố không hợp lệ.')
    ctx.body = await policyChange('topic',publication[1],async (client) => {
    const owned = await client.query('SELECT id FROM academic.topics WHERE id=$1 AND lecturer_id=$2', [publication[1],ctx.state.user.sub])
    if (!owned.rowCount) ctx.throw(404, 'Không tìm thấy đề tài của giảng viên.')
    if (!published) await fence('topics',publication[1],true)
    const result = await client.query('UPDATE academic.topics SET published=$1 WHERE id=$2 AND lecturer_id=$3 RETURNING published', [published,publication[1],ctx.state.user.sub])
    if (published) await fence('topics',publication[1],false)
    return result.rows[0]
    }); return
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
      WHERE t.published AND (
        NOT EXISTS (SELECT 1 FROM academic.topic_round_windows scoped WHERE scoped.topic_id=t.id)
        OR (w.topic_id IS NOT NULL AND w.allowed)
      )
      AND clock_timestamp()>=GREATEST(t.opens_at,r.opens_at,COALESCE(w.opens_at,'-infinity'::timestamptz))
      AND clock_timestamp()<LEAST(t.closes_at,r.closes_at,COALESCE(w.closes_at,'infinity'::timestamptz)) ORDER BY t.created_at DESC LIMIT 100`)
    ctx.body = result.rows
    return
  }
  const lecturerTopics = ctx.path.match(/^\/internal\/v1\/academic\/lecturers\/([0-9a-f-]+)\/topics$/i)
  if (ctx.method === 'GET' && lecturerTopics) {
    const topics = (await pool.query(`SELECT t.id,t.code,t.title,t.description,t.published,t.opens_at,t.closes_at,t.capacity,
      (SELECT string_agg(r.code, ', ' ORDER BY r.opens_at) FROM academic.topic_round_windows w JOIN academic.rounds r ON r.id=w.round_id WHERE w.topic_id=t.id) AS round_codes
      FROM academic.topics t WHERE t.lecturer_id=$1 ORDER BY t.created_at DESC`, [lecturerTopics[1]])).rows
    ctx.body = topics
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
