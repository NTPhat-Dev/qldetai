import { Pool } from 'pg'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()
try {
  await client.query('BEGIN')
  let created = 0
  for (const department of data.departments) {
    const result = await client.query('INSERT INTO academic.departments(id,code,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [department.id, department.code, department.name])
    created += result.rowCount
  }
  for (const classroom of data.classes) {
    const result = await client.query('INSERT INTO academic.classes(id,department_id,code,name) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING', [classroom.id, classroom.departmentId, classroom.code, classroom.name])
    created += result.rowCount
  }
  const semester = data.semester
  created += (await client.query('INSERT INTO academic.semesters(id,code,name,starts_on,ends_on) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING', [semester.id, semester.code, semester.name, semester.start, semester.end])).rowCount
  const round = data.round
  created += (await client.query('INSERT INTO academic.rounds(id,semester_id,code,opens_at,closes_at,is_open) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(id) DO NOTHING', [round.id, round.semesterId, round.code, round.opensAt, round.closesAt])).rowCount
  for (const topic of data.topics) {
    created += (await client.query(`INSERT INTO academic.topics
      (id,code,title,description,lecturer_id,department_id,opens_at,closes_at,capacity,published)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
      [topic.id, topic.code, topic.title, topic.description, topic.lecturerId, topic.departmentId, topic.opensAt, topic.closesAt, topic.capacity, topic.published])).rowCount
    created += (await client.query(`INSERT INTO academic.topic_round_windows(topic_id,round_id,opens_at,closes_at,allowed)
      VALUES($1,$2,$3,$4,true) ON CONFLICT(topic_id,round_id) DO NOTHING`,
      [topic.id, round.id, topic.opensAt, topic.closesAt])).rowCount
  }
  await client.query('COMMIT')
  console.log(JSON.stringify({ created }))
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  client.release()
  await pool.end()
}
