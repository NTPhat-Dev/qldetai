import { Pool } from 'pg'
import argon2 from 'argon2'

const chunks = []
for await (const chunk of process.stdin) chunks.push(chunk)
const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
const pool = new Pool({ connectionString: process.env.DATABASE_URL })
const client = await pool.connect()
try {
  await client.query('BEGIN')
  const adminExists = (await client.query("SELECT 1 FROM identity.users WHERE role='QUAN_TRI' LIMIT 1")).rowCount > 0
  const accounts = [
    ...(!adminExists ? [{ ...data.admin, role: 'QUAN_TRI', profileCode: 'ADMIN', mustChangePassword: true }] : []),
    ...data.lecturers.map((account) => ({ ...account, role: 'GIANG_VIEN' })),
    ...data.students.map((account) => ({ ...account, role: 'SINH_VIEN' })),
  ]
  let created = 0
  const createdAccounts = []
  for (const account of accounts) {
    const matching = await client.query('SELECT id,username FROM identity.users WHERE id=$1 OR username=$2', [account.id, account.username])
    if (matching.rows.some((row) => row.id !== account.id || row.username !== account.username)) {
      throw new Error(`Tài khoản ${account.username} đã có nhưng không thuộc bộ dữ liệu demo.`)
    }
    if (matching.rowCount) continue
    const passwordHash = await argon2.hash(data.password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32 })
    const result = await client.query(`INSERT INTO identity.users
      (id,username,password_hash,role,status,must_change_password,display_name,profile_code,department_id,class_id,class_name,academic_title,degree,specialization)
      VALUES($1,$2,$3,$4,'HOAT_DONG',$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT(id) DO NOTHING RETURNING id`,
      [account.id, account.username, passwordHash, account.role, Boolean(account.mustChangePassword), account.name,
        account.profileCode, account.departmentId ?? null, account.classId ?? null, account.className ?? null,
        account.role === 'GIANG_VIEN' ? 'Giảng viên' : null, account.degree ?? null, account.specialization ?? null])
    created += result.rowCount
    if (result.rowCount) createdAccounts.push({ username: account.username, role: account.role })
  }
  await client.query('COMMIT')
  console.log(JSON.stringify({ created, accounts: createdAccounts }))
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  client.release()
  await pool.end()
}
