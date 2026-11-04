import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const credentialsPath = path.join(root, 'test-results', 'demo-credentials.json')
const day = 86_400_000
const now = Date.now()
const year = new Date(now).getUTCFullYear()
const dateInVietnam = (offset) => new Date(now + offset * day + 7 * 3_600_000).toISOString().slice(0, 10)
const stamp = (offset) => new Date(now + offset * day).toISOString()
const id = (name) => {
  const bytes = createHash('sha256').update(`qldetai-demo:${name}`).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const code = (prefix, name) => `${prefix}-${id(name).replaceAll('-', '').slice(0, 12).toUpperCase()}`
const departments = [
  { id: id('department-tech'), code: 'DMCNTT', name: 'Công nghệ thông tin (demo)' },
  { id: id('department-economics'), code: 'DMKTS', name: 'Kinh tế số (demo)' },
]
const classes = [
  { id: id('class-tech'), departmentId: departments[0].id, code: 'DMCNTT-K1', name: 'CNTT Demo 01' },
  { id: id('class-economics'), departmentId: departments[1].id, code: 'DMKTS-K1', name: 'Kinh tế số Demo 01' },
]
const lecturers = [
  { id: id('lecturer-1'), username: 'gv.demo01', name: 'Nguyễn Minh Anh', profileCode: 'GVDEMO01', departmentId: departments[0].id, degree: 'Thạc sĩ', specialization: 'Kỹ thuật phần mềm' },
  { id: id('lecturer-2'), username: 'gv.demo02', name: 'Trần Hà Linh', profileCode: 'GVDEMO02', departmentId: departments[1].id, degree: 'Tiến sĩ', specialization: 'Phân tích dữ liệu' },
]
const studentNames = ['Lê Gia Huy', 'Phạm Thảo Vy', 'Ngô Quốc Bảo', 'Võ Ngọc Mai', 'Đặng Đức Minh', 'Bùi Khánh An', 'Hoàng Tuấn Kiệt', 'Đỗ Hải Yến']
const students = studentNames.map((name, index) => {
  const number = String(index + 1).padStart(2, '0')
  const classroom = classes[index < 4 ? 0 : 1]
  return { id: id(`student-${number}`), username: `sv.demo${number}`, name, profileCode: `SVDEMO${number}`, departmentId: classroom.departmentId, classId: classroom.id, className: classroom.name }
})
const semester = { id: id(`semester-${year}`), code: code('HK', `semester-${year}`), name: `Học kỳ 1 năm học ${year}-${year + 1} (demo)`, start: dateInVietnam(-30), end: dateInVietnam(180) }
const round = { id: id(`round-${year}`), semesterId: semester.id, code: code('DOT', `round-${year}`), opensAt: stamp(-2), closesAt: stamp(120) }
const bulkRound = { id: id(`round-bulk-${year}`), semesterId: semester.id, code: code('DOT', `round-bulk-${year}`), opensAt: stamp(-2), closesAt: stamp(120) }
const topicSpecs = [
  ['Xây dựng hệ thống quản lý đề tài theo SOA', 'Thiết kế các dịch vụ độc lập và đánh giá khả năng chịu lỗi.', 0, 3, true],
  ['Phân tích dữ liệu học tập của sinh viên', 'Trực quan hóa dữ liệu và đề xuất hướng cải thiện kết quả học tập.', 1, 1, true],
  ['Ứng dụng di động hỗ trợ học nhóm', 'Quản lý nhóm, lịch học và tiến độ công việc.', 0, 4, true],
  ['Dự báo nhu cầu tuyển dụng bằng dữ liệu mở', 'Đề tài sẽ bắt đầu nhận đăng ký sau một tuần.', 1, 2, true],
  ['Nghiên cứu bảo mật ứng dụng web', 'Bản nháp để giảng viên tiếp tục hoàn thiện.', 0, 2, false],
]
const topics = topicSpecs.map(([title, description, lecturerIndex, capacity, published], index) => ({
  id: id(`topic-${year}-${index + 1}`), code: code('DE', `topic-${year}-${index + 1}`), title, description,
  lecturerId: lecturers[lecturerIndex].id, departmentId: lecturers[lecturerIndex].departmentId,
  capacity, published, opensAt: stamp(index === 3 ? 7 : -1), closesAt: stamp(90),
}))
const domains = [
  'quản lý thư viện số', 'đặt lịch phòng học', 'theo dõi thực tập', 'hỗ trợ tuyển sinh',
  'khảo sát chất lượng đào tạo', 'quản lý hoạt động câu lạc bộ', 'theo dõi tiến độ đồ án',
  'phân tích phản hồi sinh viên', 'quản lý học liệu mở', 'kết nối doanh nghiệp và nhà trường',
]
const approaches = [
  'Thiết kế kiến trúc hệ thống', 'Xây dựng ứng dụng web', 'Phát triển ứng dụng di động',
  'Phân tích và trực quan hóa dữ liệu', 'Tự động hóa quy trình', 'Xây dựng hệ thống gợi ý',
  'Ứng dụng học máy', 'Kiểm thử và đảm bảo chất lượng', 'Giám sát vận hành',
  'Bảo vệ dữ liệu và phân quyền',
]
for (const [domainIndex, domain] of domains.entries()) {
  for (const [approachIndex, approach] of approaches.entries()) {
    const number = domainIndex * approaches.length + approachIndex + 1
    const key = `topic-bulk-${year}-${number}`
    const lecturer = lecturers[domainIndex % lecturers.length]
    topics.push({
      id: id(key), code: code('DE', key), title: `${approach} cho ${domain}`,
      description: `Đề tài demo về ${domain}; tập trung vào ${approach.toLocaleLowerCase('vi')} và đánh giá kết quả bằng dữ liệu mẫu.`,
      lecturerId: lecturer.id, departmentId: lecturer.departmentId,
      capacity: 1 + (number % 5), published: number % 10 !== 0,
      roundId: bulkRound.id,
      opensAt: stamp(number % 13 === 0 ? 7 : -1), closesAt: stamp(90),
    })
  }
}
const registrationSpecs = [
  [0, 0, 'DA_DUYET', 'Đề tài phù hợp với hướng nghiên cứu.', 'Đã duyệt hồ sơ.'],
  [1, 0, 'CHO_DUYET', 'Mong muốn tham gia phát triển dịch vụ.', null],
  [2, 1, 'DA_DUYET', 'Có kinh nghiệm phân tích dữ liệu.', 'Đã duyệt hồ sơ.'],
  [3, 2, 'TU_CHOI', 'Quan tâm đến ứng dụng di động.', 'Cần bổ sung kỹ năng nền tảng.'],
  [4, 2, 'DA_HUY', 'Muốn thử sức với ứng dụng di động.', 'Sinh viên đã hủy đơn.'],
  [5, 2, 'CHO_DUYET', 'Đã có kinh nghiệm làm việc nhóm.', null],
]
const registrations = registrationSpecs.map(([studentIndex, topicIndex, status, reason, note], index) => ({
  id: id(`registration-${year}-${index + 1}`), student: students[studentIndex], topic: topics[topicIndex],
  roundId: round.id, roundCode: round.code, status, reason, note,
  submittedAt: stamp(-1 + index / 10),
}))

function docker(args, input = '') {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['compose', '--profile', 'soa', ...args], { cwd: root, windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('error', reject)
    child.on('close', (exitCode) => exitCode === 0 ? resolve(output) : reject(new Error(`Docker ${args.join(' ')} thất bại: ${output.slice(-3000)}`)))
    child.stdin.end(input)
  })
}

