import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import QRCode from 'qrcode'
import { startRegistration } from '@simplewebauthn/browser'
import { fetchWithTimeout as fetch } from './api'

type Profile = { role: string; code: string; name: string; phone: string | null; department: string | null; class?: string | null; academic_title?: string | null; degree?: string | null; specialization?: string | null }
type Security = { totpEnabled: boolean; passkeys: { id: string; label: string | null; transports: string[]; created_at: string; last_used: string | null }[]; recoveryCodesRemaining: number }
const API = '/api'

export default function PersonalSettings({ token, page, onTokenChange }: { token: string; page: 'profile'|'settings'; onTokenChange: (token: string) => void }) {
  const [profile, setProfile] = useState<Profile | null>(null)
  const [security, setSecurity] = useState<Security | null>(null)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [totpSetup, setTotpSetup] = useState<{ secret: string; qr: string } | null>(null)
  const [recoveryCodes, setRecoveryCodes] = useState<string[]>([])
  const [removingPasskey, setRemovingPasskey] = useState('')
  const passkeyAvailable = window.isSecureContext && typeof window.PublicKeyCredential !== 'undefined'

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
    const phone = String(values.phone ?? '').trim()
    if (phone && !/^\d{10}$/.test(phone)) {
      setError('Số điện thoại phải gồm đúng 10 chữ số.')
      return
    }
    if (await send('/portal/profile', 'PATCH', values)) await loadProfile().catch(() => setError('Đã lưu hồ sơ. Chưa cập nhật được dữ liệu, hãy thử làm mới.'))
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
      try { setTotpSetup({ secret: result.secret, qr: await QRCode.toDataURL(result.otpauthUrl, { margin: 1, width: 220 }) }) }
      catch { setError('Không tạo được mã QR. Vui lòng thiết lập lại.'); return }
      setMessage('Quét QR bằng Google Authenticator, sau đó nhập mã 6 số để xác nhận.')
      form.reset()
    }
  }

  async function confirmTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const code = new FormData(event.currentTarget).get('code')
    const result = await send('/portal/security/totp/confirm', 'POST', { code })
    if (result?.enabled) { setRecoveryCodes(result.recoveryCodes as string[]); setTotpSetup(null); await loadSecurity().catch(() => setError('Thao tác đã lưu. Chưa cập nhật được cài đặt bảo mật.')) }
  }

  async function disableTotp(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    if (await send('/portal/security/totp/disable', 'POST', values)) { form.reset(); await loadSecurity().catch(() => setError('Thao tác đã lưu. Chưa cập nhật được cài đặt bảo mật.')) }
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
      form.reset(); setMessage('Đã thêm Passkey trên điện thoại.'); await loadSecurity().catch(() => setError('Thao tác đã lưu. Chưa cập nhật được cài đặt bảo mật.'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thêm được Passkey.') }
    finally { setBusy(false) }
  }

  async function removePasskey(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault()
    const currentPassword = new FormData(event.currentTarget).get('currentPassword')
    if (!currentPassword) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`${API}/portal/security/passkeys/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ currentPassword }) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Không xóa được Passkey.')
      setRemovingPasskey(''); setMessage('Đã xóa Passkey.'); await loadSecurity().catch(() => setError('Thao tác đã lưu. Chưa cập nhật được cài đặt bảo mật.'))
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không xóa được Passkey.') }
    finally { setBusy(false) }
  }

  return (
    <section className="personal-settings-page">
      <p className="eyebrow">TÀI KHOẢN CỦA TÔI</p>
      <h2>{page === 'profile' ? 'Thông tin cá nhân' : 'Cài đặt tài khoản'}</h2>
      {error && <p className="account-message" role="alert">{error}</p>}
      {message && <p className="account-message" role="status">{message}</p>}
      {error && <button className="outline-button" onClick={() => void (page === 'profile' ? loadProfile() : loadSecurity()).then(() => setError('')).catch((reason: Error) => setError(reason.message))}>Tải lại dữ liệu</button>}
      {page === 'profile' ? (
        profile ? <form className="personal-profile-form" onSubmit={saveProfile}>
          <label>Mã tài khoản<input value={profile.code} readOnly /></label>
          <label>Họ và tên<input value={profile.name} readOnly /></label>
          <label>Khoa<input value={profile.department ?? ''} readOnly /></label>
          {profile.class && <label>Lớp<input value={profile.class} readOnly /></label>}
          {profile.role === 'GIANG_VIEN' && <>

            <label>Học vị<input name="degree" defaultValue={profile.degree ?? ''} /></label>
            <label>Chuyên môn<input name="specialization" defaultValue={profile.specialization ?? ''} /></label>
          </>}
          <label>Số điện thoại<input name="phone" type="tel" defaultValue={profile.phone ?? ''} maxLength={10} pattern="[0-9]{10}" placeholder="10 chữ số" title="Số điện thoại phải gồm đúng 10 chữ số" onInput={(e) => { e.currentTarget.value = e.currentTarget.value.replace(/\D/g, '').slice(0, 10) }} /></label>
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
            <p className="muted">Để thêm Passkey, bật Bluetooth trên máy tính và điện thoại, đặt hai thiết bị gần nhau. Trong hộp thoại của trình duyệt, chọn dùng điện thoại hoặc thiết bị khác rồi dùng camera điện thoại quét mã QR.</p>
            {!passkeyAvailable && <p className="muted">Passkey cần HTTPS hoặc localhost và trình duyệt hỗ trợ WebAuthn. Có thể dùng Google Authenticator nếu thiết bị chưa hỗ trợ.</p>}
            <form className="settings-inline-form passkey-form" onSubmit={addPasskey}><input name="label" placeholder="Tên điện thoại, ví dụ Điện thoại cá nhân" maxLength={80} /><input name="currentPassword" type="password" placeholder="Mật khẩu hiện tại" required /><button className="dark-button" disabled={busy || !security || !passkeyAvailable}>Thêm Passkey bằng điện thoại</button></form>
            {security?.passkeys.length ? <div className="passkey-list"><h4>Passkey đã đăng ký</h4>{security.passkeys.map((passkey) => <div className="passkey-row" key={passkey.id}><span><strong>{passkey.label || 'Passkey'}</strong><small>{passkey.transports?.includes('hybrid') ? 'Điện thoại' : 'Passkey cũ · nên thay bằng điện thoại'} · Thêm {new Date(passkey.created_at).toLocaleDateString('vi-VN')}</small></span><button type="button" className="outline-button" disabled={busy} onClick={() => setRemovingPasskey(removingPasskey === passkey.id ? '' : passkey.id)}>Xóa</button>{removingPasskey === passkey.id && <form className="settings-inline-form" onSubmit={(event) => void removePasskey(event, passkey.id)}><input name="currentPassword" aria-label="Mật khẩu để xóa Passkey" type="password" autoComplete="current-password" placeholder="Mật khẩu hiện tại" required/><button className="dark-button" disabled={busy}>Xác nhận xóa</button><button type="button" className="outline-button" onClick={() => setRemovingPasskey('')}>Hủy</button></form>}</div>)}</div> : null}
            {recoveryCodes.length > 0 && <div className="recovery-codes"><strong>Mã khôi phục — chỉ hiện lần này</strong><p>Lưu ở nơi an toàn. Mỗi mã chỉ dùng một lần.</p><div>{recoveryCodes.map((code) => <code key={code}>{code}</code>)}</div><button type="button" className="outline-button" onClick={() => setRecoveryCodes([])}>Đã lưu, ẩn mã</button></div>}
          </article>
        </>
      )}
    </section>
  )
}
