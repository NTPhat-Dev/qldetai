import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import QRCode from 'qrcode'
import { startRegistration } from '@simplewebauthn/browser'

type Profile = { role: string; code: string; name: string; phone: string | null; department: string | null; class?: string | null; academic_title?: string | null; degree?: string | null; specialization?: string | null }
type Security = { totpEnabled: boolean; passkeys: { id: string; label: string | null; created_at: string; last_used: string | null }[]; recoveryCodesRemaining: number }
const API = '/api'

export default function PersonalSettings({ token, page, onTokenChange }: { token: string; page: 'profile'|'settings'; onTokenChange: (token: string) => void }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [security, setSecurity] = useState<Security | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [totpSetup, setTotpSetup] = useState<{ secret: string; qr: string } | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])

  const loadProfile = useCallback(async () => {
    const response = await fetch(`${API}/portal/profile`, { headers: { Authorization: `Bearer ${token}` } })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error ?? 'Không tải được hồ sơ cá nhân.')
    setProfile(result.profile as Profile)
  }, [token])
  const loadSecurity = useCallback(async () => {
    const response = await fetch(`${API}/portal/security`, { headers: { Authorization: `Bearer ${token}` } })
    const result = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(result.error ?? 'Không tải được cài đặt bảo mật.')
    setSecurity(result as Security)
  }, [token])

  useEffect(() => {
    setError(''); setMessage('')
    ;(page === 'profile' ? loadProfile() : loadSecurity()).catch((reason: Error) => setError(reason.message))
  }, [page, loadProfile, loadSecurity])

  async function send(path: string, method: string, payload: unknown) {
    setBusy(true); setError(''); setMessage('')
    try {
      const response = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Không lưu được thay đổi.')
      setMessage('Đã lưu thay đổi.')
      return result
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không lưu được thay đổi.'); return null }
    finally { setBusy(false) }
  }

  async function saveProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const values = Object.fromEntries(new FormData(event.currentTarget).entries())
    if (await send('/portal/profile', 'PATCH', values)) await loadProfile()
  }

  async function changePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    if (values.newPassword !== values.confirmPassword) { setError('Hai mật khẩu mới không khớp.'); return }
    const result = await send('/auth/change-password', 'POST', { currentPassword: values.currentPassword, newPassword: values.newPassword })
    if (result?.token) onTokenChange(result.token)
    if (result?.token) form.reset()
  }

  async function setupTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const currentPassword = new FormData(form).get('currentPassword')
    const result = await send('/portal/security/totp/setup', 'POST', { currentPassword })
    if (result?.secret && result?.otpauthUrl) {
      setTotpSetup({ secret: result.secret, qr: await QRCode.toDataURL(result.otpauthUrl, { margin: 1, width: 220 }) })
      setMessage('Quét QR bằng Google Authenticator, sau đó nhập mã 6 số để xác nhận.')
      form.reset()
    }
  }

  async function confirmTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = new FormData(event.currentTarget).get('code')
    const result = await send('/portal/security/totp/confirm', 'POST', { code })
    if (result?.enabled) { setRecoveryCodes(result.recoveryCodes as string[]); setTotpSetup(null); await loadSecurity() }
  }

  async function disableTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    if (await send('/portal/security/totp/disable', 'POST', values)) { form.reset(); await loadSecurity() }
  }

  async function addPasskey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    setBusy(true); setError(''); setMessage('')
    try {
      const optionsResponse = await fetch(`${API}/portal/security/passkeys/options`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword: values.currentPassword }) })
      const optionResult = await optionsResponse.json().catch(() => ({}))
      if (!optionsResponse.ok) throw new Error(optionResult.error ?? 'Không tạo được yêu cầu Passkey.')
      const credential = await startRegistration({ optionsJSON: optionResult.options })
      const verifyResponse = await fetch(`${API}/portal/security/passkeys/verify`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ challengeToken: optionResult.challengeToken, response: credential, label: values.label }) })
      const result = await verifyResponse.json().catch(() => ({}))
      if (!verifyResponse.ok) throw new Error(result.error ?? 'Không lưu được Passkey.')
      form.reset(); setMessage('Đã thêm Passkey.'); await loadSecurity()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thêm được Passkey.') }
    finally { setBusy(false) }
  }

  async function removePasskey(id: string) {
    const currentPassword = window.prompt('Nhập mật khẩu hiện tại để xóa Passkey này:')
    if (!currentPassword) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`${API}/portal/security/passkeys/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword }) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Không xóa được Passkey.')
      setMessage('Đã xóa Passkey.'); await loadSecurity()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không xóa được Passkey.') }
    finally { setBusy(false) }
  }

  return (
    <section className="personal-settings-page">
      <p className="eyebrow">TÀI KHOẢN CỦA TÔI</p>
      <h2>{page === 'profile' ? 'Thông tin cá nhân' : 'Cài đặt tài khoản'}</h2>
      {error && <p className="account-message" role="alert">{error}</p>}
      {message && <p className="account-message" role="status">{message}</p>}
      {page === 'profile' ? (
        profile ? <form className="personal-profile-form" onSubmit={saveProfile}>
          <label>Mã tài khoản<input value={profile.code} readOnly /></label>
          <label>Họ và tên<input value={profile.name} readOnly /></label>
          <label>Khoa<input value={profile.department ?? ''} readOnly /></label>
          {profile.class && <label>Lớp<input value={profile.class} readOnly /></label>}
          {profile.role === 'GIANG_VIEN' && <>
            <label>Học hàm<input name="academicTitle" defaultValue={profile.academic_title ?? ''} /></label>
            <label>Học vị<input name="degree" defaultValue={profile.degree ?? ''} /></label>
            <label>Chuyên môn<input name="specialization" defaultValue={profile.specialization ?? ''} /></label>
          </>}
          <label>Số điện thoại<input name="phone" type="tel" defaultValue={profile.phone ?? ''} maxLength={30} /></label>
          <button className="dark-button" disabled={busy}>Lưu thông tin</button>
        </form> : <p>Đang tải hồ sơ…</p>
      ) : (
        <>
          <article className="settings-card">
            <h3>Đổi mật khẩu</h3><p>Chọn mật khẩu dài, khó đoán và không dùng lại ở nơi khác.</p>
            <form className="settings-form" onSubmit={changePassword}>
              <label>Mật khẩu hiện tại<input name="currentPassword" type="password" autoComplete="current-password" required /></label>
              <label>Mật khẩu mới<input name="newPassword" type="password" minLength={12} autoComplete="new-password" required /></label>
              <label>Nhập lại mật khẩu mới<input name="confirmPassword" type="password" minLength={12} autoComplete="new-password" required /></label>
              <button className="dark-button" disabled={busy}>Cập nhật mật khẩu</button>
            </form>
          </article>
          <article className="settings-card">
            <h3>Xác thực hai lớp</h3>
            {!security ? <p>Đang tải phương thức bảo mật…</p> : <p>{security.totpEnabled || security.passkeys.length ? 'Đã bật xác thực bổ sung khi đăng nhập.' : 'Chưa bật. Chọn Google Authenticator hoặc Passkey.'}</p>}
            {security?.totpEnabled ? <>
              <p>Google Authenticator đang bật · còn {security.recoveryCodesRemaining} mã khôi phục.</p>
              <form className="settings-inline-form" onSubmit={disableTotp}><input name="currentPassword" type="password" placeholder="Mật khẩu hiện tại" required /><input name="code" placeholder="Mã 6 số" inputMode="numeric" required /><button className="outline-button" disabled={busy}>Tắt Authenticator</button></form>
            </> : !totpSetup && security ? <form className="settings-inline-form" onSubmit={setupTotp}><input name="currentPassword" type="password" placeholder="Mật khẩu hiện tại" required /><button className="dark-button" disabled={busy}>Thiết lập Google Authenticator</button></form> : totpSetup ? <div className="totp-setup"><img src={totpSetup.qr} alt="Mã QR thiết lập Google Authenticator" /><p>Không quét được? Nhập khóa thiết lập:</p><code>{totpSetup.secret}</code><form className="settings-inline-form" onSubmit={confirmTotp}><input name="code" placeholder="Mã 6 số trong ứng dụng" inputMode="numeric" required /><button className="dark-button" disabled={busy}>Xác nhận và bật</button></form></div> : null}
            <form className="settings-inline-form passkey-form" onSubmit={addPasskey}><input name="label" placeholder="Tên thiết bị, ví dụ Laptop cá nhân" maxLength={80} /><input name="currentPassword" type="password" placeholder="Mật khẩu hiện tại" required /><button className="dark-button" disabled={busy || !security}>Thêm Passkey</button></form>
            {security?.passkeys.length ? <div className="passkey-list"><h4>Passkey đã đăng ký</h4>{security.passkeys.map((passkey) => <div className="passkey-row" key={passkey.id}><span><strong>{passkey.label || 'Passkey'}</strong><small>Thêm {new Date(passkey.created_at).toLocaleDateString('vi-VN')}</small></span><button type="button" className="outline-button" disabled={busy} onClick={() => void removePasskey(passkey.id)}>Xóa</button></div>)}</div> : null}
            {recoveryCodes.length > 0 && <div className="recovery-codes"><strong>Mã khôi phục — chỉ hiện lần này</strong><p>Lưu ở nơi an toàn. Mỗi mã chỉ dùng một lần.</p><div>{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><button type="button" className="outline-button" onClick={() => setRecoveryCodes([])}>Đã lưu, ẩn mã</button></div>}
          </article>
        </>
      )}
    </section>
  )
}
