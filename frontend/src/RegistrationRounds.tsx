import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'

type Round = { id: string; code: string; opens_at: string; closes_at: string; is_open: boolean; window_state: 'CLOSED'|'SCHEDULED'|'EXPIRED'|'OPEN'; semester_code: string; semester_name: string; semester_start: string; semester_end: string }
const API = '/api/admin'
const displayDate = (value: string) => new Date(value).toLocaleString('vi-VN')
const stateName = { CLOSED: 'Đã đóng thủ công', SCHEDULED: 'Chưa đến giờ mở', EXPIRED: 'Đã hết hạn', OPEN: 'Đang nhận đăng ký' } as const

export default function RegistrationRounds({ token }: { token: string }) {
  const [rounds, setRounds] = useState<Round[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = useCallback(async () => {
    const response = await fetch(`${API}/rounds`, { headers: { Authorization: `Bearer ${token}` } })
    const result = await response.json().catch(() => [])
    if (!response.ok) throw new Error(result.error ?? 'Không tải được các đợt đăng ký.')
    setRounds(result as Round[])
  }, [token])

  useEffect(() => { load().catch((reason: Error) => setError(reason.message)) }, [load])

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    const payload = { ...values, opensAt: new Date(String(values.opensAt)).toISOString(), closesAt: new Date(String(values.closesAt)).toISOString() }
    setBusy(true); setError('')
    try {
      const response = await fetch(`${API}/rounds`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Không tạo được đợt đăng ký.')
      form.reset()
      await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không tạo được đợt đăng ký.') }
    finally { setBusy(false) }
  }

  async function toggle(round: Round) {
    setBusy(true); setError('')
    try {
      const response = await fetch(`${API}/rounds/${round.id}`, { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ isOpen: !round.is_open }) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Không thay đổi được trạng thái đợt.')
      await load()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thay đổi được trạng thái đợt.') }
    finally { setBusy(false) }
  }

  return <section className="content-card registration-rounds" id="rounds">
    <div className="card-heading"><div><h2>Học kỳ và đợt đăng ký</h2><p>Mã học kỳ và mã đợt được tự sinh; đợt đóng mặc định cho đến khi quản trị viên mở.</p></div></div>
    {error && <p className="account-message" role="alert">{error}</p>}
    <form className="round-form" onSubmit={create}>
      <label>Học kỳ<select name="semesterNumber" defaultValue="1" required><option value="1">Học kỳ 1</option><option value="2">Học kỳ 2</option></select></label>
      <label>Ngày bắt đầu học kỳ<input name="semesterStart" type="date" required/></label>
      <label>Ngày kết thúc học kỳ<input name="semesterEnd" type="date" required/></label>
      <label>Mở nhận đăng ký<input name="opensAt" type="datetime-local" required/></label>
      <label>Đóng nhận đăng ký<input name="closesAt" type="datetime-local" required/></label>
      <button className="dark-button" disabled={busy}>Tạo đợt</button>
    </form>
    <div className="table-wrap"><table><thead><tr><th>HỌC KỲ</th><th>ĐỢT</th><th>THỜI GIAN NHẬN</th><th>TRẠNG THÁI</th><th></th></tr></thead><tbody>
      {rounds.length ? rounds.map((round) => <tr key={round.id}><td>{round.semester_name} ({round.semester_code})</td><td>{round.code}</td><td>{displayDate(round.opens_at)} – {displayDate(round.closes_at)}</td><td><span className={`status-pill round-${round.window_state.toLowerCase()}`}>{stateName[round.window_state]}</span></td><td><button className="outline-button" disabled={busy || round.window_state === 'EXPIRED'} onClick={() => void toggle(round)}>{round.is_open ? 'Đóng đợt' : 'Mở đợt'}</button></td></tr>) : <tr><td colSpan={5} className="empty-state">Chưa có đợt đăng ký.</td></tr>}
    </tbody></table></div>
  </section>
}
