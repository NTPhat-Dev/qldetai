import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'

type Department = { id: string; code: string; name: string }
type ClassItem = { id: string; code: string; name: string }
type Account = { id: string; username: string; role: string; status: string; name: string; profile_code: string; department: string | null }
const API = '/api/admin'

export default function AccountManagement({ token }: { token: string }) {
  const [departments, setDepartments] = useState<Department[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [role, setRole] = useState('SINH_VIEN')
  const [selectedDepartment, setSelectedDepartment] = useState('')
  const [classes, setClasses] = useState<ClassItem[]>([])
  const [message, setMessage] = useState('')
  const load = useCallback(async () => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const [departmentResponse, accountResponse] = await Promise.all([
      fetch(`${API}/departments`, { headers }), fetch(`${API}/accounts`, { headers }),
    ])
    if (!departmentResponse.ok || !accountResponse.ok) throw new Error('Không tải được dữ liệu quản lý tài khoản.')
    setDepartments(await departmentResponse.json())
    setAccounts(await accountResponse.json())
  }, [token])

  useEffect(() => {
    if (role !== 'SINH_VIEN' || !selectedDepartment) return
    let active = true
    fetch(`${API}/departments/${selectedDepartment}/classes`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        if (!response.ok) throw new Error('Không tải được danh sách lớp.')
        return response.json() as Promise<ClassItem[]>
      })
      .then((items) => { if (active) setClasses(items) })
      .catch((error: Error) => { if (active) setMessage(error.message) })
    return () => { active = false }
  }, [role, selectedDepartment, token])

  useEffect(() => {
    let active = true
    const headers = { Authorization: `Bearer ${token}` }
    Promise.all([fetch(`${API}/departments`, { headers }), fetch(`${API}/accounts`, { headers })])
      .then(async ([departmentResponse, accountResponse]) => {
        if (!departmentResponse.ok || !accountResponse.ok) throw new Error('Không tải được dữ liệu quản lý tài khoản.')
        return Promise.all([departmentResponse.json(), accountResponse.json()]) as Promise<[Department[], Account[]]>
      })
      .then(([departmentData, accountData]) => {
        if (active) { setDepartments(departmentData); setAccounts(accountData) }
      })
      .catch((error: Error) => { if (active) setMessage(error.message) })
    return () => { active = false }
  }, [token])

  async function createDepartment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    setMessage('')
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const response = await fetch(`${API}/departments`, { method: 'POST', headers, body: JSON.stringify({ name: form.get('name') }) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) { setMessage(result.error ?? 'Không tạo được khoa.'); return }
    formElement.reset()
    await load()
    setSelectedDepartment(result.id)
    setMessage(`Đã tạo khoa ${result.name}, mã tự sinh ${result.code}.`)
  }

  async function createClass(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    const response = await fetch(`${API}/classes`, { method: 'POST', headers, body: JSON.stringify({ departmentId: form.get('departmentId') }) })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) { setMessage(result.error ?? 'Không tạo được lớp.'); return }
    formElement.reset()
    if (result && form.get('departmentId') === selectedDepartment) {
      setClasses((current) => [...current, result].sort((a, b) => a.name.localeCompare(b.name)))
    }
    setMessage(`Đã thêm lớp ${result.code}.`)
  }

  async function createAccount(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const formElement = event.currentTarget
    const form = new FormData(formElement)
    const payload = Object.fromEntries(form.entries())
    setMessage('')
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    try {
      const response = await fetch(`${API}/accounts`, { method: 'POST', headers, body: JSON.stringify({ ...payload, role }) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) { setMessage(result.error ?? 'Không cấp được tài khoản.'); return }
      formElement.reset()
      await load()
      setMessage(`Tài khoản đã cấp — mã/tên đăng nhập: ${result.username}; mật khẩu tạm: ${result.temporaryPassword}. Hãy lưu và gửi riêng cho người dùng; mật khẩu chỉ hiện lần này.`)
    } catch {
      setMessage('Không kết nối được dịch vụ. Hãy kiểm tra trình quản lý dịch vụ rồi thử lại.')
    }
  }

  return <section className="account-management" id="accounts">
    <div className="card-heading"><div><h2>Cấp tài khoản sinh viên / giảng viên</h2><p>Mã hồ sơ đồng thời là tên đăng nhập; mật khẩu tạm được sinh tự động</p></div></div>
    {message && <p className="account-message" role="status">{message}</p>}
    {!departments.length && <form className="department-form" onSubmit={createDepartment}><strong>Tạo khoa đầu tiên</strong><input name="name" placeholder="Tên khoa, ví dụ Công nghệ thông tin" required/><button className="dark-button">Tạo khoa, sinh mã tự động</button></form>}
    {departments.length > 0 && <form className="department-form" onSubmit={createDepartment}><strong>Thêm khoa</strong><input name="name" placeholder="Tên khoa mới" required/><button className="dark-button">Tạo khoa</button></form>}
    {departments.length > 0 && <form className="department-form" onSubmit={createClass}><strong>Thêm lớp · mã tự tăng theo khoa (ví dụ CNTT-K1)</strong><select name="departmentId" required><option value="">Chọn khoa</option>{departments.map((department) => <option value={department.id} key={department.id}>{department.name} ({department.code})</option>)}</select><button className="dark-button">Tạo lớp tiếp theo</button></form>}
    <form className="account-form" onSubmit={createAccount}>
      <label>Vai trò<select value={role} onChange={(event) => setRole(event.target.value)}><option value="SINH_VIEN">Sinh viên</option><option value="GIANG_VIEN">Giảng viên</option></select></label>
      <label>Họ và tên<input name="name" required/></label>
      <label>Khoa<select name="departmentId" value={selectedDepartment} onChange={(event) => { setClasses([]); setSelectedDepartment(event.target.value) }} required disabled={!departments.length}><option value="">Chọn khoa</option>{departments.map((department) => <option value={department.id} key={department.id}>{department.name} ({department.code})</option>)}</select></label>
      {role === 'SINH_VIEN' ? <>
        <label>Lớp<select name="classId" required disabled={!selectedDepartment || !classes.length}><option value="">{!selectedDepartment ? 'Chọn khoa trước' : classes.length ? 'Chọn lớp' : 'Khoa chưa có lớp'}</option>{classes.map((item) => <option value={item.id} key={item.id}>{item.name} ({item.code})</option>)}</select></label>
        <label>Số điện thoại<input name="phone" type="tel"/></label>
      </> : <>
        <label>Học hàm<input name="academicTitle" placeholder="Ví dụ: Phó giáo sư"/></label>
        <label>Học vị<input name="degree" placeholder="Ví dụ: Tiến sĩ"/></label>
        <label>Chuyên môn<input name="specialization" placeholder="Lĩnh vực chuyên môn"/></label>
        <label>Số điện thoại<input name="phone" type="tel"/></label>
      </>}
      <button className="dark-button" disabled={!departments.length}>Cấp tài khoản</button>
    </form>
    <div className="account-list"><h3>Tài khoản đã cấp</h3><div className="table-wrap"><table><thead><tr><th>HỌ TÊN</th><th>TÊN ĐĂNG NHẬP</th><th>VAI TRÒ</th><th>MÃ HỒ SƠ</th><th>KHOA</th><th>TRẠNG THÁI</th></tr></thead><tbody>{accounts.map((account) => <tr key={account.id}><td>{account.name}</td><td>{account.username}</td><td>{account.role === 'SINH_VIEN' ? 'Sinh viên' : account.role === 'GIANG_VIEN' ? 'Giảng viên' : 'Quản trị'}</td><td>{account.profile_code}</td><td>{account.department ?? '—'}</td><td>{account.status}</td></tr>)}</tbody></table></div></div>
  </section>
}
