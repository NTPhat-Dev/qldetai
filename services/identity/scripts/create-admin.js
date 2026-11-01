import { stdin } from 'node:process'
import argon2 from 'argon2'
import { Pool } from 'pg'

const pool = new Pool({ connectionString: process.env.DATABASE_URL })
try {
  const chunks = []
  for await (const chunk of stdin) chunks.push(chunk)
  const input = Buffer.concat(chunks).toString('utf8').trim()
  const request = JSON.parse(input)
  const existing = await pool.query("SELECT 1 FROM identity.users WHERE role='QUAN_TRI' LIMIT 1")
  if (existing.rowCount) {
    console.log(JSON.stringify({ created: false }))
  } else {
    const passwordHash = await argon2.hash(request.temporaryPassword, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1, hashLength: 32 })
    const result = await pool.query(`INSERT INTO identity.users(username,password_hash,role,status,must_change_password,display_name,profile_code)
      VALUES($1,$2,'QUAN_TRI','HOAT_DONG',true,$3,'ADMIN') RETURNING id,username`, [request.username,passwordHash,request.name])
    console.log(JSON.stringify({ created: true, id: result.rows[0].id, username: result.rows[0].username, temporaryPassword: request.temporaryPassword }))
  }
} finally { await pool.end() }
