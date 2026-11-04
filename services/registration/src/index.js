import { createApp } from '../../shared/create-app.js'
import { createDatabasePool } from '../../shared/database.js'
import { createServiceFetch } from '../../shared/service-client.js'
import { migrate } from '../../shared/migrations.js'
import { authorize } from '../../shared/authorize.js'
import { randomUUID } from 'node:crypto'

const pool = createDatabasePool('registration')
await migrate(pool, 'registration')
const fetch = createServiceFetch('registration')
const app = createApp({ name: 'registration', pool })
const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
const history = `(SELECT COALESCE(json_agg(json_build_object('old_status',h.old_status,'new_status',h.new_status,'changed_at',h.changed_at,'note',h.note) ORDER BY h.id),'[]') FROM registration.history h WHERE h.registration_id=r.id)`
const sameRequest = (row, studentId, topicId, roundId, reason) => row.student_id === studentId && row.topic_id === topicId && row.round_id === roundId && row.reason === reason
const lock = (client, scope, id) => client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${scope}:${id}`])

app.use(async (ctx) => {
  if (ctx.path.startsWith('/api/')) ctx.state.user = await authorize(ctx, ctx.path.startsWith('/api/admin/') ? ['QUAN_TRI'] : ['SINH_VIEN','GIANG_VIEN'], fetch)
  if (ctx.method === 'GET' && ctx.path === '/api/admin/registrations') {
    ctx.body = (await pool.query(`SELECT r.*,r.decision_note AS note,${history} AS history FROM registration.registrations r ORDER BY r.submitted_at DESC LIMIT 500`)).rows
    return
  }
  if (ctx.method === 'GET' && ctx.path === '/api/portal/overview') {
    const user = ctx.state.profile
    if (user.role === 'SINH_VIEN') {
      const [available, own, clock] = await Promise.all([
        fetch('http://academic-service:3102/internal/v1/academic/student-topics').then((response) => response.json()),
        pool.query(`SELECT r.id,r.round_id,r.topic_code AS code,r.topic_title AS title,r.status,r.reason,r.decision_note AS note,r.submitted_at,${history} AS history FROM registration.registrations r WHERE r.student_id=$1 ORDER BY r.submitted_at DESC LIMIT 100`, [user.id]),
        pool.query('SELECT clock_timestamp() AS server_time'),
      ])
      const topics = await Promise.all(available.map(async (topic) => {
        const [lecturer, counts] = await Promise.all([
          fetch(`http://identity-service:3101/internal/v1/identity/users/${topic.lecturer_id}`).then((response) => response.json()),
          pool.query("SELECT count(*) FILTER (WHERE status='CHO_DUYET')::int AS pending,count(*) FILTER (WHERE status IN ('CHO_DUYET','DA_DUYET'))::int AS registered FROM registration.registrations WHERE topic_id=$1 AND round_id=$2", [topic.id,topic.round_id]),
        ])
        return { ...topic, opens_at: topic.effective_opens_at, closes_at: topic.effective_closes_at, lecturer: lecturer.display_name, ...counts.rows[0] }
      }))
      ctx.body = { role: user.role, profile: { ho_ten: user.display_name, ma_sinh_vien: user.profile_code, lop: user.class_name }, topics, registrations: own.rows, serverTime: clock.rows[0].server_time }
      return
    }
    const [topics, clock, rows, counts] = await Promise.all([
      fetch(`http://academic-service:3102/internal/v1/academic/lecturers/${user.id}/topics`).then((response) => response.json()),
      pool.query('SELECT clock_timestamp() AS server_time'),
      pool.query(`SELECT r.*,r.decision_note AS note,${history} AS history
        FROM registration.registrations r
        WHERE (r.lecturer_id=$1 OR r.lecturer_id IS NULL)
          AND r.status != 'DA_HUY'
          AND NOT EXISTS (
            SELECT 1 FROM registration.admission_blocks b
            WHERE (b.scope='rounds' AND b.entity_id=r.round_id)
               OR (b.scope='topics' AND b.entity_id=r.topic_id)
          )
        ORDER BY r.submitted_at DESC LIMIT 500`, [user.id]),
      pool.query("SELECT topic_id,count(*) FILTER (WHERE status='CHO_DUYET')::int AS pending,count(*) FILTER (WHERE status IN ('CHO_DUYET','DA_DUYET'))::int AS registered FROM registration.registrations GROUP BY topic_id"),
    ])
    const owned = new Set(topics.map((topic) => topic.id))
    const visible = rows.rows.filter((row) => owned.has(row.topic_id)).map((row) => ({ ...row, student_code: row.student_code, student_name: row.student_name }))
    ctx.body = { role: user.role, profile: { ho_ten: user.display_name, ma_giang_vien: user.profile_code }, topics: topics.map((topic) => ({ ...topic,...counts.rows.find((row) => row.topic_id===topic.id) })), registrations: visible, serverTime: clock.rows[0].server_time }
    return
  }
  if (ctx.method === 'POST' && ctx.path === '/api/portal/registrations') {
    if (ctx.state.user.role !== 'SINH_VIEN') ctx.throw(403, 'Chỉ sinh viên được gửi đăng ký.')
    const { topicId,roundId } = ctx.request.body ?? {}
    const reason = typeof ctx.request.body?.reason === 'string' ? ctx.request.body.reason.trim() || null : null
    const requestId = ctx.request.body?.requestId ?? randomUUID()
    if (!uuid(requestId) || !uuid(topicId) || !uuid(roundId) || (reason?.length ?? 0)>2000) ctx.throw(400, 'Thông tin yêu cầu đăng ký không hợp lệ.')
    const previous = await pool.query('SELECT * FROM registration.registrations WHERE id=$1', [requestId])
    if (previous.rowCount) {
      if (!sameRequest(previous.rows[0],ctx.state.user.sub,topicId,roundId,reason)) ctx.throw(409, 'Mã yêu cầu đã được sử dụng cho nội dung khác.')
      ctx.body = { id: previous.rows[0].id,status: previous.rows[0].status }; return
    }
    const available = await fetch('http://academic-service:3102/internal/v1/academic/student-topics').then((response) => response.json())
    const topic = available.find((row) => row.id===topicId && row.round_id===roundId)
    if (!topic) ctx.throw(409, 'Đề tài không còn nhận đăng ký trong đợt đã chọn.')
    const user = ctx.state.profile
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await lock(client,'round',roundId)
      await lock(client,'topic',topicId)
      const replay = await client.query('SELECT * FROM registration.registrations WHERE id=$1', [requestId])
      if (replay.rowCount) {
        if (!sameRequest(replay.rows[0],user.id,topicId,roundId,reason)) ctx.throw(409, 'Mã yêu cầu đã được sử dụng cho nội dung khác.')
        await client.query('COMMIT'); ctx.body = { id: replay.rows[0].id,status: replay.rows[0].status }; return
      }
      const blocked = await client.query("SELECT 1 FROM registration.admission_blocks WHERE (scope='topics' AND entity_id=$1) OR (scope='rounds' AND entity_id=$2)", [topicId,roundId])
      if (blocked.rowCount) ctx.throw(409, 'Đề tài hoặc đợt đăng ký đã đóng.')
      // Recheck the DB clock after acquiring locks; requests waiting for the last seat
      // cannot enter after the admission window has ended.
      const window = await client.query('SELECT clock_timestamp()>=$1::timestamptz AND clock_timestamp()<$2::timestamptz AS allowed', [topic.effective_opens_at,topic.effective_closes_at])
      if (!window.rows[0].allowed) ctx.throw(409, 'Đã ngoài thời gian nhận đăng ký.')
      const existing = await client.query("SELECT 1 FROM registration.registrations WHERE student_id=$1 AND round_id=$2 AND status IN ('CHO_DUYET','DA_DUYET')", [user.id,roundId])
      if (existing.rowCount) ctx.throw(409, 'Bạn đã có đăng ký hiệu lực trong đợt này.')
      const count = await client.query("SELECT count(*)::int AS total FROM registration.registrations WHERE topic_id=$1 AND round_id=$2 AND status IN ('CHO_DUYET','DA_DUYET')", [topicId,roundId])
      if (count.rows[0].total>=topic.capacity) ctx.throw(409, 'Đề tài đã đủ số lượng.')
      const result = await client.query(`INSERT INTO registration.registrations(id,student_id,topic_id,round_id,topic_code,topic_title,student_code,student_name,round_code,reason,lecturer_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id,status`, [requestId,user.id,topicId,roundId,topic.code,topic.title,user.profile_code,user.display_name,topic.round_code,reason,topic.lecturer_id])
      await client.query('COMMIT'); ctx.status=201; ctx.body=result.rows[0]
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); if (error.code==='23505') ctx.throw(409,'Bạn đã có đăng ký hiệu lực trong đợt hoặc mã yêu cầu đã được sử dụng.'); throw error }
    finally { client.release() }
    return
  }
  const cancel=ctx.path.match(/^\/api\/portal\/registrations\/([0-9a-f-]+)\/cancel$/i)
  if (ctx.method==='PATCH' && cancel) {
    if (ctx.state.user.role!=='SINH_VIEN') ctx.throw(403,'Chỉ sinh viên được hủy đơn.')
    const result=await pool.query("UPDATE registration.registrations SET status='DA_HUY',decision_note='Sinh viên hủy đăng ký',decided_at=now(),decided_by=$1 WHERE id=$2 AND student_id=$1 AND status='CHO_DUYET' RETURNING id,status", [ctx.state.user.sub,cancel[1]])
    if (!result.rowCount) ctx.throw(409,'Không tìm thấy đơn chờ duyệt của bạn.')
    ctx.body=result.rows[0]; return
  }
  const decision=ctx.path.match(/^\/api\/portal\/registrations\/([0-9a-f-]+)\/decision$/i)
  if (ctx.method==='PATCH' && decision) {
    if (ctx.state.user.role!=='GIANG_VIEN') ctx.throw(403,'Chỉ giảng viên được xử lý đơn.')
    const {status,note}=ctx.request.body ?? {}
    if (!['DA_DUYET','TU_CHOI'].includes(status) || (status==='TU_CHOI' && (typeof note!=='string' || !note.trim())) || (typeof note==='string' && note.length>2000)) ctx.throw(400,'Chọn trạng thái hợp lệ và nhập lý do khi từ chối.')
    const row=await pool.query("SELECT topic_id,lecturer_id FROM registration.registrations WHERE id=$1 AND status='CHO_DUYET'",[decision[1]])
    if (!row.rowCount) ctx.throw(409,'Đơn đã được xử lý hoặc không tồn tại.')
    const owner=row.rows[0].lecturer_id ?? (await fetch(`http://academic-service:3102/internal/v1/academic/topics/${row.rows[0].topic_id}`).then((response)=>response.json())).lecturer_id
    if (owner!==ctx.state.user.sub) ctx.throw(403,'Đơn không thuộc đề tài bạn hướng dẫn.')
    const result=await pool.query("UPDATE registration.registrations SET status=$1,decision_note=$2,decided_at=now(),decided_by=$3 WHERE id=$4 AND status='CHO_DUYET' RETURNING id,status,decision_note AS note,decided_at",[status,typeof note==='string'?note.trim()||null:null,ctx.state.user.sub,decision[1]])
    if (!result.rowCount) ctx.throw(409,'Đơn đã được xử lý bởi yêu cầu khác.')
    ctx.body=result.rows[0]; return
  }
  const admission=ctx.path.match(/^\/internal\/v1\/registrations\/admission\/(topics|rounds)\/([0-9a-f-]+)$/i)
  if (ctx.method==='POST' && admission) {
    if (ctx.state.service.service!=='academic') ctx.throw(403,'Chỉ dịch vụ học vụ được điều chỉnh tiếp nhận.')
    const closed=ctx.request.body?.closed
    if (typeof closed!=='boolean' || !uuid(admission[2])) ctx.throw(400,'Trạng thái tiếp nhận không hợp lệ.')
    const client=await pool.connect()
    try {
      await client.query('BEGIN')
      await lock(client,admission[1]==='topics'?'topic':'round',admission[2])
      if (closed && admission[1]==='topics') {
        const active=await client.query("SELECT 1 FROM registration.registrations WHERE topic_id=$1 AND status IN ('CHO_DUYET','DA_DUYET') LIMIT 1",[admission[2]])
        if (active.rowCount) ctx.throw(409,'Không thể ẩn đề tài đã có đăng ký hiệu lực.')
      }
      if (closed) await client.query('INSERT INTO registration.admission_blocks(scope,entity_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[admission[1],admission[2]])
      else await client.query('DELETE FROM registration.admission_blocks WHERE scope=$1 AND entity_id=$2',[admission[1],admission[2]])
      await client.query('COMMIT'); ctx.body={closed}
    } catch (error) { await client.query('ROLLBACK').catch(()=>{}); throw error } finally {client.release()}
    return
  }
  const counts=ctx.path.match(/^\/internal\/v1\/registrations\/topics\/([0-9a-f-]+)\/(counts|active)$/i)
  if (ctx.method==='GET' && counts) {
    const result=await pool.query("SELECT count(*) FILTER (WHERE status='CHO_DUYET')::int AS pending,count(*) FILTER (WHERE status IN ('CHO_DUYET','DA_DUYET'))::int AS registered FROM registration.registrations WHERE topic_id=$1",[counts[1]])
    ctx.body=counts[2]==='active'?{count:result.rows[0].registered}:result.rows[0]; return
  }
  if (ctx.method==='GET' && ['/internal/v1/registrations/overview','/internal/v1/registrations/health-summary'].includes(ctx.path)) {
    ctx.body=(await pool.query("SELECT count(*) FILTER (WHERE status='CHO_DUYET')::int AS pending,count(*)::int AS total FROM registration.registrations")).rows[0]; return
  }
  ctx.status=404; ctx.body={error:'Không tìm thấy chức năng.'}
})

const port=Number(process.env.PORT)||3103
const server=app.listen(port,()=>console.log(`Registration service listening on ${port}`))
for (const signal of ['SIGINT','SIGTERM']) process.once(signal,()=>server.close(()=>void pool.end()))
