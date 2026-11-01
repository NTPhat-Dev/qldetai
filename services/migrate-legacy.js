import pg from 'pg'

const { Pool } = pg
const legacy = new Pool({ connectionString: process.env.LEGACY_DATABASE_URL })
const identity = new Pool({ connectionString: process.env.IDENTITY_DATABASE_URL })
const academic = new Pool({ connectionString: process.env.ACADEMIC_DATABASE_URL })
const registration = new Pool({ connectionString: process.env.REGISTRATION_DATABASE_URL })

async function copy(source, target, query, insert, map = (row) => Object.values(row), beforeInsert = null) {
  const rows = (await source.query(query)).rows
  for (const row of rows) {
    if (beforeInsert) await beforeInsert(target, row)
    await target.query(insert, map(row))
  }
  return rows.length
}

try {
  await identity.query(`ALTER TABLE identity.users ADD COLUMN IF NOT EXISTS academic_title text, ADD COLUMN IF NOT EXISTS degree text, ADD COLUMN IF NOT EXISTS specialization text, ADD COLUMN IF NOT EXISTS class_name text`)
  const totals = {}
  totals.users = await copy(legacy, identity,
    `SELECT a.id,a.ten_dang_nhap,a.email,a.bam_mat_khau,a.vai_tro::text AS role,a.trang_thai::text AS status,a.doi_mat_khau_lan_dau,a.tao_luc,a.cap_nhat_luc,
      COALESCE(s.ho_ten,g.ho_ten,ad.ho_ten,a.ten_dang_nhap) AS display_name, COALESCE(s.ma_sinh_vien,g.ma_giang_vien,ad.ma_quan_tri) AS profile_code,
      COALESCE(s.khoa_id,g.khoa_id) AS department_id, COALESCE(s.dien_thoai,g.dien_thoai) AS phone, g.hoc_ham AS academic_title,g.hoc_vi AS degree,g.chuyen_mon AS specialization,s.lop AS class_name
     FROM qldetai.tai_khoan a LEFT JOIN qldetai.ho_so_sinh_vien s ON s.tai_khoan_id=a.id
     LEFT JOIN qldetai.ho_so_giang_vien g ON g.tai_khoan_id=a.id LEFT JOIN qldetai.ho_so_quan_tri ad ON ad.tai_khoan_id=a.id ORDER BY a.tao_luc`,
    `INSERT INTO identity.users(id,username,email,password_hash,role,status,must_change_password,created_at,updated_at,display_name,profile_code,department_id,phone,academic_title,degree,specialization,class_name)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT(id) DO NOTHING`,
    (row) => Object.values(row),
    (target, row) => target.query('DELETE FROM identity.users WHERE username=$1 AND id<>$2', [row.ten_dang_nhap, row.id]))
  totals.totp = await copy(legacy, identity,
    'SELECT tai_khoan_id,bi_mat_ma_hoa,ma_khoa_ma_hoa,xac_nhan_luc,tao_luc FROM qldetai.yeu_to_totp',
    `INSERT INTO identity.totp_factors(user_id,encrypted_secret,encryption_version,confirmed_at,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(user_id) DO NOTHING`)
  totals.passkeys = await copy(legacy, identity,
    'SELECT id,tai_khoan_id,ma_thong_tin,khoa_cong_khai,bo_dem_chu_ky,kenh,nhan,tao_luc,su_dung_gan_nhat FROM qldetai.khoa_passkey',
    `INSERT INTO identity.passkeys(id,user_id,credential_id,public_key,sign_count,transports,label,created_at,last_used_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`)
  totals.recoveryCodes = await copy(legacy, identity,
    'SELECT id,tai_khoan_id,ma_bam,tao_luc,da_dung_luc FROM qldetai.ma_khoi_phuc',
    `INSERT INTO identity.recovery_codes(id,user_id,code_hash,created_at,used_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`)

  totals.departments = await copy(legacy, academic, 'SELECT id,ma_khoa,ten_khoa,tao_luc FROM qldetai.khoa',
    'INSERT INTO academic.departments(id,code,name,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO NOTHING')
  totals.classes = await copy(legacy, academic, 'SELECT id,khoa_id,ma_lop,ten_lop,tao_luc FROM qldetai.lop_hoc',
    'INSERT INTO academic.classes(id,department_id,code,name,created_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING')
  totals.semesters = await copy(legacy, academic, 'SELECT id,ma_hoc_ky,ten_hoc_ky,bat_dau,ket_thuc FROM qldetai.hoc_ky',
    'INSERT INTO academic.semesters(id,code,name,starts_on,ends_on) VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING')
  totals.rounds = await copy(legacy, academic, 'SELECT id,hoc_ky_id,ma_dot,mo_luc,dong_luc,dang_mo,tao_luc FROM qldetai.dot_dang_ky',
    'INSERT INTO academic.rounds(id,semester_id,code,opens_at,closes_at,is_open,created_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING')
  totals.topics = await copy(legacy, academic, 'SELECT id,ma_de_tai,tieu_de,mo_ta,giang_vien_id,khoa_id,mo_luc,dong_luc,suc_chua,da_cong_bo,tao_luc FROM qldetai.de_tai',
    'INSERT INTO academic.topics(id,code,title,description,lecturer_id,department_id,opens_at,closes_at,capacity,published,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(id) DO NOTHING')
  totals.topicWindows = await copy(legacy, academic, 'SELECT de_tai_id,dot_dang_ky_id,mo_luc,dong_luc,duoc_phep FROM qldetai.thoi_han_de_tai_dot',
    'INSERT INTO academic.topic_round_windows(topic_id,round_id,opens_at,closes_at,allowed) VALUES($1,$2,$3,$4,$5) ON CONFLICT(topic_id,round_id) DO NOTHING')

  totals.registrations = await copy(legacy, registration,
    `SELECT r.id,r.sinh_vien_id,r.de_tai_id,r.dot_dang_ky_id,r.trang_thai::text,r.ly_do,r.gui_luc,r.quyet_dinh_luc,r.nguoi_quyet_dinh,
            d.ma_de_tai,d.tieu_de,s.ma_sinh_vien,s.ho_ten,ro.ma_dot
     FROM qldetai.dang_ky_de_tai r JOIN qldetai.de_tai d ON d.id=r.de_tai_id
     JOIN qldetai.dot_dang_ky ro ON ro.id=r.dot_dang_ky_id JOIN qldetai.ho_so_sinh_vien s ON s.tai_khoan_id=r.sinh_vien_id`,
    `INSERT INTO registration.registrations(id,student_id,topic_id,round_id,status,reason,submitted_at,decided_at,decided_by,topic_code,topic_title,student_code,student_name,round_code)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ON CONFLICT(id) DO NOTHING`)
  await registration.query('TRUNCATE registration.history RESTART IDENTITY')
  totals.history = await copy(legacy, registration,
    'SELECT id,dang_ky_id,trang_thai_cu::text,trang_thai_moi::text,nguoi_thay_doi,thay_doi_luc,ghi_chu FROM qldetai.lich_su_dang_ky',
    `INSERT INTO registration.history(id,registration_id,old_status,new_status,changed_by,changed_at,note) OVERRIDING SYSTEM VALUE VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`)
  await registration.query("SELECT setval(pg_get_serial_sequence('registration.history','id'), COALESCE((SELECT max(id) FROM registration.history),1), true)")
  console.log(JSON.stringify({ migrated: totals }))
} finally {
  await Promise.all([legacy.end(), identity.end(), academic.end(), registration.end()])
}
