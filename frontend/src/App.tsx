import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import Portal from './Portal'
import AccountManagement from './AccountManagement'
import RegistrationRounds from './RegistrationRounds'
import { startAuthentication } from '@simplewebauthn/browser'
import './App.css'

type Overview = {
  stats: { students: number; lecturers: number; topics: number; pendingRegistrations: number; rounds: number }
  recentTopics: { code: string; title: string; published: boolean; department: string | null; created_at: string }[]
}

const API = '/api'
const isAdminPortal = window.location.pathname.startsWith('/admin')
const tokenKey = isAdminPortal ? 'adminToken' : 'portalToken'
const changeRequiredKey = `${tokenKey}ChangeRequired`

function App() {
  const [token, setToken] = useState(() => sessionStorage.getItem(tokenKey) ?? '')
  const [mustChangePassword, setMustChangePassword] = useState(() => sessionStorage.getItem(changeRequiredKey) === 'true')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [overview, setOverview] = useState<Overview | null>(null)
  const [mfaToken, setMfaToken] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMethods, setMfaMethods] = useState<{ totp: boolean; passkey: boolean }>({ totp: false, passkey: false })

  useEffect(() => {
    if (!token) return
    if (!isAdminPortal) return
    let cancelled = false
    let retryTimer = 0
    const load = async (attempt: number) => {
      try {
        const response = await fetch(`${API}/admin/overview`, { headers: { Authorization: `Bearer ${token}` } })
        const body = await response.json().catch(() => ({}))
        if (response.status === 401) {
          if (!cancelled) { setError(body.error ?? 'Phiên đăng nhập đã hết hạn.'); setToken(''); sessionStorage.removeItem(tokenKey) }
          return
        }
        if (!response.ok) throw new Error(body.error ?? 'Dịch vụ đang khôi phục kết nối.')
        if (!cancelled) { setOverview(body as Overview); setError('') }
      } catch (reason) {
        if (cancelled) return
        setError(reason instanceof Error ? reason.message : 'Không kết nối được máy chủ.')
        if (attempt < 4) retryTimer = window.setTimeout(() => void load(attempt + 1), Math.min(1000 * (2 ** attempt), 8000))
      }
    }
    void load(0)
    return () => { cancelled = true; window.clearTimeout(retryTimer) }
  }, [token])

  function completeLogin(result: { token: string; role: string; mustChangePassword: boolean }) {
    if (isAdminPortal && result.role !== 'QUAN_TRI') { window.location.assign('/login'); return }
    if (!isAdminPortal && result.role === 'QUAN_TRI') {
      sessionStorage.setItem('adminToken', result.token)
      sessionStorage.setItem('adminTokenChangeRequired', String(result.mustChangePassword))
      window.location.assign('/admin')
      return
    }
    sessionStorage.setItem(tokenKey, result.token)
    sessionStorage.setItem(changeRequiredKey, String(result.mustChangePassword))
    window.history.replaceState(null, '', isAdminPortal ? '/admin' : '/portal')
    setToken(result.token)
    setMustChangePassword(result.mustChangePassword)
    setMfaToken('')
    setPassword('')
  }

  async function handleLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${API}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Không thể đăng nhập.')
      if (isAdminPortal && result.role !== 'QUAN_TRI') {
        setError('Tài khoản này không thuộc vai trò quản trị. Hãy đăng nhập tại cổng sinh viên / giảng viên.')
        return
      }
      if (!isAdminPortal && result.role === 'QUAN_TRI') {
        setError('Đây là tài khoản quản trị. Hãy đăng nhập tại cổng /admin.')
        return
      }
      if (result.mfaRequired) {
        setMfaToken(result.mfaToken)
        setMfaMethods(result.methods)
        return
      }
      completeLogin(result)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không thể kết nối máy chủ.')
    } finally {
      setLoading(false)
    }
  }

  async function verifyTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setLoading(true); setError('')
    try {
      const response = await fetch(`${API}/auth/mfa/totp`, { method: 'POST', headers: { Authorization: `Bearer ${mfaToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ code: mfaCode }) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Mã xác thực không đúng.')
      completeLogin(result)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không xác thực được.') }
    finally { setLoading(false) }
  }

  async function verifyPasskey() {
    setLoading(true); setError('')
    try {
      const optionsResponse = await fetch(`${API}/auth/mfa/passkey/options`, { method: 'POST', headers: { Authorization: `Bearer ${mfaToken}` } })
      const optionResult = await optionsResponse.json().catch(() => ({}))
      if (!optionsResponse.ok) throw new Error(optionResult.error ?? 'Không tải được yêu cầu Passkey.')
      const credential = await startAuthentication({ optionsJSON: optionResult.options })
      const response = await fetch(`${API}/auth/mfa/passkey/verify`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeToken: optionResult.challengeToken, response: credential }) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Passkey không hợp lệ.')
      completeLogin(result)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không xác thực được Passkey.') }
    finally { setLoading(false) }
  }

  async function handlePasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (newPassword !== confirmPassword) { setError('Hai mật khẩu mới không khớp.'); return }
    setLoading(true)
    setError('')
    try {
      const response = await fetch(`${API}/auth/change-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ currentPassword: password, newPassword }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Không đổi được mật khẩu.')
      sessionStorage.setItem(tokenKey, result.token)
      sessionStorage.removeItem(changeRequiredKey)
      setToken(result.token)
      setMustChangePassword(false)
      setPassword('')
      setNewPassword('')
      setConfirmPassword('')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Không đổi được mật khẩu.')
    } finally { setLoading(false) }
  }

  if (token && mustChangePassword) return <main className="login-page"><section className="login-panel"><p className="eyebrow">BẢO MẬT TÀI KHOẢN</p><h1>Đổi mật khẩu lần đầu</h1><p className="password-change-note">Hãy đặt mật khẩu mới trước khi tiếp tục.</p><form className="login-form" onSubmit={handlePasswordChange}><label htmlFor="new-password">Mật khẩu mới (ít nhất 12 ký tự)</label><input id="new-password" type="password" minLength={12} autoComplete="new-password" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} required/><label htmlFor="confirm-password">Nhập lại mật khẩu mới</label><input id="confirm-password" type="password" minLength={12} autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} required/>{error && <p className="form-error" role="alert">{error}</p>}<button disabled={loading}>{loading ? 'Đang cập nhật…' : 'Lưu mật khẩu mới'}</button></form></section></main>

  if (mfaToken) return <main className="login-page"><section className="login-panel"><p className="eyebrow">XÁC THỰC TĂNG CƯỜNG</p><h1>Xác minh đăng nhập</h1><p className="password-change-note">Nhập mã Google Authenticator hoặc dùng Passkey đã đăng ký.</p>{mfaMethods.totp && <form className="login-form" onSubmit={verifyTotp}><label htmlFor="mfa-code">Mã 6 số hoặc mã khôi phục</label><input id="mfa-code" value={mfaCode} onChange={(event) => setMfaCode(event.target.value)} autoComplete="one-time-code" required/>{error && <p className="form-error" role="alert">{error}</p>}<button disabled={loading}>Xác minh mã</button></form>}{mfaMethods.passkey && <button className="mfa-passkey-button" disabled={loading} onClick={() => void verifyPasskey()}>Tiếp tục bằng Passkey</button>}{!mfaMethods.totp && error && <p className="form-error" role="alert">{error}</p>}<button className="request-account-link" onClick={() => { setMfaToken(''); setError('') }}>Hủy đăng nhập</button></section></main>

  if (!isAdminPortal && token) return <Portal token={token} onTokenChange={(nextToken) => { sessionStorage.setItem(tokenKey, nextToken); setToken(nextToken) }} onLogout={() => { sessionStorage.removeItem(tokenKey); sessionStorage.removeItem(changeRequiredKey); window.history.replaceState(null, '', '/login'); setToken('') }} />

  if (!token) {
    return (
      <main className="login-page">
        <section className="login-panel" aria-labelledby="login-title">
          <p className="eyebrow">QUẢN LÝ ĐỀ TÀI</p>
          <h1 id="login-title">{isAdminPortal ? 'Đăng nhập quản trị' : 'Đăng nhập sinh viên / giảng viên'}</h1>
          <form className="login-form" onSubmit={handleLogin}>
            <label htmlFor="username">Tên đăng nhập</label>
            <input id="username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="username" required />
            <div className="password-heading"><label htmlFor="password">Mật khẩu</label></div>
            <input id="password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" required />
            {error && <p className="form-error" role="alert">{error}</p>}
            <button type="submit" disabled={loading}>{loading ? 'Đang đăng nhập…' : 'Đăng nhập'}</button>
          </form>
        </section>
      </main>
    )
  }

  return (
    <main className="admin-shell">
      <aside className="sidebar">
        <div className="side-brand"><span className="brand-wordmark">ĐT</span><span>ĐỀ TÀI<small>HỆ THỐNG HỌC VỤ</small></span></div>
        <p className="nav-label">MENU</p>
        <a className="nav-item active" href="#overview"><span>▦</span>Tổng quan</a>
        <a className="nav-item" href="#topics"><span>▤</span>Đề tài</a>
        <a className="nav-item" href="#registrations"><span>☷</span>Đăng ký <b>{overview?.stats.pendingRegistrations ?? 0}</b></a>
        <a className="nav-item" href="#accounts"><span>♙</span>Tài khoản</a>
        <a className="nav-item" href="#rounds"><span>◷</span>Đợt đăng ký</a>
        <a className="nav-item" href="#departments"><span>⌂</span>Khoa</a>
        <div className="sidebar-bottom"><span className="avatar">AD</span><span>Quản trị viên<small>admin.demo</small></span><button onClick={() => { sessionStorage.removeItem(tokenKey); sessionStorage.removeItem(changeRequiredKey); window.history.replaceState(null, '', '/admin'); setToken(''); setOverview(null) }} aria-label="Đăng xuất">↗</button></div>
      </aside>
      <section className="admin-content" id="overview">
        <header className="topbar"><div><p className="eyebrow">01 / TRUNG TÂM ĐIỀU HÀNH</p><h1>Tổng quan</h1></div><div className="topbar-date">CỔNG QUẢN TRỊ <span>•</span> HỌC VỤ</div></header>
        {error && <div className="notice">{error}</div>}
        {!overview ? <div className="loading-card">Đang tải số liệu quản trị…</div> : <>
          <section className="stat-grid" aria-label="Thống kê">
            <article className="stat-card"><span className="stat-icon">▤</span><p>Tổng đề tài</p><strong>{overview.stats.topics}</strong><small>Trong hệ thống</small></article>
            <article className="stat-card"><span className="stat-icon">☷</span><p>Đăng ký chờ duyệt</p><strong>{overview.stats.pendingRegistrations}</strong><small>Cần xử lý</small></article>
            <article className="stat-card"><span className="stat-icon">♙</span><p>Sinh viên</p><strong>{overview.stats.students}</strong><small>Tài khoản sinh viên</small></article>
            <article className="stat-card"><span className="stat-icon">♧</span><p>Giảng viên</p><strong>{overview.stats.lecturers}</strong><small>Tài khoản giảng viên</small></article>
          </section>
          <section className="content-card" id="topics">
            <div className="card-heading"><div><h2>Đề tài mới cập nhật</h2><p>Danh sách đề tài được tạo gần đây</p></div><button className="outline-button">Quản lý đề tài <span>→</span></button></div>
            <div className="table-wrap"><table><thead><tr><th>MÃ ĐỀ TÀI</th><th>TÊN ĐỀ TÀI</th><th>KHOA</th><th>TRẠNG THÁI</th></tr></thead><tbody>
              {overview.recentTopics.length ? overview.recentTopics.map((topic) => <tr key={topic.code}><td className="code-cell">{topic.code}</td><td className="title-cell">{topic.title}</td><td>{topic.department ?? 'Chưa phân khoa'}</td><td><span className={`status-pill ${topic.published ? 'published' : 'draft'}`}>{topic.published ? 'Đã công bố' : 'Bản nháp'}</span></td></tr>) : <tr><td colSpan={4} className="empty-state">Chưa có đề tài. Tạo khoa và đề tài để bắt đầu quản lý.</td></tr>}
            </tbody></table></div>
          </section>
          <section className="bottom-grid"><article className="content-card compact-card"><div className="card-heading"><div><h2>Đợt đăng ký</h2><p>Các đợt đang được cấu hình</p></div></div><div className="round-total"><strong>{overview.stats.rounds}</strong><span>đợt đăng ký</span></div></article><article className="content-card compact-card"><div className="card-heading"><div><h2>Việc cần làm</h2><p>Tình trạng xử lý hiện tại</p></div></div><div className="task-row"><span className="task-dot"/>Đăng ký chờ duyệt<strong>{overview.stats.pendingRegistrations}</strong></div></article></section>
          <RegistrationRounds token={token} />
          <AccountManagement token={token} />
        </>}
      </section>
    </main>
  )
}

export default App
