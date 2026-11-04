import { Pool } from 'pg'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()
try {
  await client.query('BEGIN')
  let created = 0
  for (const registration of data.registrations) {
    const { student, topic } = registration
    const result = await client.query(`INSERT INTO registration.registrations
      (id,student_id,topic_id,round_id,topic_code,topic_title,student_code,student_name,round_code,reason,lecturer_id,submitted_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [registration.id, student.id, topic.id, registration.roundId, topic.code, topic.title,
        student.profileCode, student.name, registration.roundCode, registration.reason, topic.lecturerId, registration.submittedAt])
    if (!result.rowCount) continue
    created += 1
    if (registration.status !== 'CHO_DUYET') {
      await client.query(`UPDATE registration.registrations SET status=$1,decision_note=$2,decided_at=now(),decided_by=$3 WHERE id=$4`,
        [registration.status, registration.note, registration.status === 'DA_HUY' ? student.id : topic.lecturerId, registration.id])
    }
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