async function main() {
  let savedCredentials = null
  try { savedCredentials = JSON.parse(await readFile(credentialsPath, 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  const password = savedCredentials?.password ?? randomBytes(18).toString('base64url')
  const payload = { password, departments, classes, lecturers, students, semester, round, bulkRound, topics, registrations,
    admin: { id: id('admin'), username: 'admin.demo', name: 'Quản trị viên Demo' } }
  console.log('Đang chuẩn bị các dịch vụ...')
  await docker(['up', '-d', '--build'])
  for (const service of ['identity', 'academic', 'registration']) {
    const script = await readFile(new URL(`./demo-seed/${service}.mjs`, import.meta.url), 'utf8')
    const output = await docker(['exec', '-T', `${service}-service`, 'node', '--input-type=module', '-e', script], JSON.stringify(payload))
    const result = JSON.parse(output.trim().split('\n').at(-1))
    console.log(service === 'academic'
      ? `${service}: ${result.topicsAdded} đề tài, ${result.windowsAdded} liên kết đợt mới`
      : `${service}: ${result.created} bản ghi mới`)
    if (service === 'identity' && result.created > 0 && !savedCredentials) {
      await mkdir(path.dirname(credentialsPath), { recursive: true })
      await writeFile(credentialsPath, JSON.stringify({ createdAt: new Date().toISOString(), password, accounts: result.accounts }, null, 2), { flag: 'wx', mode: 0o600 })
      savedCredentials = { password }
    }
  }
  console.log(savedCredentials ? `Thông tin đăng nhập demo: ${credentialsPath}` : 'Các tài khoản demo đã có. Không đổi mật khẩu; tệp thông tin đăng nhập cũ không còn trên máy này.')
}

await main().catch((error) => { console.error(error.message); process.exitCode = 1 })
