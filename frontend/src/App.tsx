import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import Portal from './Portal'
import AdminDashboard from './AdminDashboard'
import { fetchWithTimeout as fetch } from './api'
import { startAuthentication } from '@simplewebauthn/browser'
import './App.css'

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
  const [mfaToken, setMfaToken] = useState('')
  const [mfaCode, setMfaCode] = useState('')
  const [mfaMethods, setMfaMethods] = useState<{ totp: boolean; passkey: boolean }>({ totp: false, passkey: false })

  useEffect(() => {
    const expire = () => {
      sessionStorage.removeItem(tokenKey); sessionStorage.removeItem(changeRequiredKey)
      setToken(''); setMfaToken(''); setPassword(''); setMustChangePassword(false)
      setError('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.')
    }
    window.addEventListener('qldetai:session-expired', expire)
    return () => window.removeEventListener('qldetai:session-expired', expire)
  }, [])

  function completeLogin(result: { token: string; role: string; mustChangePassword: boolean }) {
    if ((isAdminPortal && result.role !== 'QUAN_TRI') || (!isAdminPortal && !['SINH_VIEN', 'GIANG_VIEN'].includes(result.role))) {
      setError('Sai tên đăng nhập hoặc mật khẩu.'); setMfaToken(''); return
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
        body: JSON.stringify({ username, password, portal: isAdminPortal ? 'admin' : 'portal' }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Không thể đăng nhập.')
      if (isAdminPortal && result.role !== 'QUAN_TRI') {
        setError('Sai tên đăng nhập hoặc mật khẩu.')
        return
      }
      if (!isAdminPortal && result.role === 'QUAN_TRI') {
        setError('Sai tên đăng nhập hoặc mật khẩu.')
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
          <p className="eyebrow">DEMO</p>
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

  return <AdminDashboard token={token} onLogout={() => {
    sessionStorage.removeItem(tokenKey)
    sessionStorage.removeItem(changeRequiredKey)
    window.history.replaceState(null, '', '/admin')
    setToken(''); setError(''); setPassword('')
  }}/>

}

export default App
