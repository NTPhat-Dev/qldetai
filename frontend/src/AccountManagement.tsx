import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { api } from './api'

type Department = { id: string; code: string; name: string }
type ClassItem = { id: string; code: string; name: string }
type Account = { id: string; username: string; role: string; status: string; name: string; profile_code: string; department: string | null }
type Credentials = { username: string; temporaryPassword: string }
const roleName = (role: string) => role === 'SINH_VIEN' ? 'Sinh viên' : role === 'GIANG_VIEN' ? 'Giảng viên' : 'Quản trị'

export default function AccountManagement({ token, mode = 'accounts' }: { token: string; mode?: 'accounts'|'organization' }) {
  const [departments, setDepartments] = useState<Department[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [role, setRole] = useState('SINH_VIEN')
  const [selectedDepartment, setSelectedDepartment] = useState('')
  const [classes, setClasses] = useState<ClassItem[]>([])
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [credentials, setCredentials] = useState<Credentials | null>(null)
  const load = useCallback(async () => {
    const results = await Promise.allSettled([api<Department[]>('/admin/departments', token), ...(mode === 'accounts' ? [api<Account[]>('/admin/accounts', token)] : [])])
    if (results[0].status === 'fulfilled') setDepartments(results[0].value)
    if (results[1]?.status === 'fulfilled') setAccounts(results[1].value as Account[])
    const failure = results.find((result) => result.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }, [mode, token])
  useEffect(() => { void load().catch((reason: Error) => setError(reason.message)) }, [load])
  useEffect(() => {
    setClasses([])
    if (!selectedDepartment) return
    let active = true
    api<ClassItem[]>(`/admin/departments/${selectedDepartment}/classes`, token)
      .then((items) => { if (active) setClasses(items) })
      .catch((reason: Error) => { if (active) setError(reason.message) })
    return () => { active = false }
  }, [selectedDepartment, token])

  async function run<T,>(operation: () => Promise<T>, done: (result: T) => void) {
    setBusy(true); setError(''); setMessage('')
    try {
      const result = await operation()
      done(result)
      await load().catch(() => setError('Thao tác đã lưu. Danh sách sẽ cập nhật khi bạn làm mới.'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thực hiện được yêu cầu.') }
    finally { setBusy(false) }
  }
  function createDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    void run(() => api<Department>('/admin/departments', token, 'POST', { name: new FormData(form).get('name') }), (result) => {
      form.reset(); setSelectedDepartment(result.id); setMessage(`Đã tạo khoa ${result.name} (${result.code}).`)
    })
  }
  function createClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void run(() => api<ClassItem>('/admin/classes', token, 'POST', { departmentId: selectedDepartment }), (result) => {
      setClasses((current) => [...current, result]); setMessage(`Đã tạo lớp ${result.code}.`)
    })
  }
  function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const payload = Object.fromEntries(new FormData(form).entries())
    void run(() => api<Credentials>('/admin/accounts', token, 'POST', { ...payload, role }), (result) => {
      setCredentials(result); form.reset(); setMessage('Đã cấp tài khoản. Lưu thông tin đăng nhập bên dưới trước khi đóng.'); setSelectedDepartment('')
    })
  }
  function changeStatus(account: Account) {
    const status = account.status === 'HOAT_DONG' ? 'KHOA' : 'HOAT_DONG'
    void run(() => api(`/admin/accounts/${account.id}/status`, token, 'PATCH', { status }), () => setMessage(`Đã ${status === 'KHOA' ? 'khóa' : 'mở khóa'} tài khoản ${account.username}.`))
  }
  function resetPassword(account: Account) {
    if (!window.confirm(`Đặt lại mật khẩu tài khoản ${account.username}? Người dùng sẽ cần đăng nhập và đổi mật khẩu mới.`)) return
    void run(() => api<Credentials>(`/admin/accounts/${account.id}/reset-password`, token, 'POST', {}), (result) => { setCredentials(result); setMessage('Đã cấp mật khẩu tạm mới.') })
  }
  const visible = accounts.filter((account) => `${account.name} ${account.username} ${account.department ?? ''}`.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi')))
  return <section className="account-management" id={mode === 'organization' ? 'departments' : 'accounts'}>
    <div className="card-heading"><div><h2>{mode === 'organization' ? 'Khoa và lớp' : 'Tài khoản'}</h2><p>{mode === 'organization' ? 'Tạo khoa, chọn khoa để xem và thêm lớp.' : 'Cấp tài khoản, khóa truy cập và đặt lại mật khẩu.'}</p></div><button className="outline-button" disabled={busy} onClick={() => void load().then(() => setError('')).catch((reason: Error) => setError(reason.message))}>Làm mới</button></div>
    {error && <p className="account-message" role="alert">{error}</p>}{message && <p className="account-message" role="status">{message}</p>}
    {credentials && <div className="credential-card" role="status"><strong>Thông tin đăng nhập mới</strong><p>Tên đăng nhập: <b>{credentials.username}</b></p><p>Mật khẩu tạm: <code>{credentials.temporaryPassword}</code></p><p>Lưu và gửi riêng cho người dùng. Mật khẩu chỉ xuất hiện lần này.</p><button className="outline-button" onClick={() => setCredentials(null)}>Đã lưu, ẩn thông tin</button></div>}
    {mode === 'organization' ? <>
      <form className="department-form" onSubmit={createDepartment}><label>Tên khoa<input name="name" placeholder="Ví dụ: Công nghệ thông tin" maxLength={160} required/></label><button className="dark-button" disabled={busy}>Thêm khoa</button></form>
      <form className="department-form" onSubmit={createClass}><label>Khoa<select aria-label="Khoa để quản lý lớp" value={selectedDepartment} onChange={(event) => setSelectedDepartment(event.target.value)} required><option value="">Chọn khoa</option>{departments.map((department) => <option value={department.id} key={department.id}>{department.name} ({department.code})</option>)}</select></label><button className="dark-button" disabled={busy || !selectedDepartment}>Thêm lớp tiếp theo</button></form>
      <div className="table-wrap"><table><thead><tr><th>{selectedDepartment ? 'Mã lớp' : 'Mã khoa'}</th><th>Tên</th></tr></thead><tbody>{(selectedDepartment ? classes : departments).map((item) => <tr key={item.id}><td>{item.code}</td><td>{item.name}</td></tr>)}{!(selectedDepartment ? classes : departments).length && <tr><td colSpan={2} className="empty-state">{selectedDepartment ? 'Khoa chưa có lớp.' : 'Chưa có khoa.'}</td></tr>}</tbody></table></div>
    </> : <>
      {!departments.length && <p className="account-message">Tạo khoa và lớp ở mục “Khoa và lớp” trước khi cấp tài khoản.</p>}
      <details className="form-disclosure" open><summary>Cấp tài khoản mới</summary><form className="account-form" onSubmit={createAccount}>
        <label>Vai trò<select value={role} onChange={(event) => setRole(event.target.value)}><option value="SINH_VIEN">Sinh viên</option><option value="GIANG_VIEN">Giảng viên</option></select></label>
        <label>Họ và tên<input name="name" required maxLength={160}/></label>
        <label>Khoa<select name="departmentId" value={selectedDepartment} onChange={(event) => setSelectedDepartment(event.target.value)} required disabled={!departments.length}><option value="">Chọn khoa</option>{departments.map((department) => <option value={department.id} key={department.id}>{department.name}</option>)}</select></label>
        {role === 'SINH_VIEN' ? <label>Lớp<select name="classId" key={selectedDepartment} required disabled={!classes.length}><option value="">{classes.length ? 'Chọn lớp' : 'Chọn khoa có lớp'}</option>{classes.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label> : <><label>Học hàm<input name="academicTitle"/></label><label>Học vị<input name="degree"/></label><label>Chuyên môn<input name="specialization"/></label></>}
        <label>Số điện thoại<input name="phone" type="tel" maxLength={30}/></label><button className="dark-button" disabled={busy || !departments.length || (role === 'SINH_VIEN' && !classes.length)}>{busy ? 'Đang lưu…' : 'Cấp tài khoản'}</button>
      </form></details>
      <div className="filter-bar"><input aria-label="Tìm tài khoản" placeholder="Tìm họ tên, mã tài khoản hoặc khoa" value={query} onChange={(event) => setQuery(event.target.value)}/><span className="muted">{visible.length} tài khoản</span></div>
      <div className="table-wrap"><table><thead><tr><th>Họ tên</th><th>Tên đăng nhập</th><th>Vai trò</th><th>Khoa</th><th>Trạng thái</th><th>Thao tác</th></tr></thead><tbody>{visible.map((account) => <tr key={account.id}><td>{account.name}</td><td>{account.username}</td><td>{roleName(account.role)}</td><td>{account.department ?? '—'}</td><td><span className="status-pill">{account.status === 'HOAT_DONG' ? 'Hoạt động' : 'Đã khóa'}</span></td><td>{account.role !== 'QUAN_TRI' && <div className="row-actions"><button className="outline-button" disabled={busy} onClick={() => changeStatus(account)}>{account.status === 'HOAT_DONG' ? 'Khóa' : 'Mở khóa'}</button><button className="outline-button" disabled={busy} onClick={() => resetPassword(account)}>Đặt lại mật khẩu</button></div>}</td></tr>)}{!visible.length && <tr><td colSpan={6} className="empty-state">Không có tài khoản phù hợp.</td></tr>}</tbody></table></div>
    </>}
  </section>
}
