import { useCallback, useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { fetchWithTimeout as fetch } from './api'

type Round = { id: string; code: string; opens_at: string; closes_at: string; is_open: boolean; window_state: 'CLOSED'|'SCHEDULED'|'EXPIRED'|'OPEN'; semester_code: string; semester_name: string; semester_start: string; semester_end: string }
const API = '/api/admin'
const displayDate = (value: string) => new Date(value).toLocaleDateString('vi-VN')
const stateName = { CLOSED: 'Đã đóng thủ công', SCHEDULED: 'Chưa đến giờ mở', EXPIRED: 'Đã hết hạn', OPEN: 'Đang nhận đăng ký' } as const

export default function RegistrationRounds({ token }: { token: string }) {
  const [rounds, setRounds] = useState<Round[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [semesterStart, setSemesterStart] = useState('')
  const [semesterEnd, setSemesterEnd] = useState('')

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
    setBusy(true); setError('')
    try {
      if (String(values.semesterStart) >= String(values.semesterEnd)) throw new Error('Ngày kết thúc học kỳ phải sau ngày bắt đầu.')

      const response = await fetch(`${API}/rounds`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Không tạo được đợt đăng ký.')
      form.reset()
      setSemesterStart('')
      setSemesterEnd('')
      await load().catch(() => setError('Đã tạo đợt. Chưa cập nhật được danh sách; hãy làm mới khi kết nối phục hồi.'))
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
    <div className="card-heading"><div><h2>Học kỳ và đợt đăng ký</h2><p>Quản lý thời gian bắt đầu và kết thúc học kỳ. Đợt mới ở trạng thái đóng.</p></div><button className="outline-button" disabled={busy} onClick={() => void load().then(() => setError('')).catch((reason: Error) => setError(reason.message))}>Làm mới</button></div>
    {error && <p className="account-message" role="alert">{error}</p>}
    <details className="form-disclosure"><summary>Tạo học kỳ / đợt mới</summary><form className="round-form" onSubmit={create}>
      <label>Học kỳ<select name="semesterNumber" defaultValue="1" required><option value="1">Học kỳ 1</option><option value="2">Học kỳ 2</option></select></label>
      <label>
        Ngày bắt đầu học kỳ
        <input
          name="semesterStart"
          type="date"
          required
          value={semesterStart}
          max={semesterEnd || undefined}
          onChange={(e) => setSemesterStart(e.target.value)}
        />
      </label>
      <label>
        Ngày kết thúc học kỳ
        <input
          name="semesterEnd"
          type="date"
          required
          value={semesterEnd}
          min={semesterStart || undefined}
          onChange={(e) => setSemesterEnd(e.target.value)}
        />
      </label>
      <button className="dark-button" disabled={busy}>Tạo học kỳ</button>
    </form></details>
    <div className="table-wrap"><table><thead><tr><th>HỌC KỲ</th><th>ĐỢT</th><th>THỜI GIAN HỌC KỲ</th><th>TRẠNG THÁI</th><th></th></tr></thead><tbody>
      {rounds.length ? rounds.map((round) => <tr key={round.id}><td>{round.semester_name} ({round.semester_code})</td><td>{round.code}</td><td>{displayDate(round.semester_start || round.opens_at)} – {displayDate(round.semester_end || round.closes_at)}</td><td><span className={`status-pill round-${round.window_state.toLowerCase()}`}>{stateName[round.window_state]}</span></td><td><button className="outline-button" disabled={busy || round.window_state === 'EXPIRED'} onClick={() => void toggle(round)}>{round.is_open ? 'Đóng đợt' : 'Mở đợt'}</button></td></tr>) : <tr><td colSpan={5} className="empty-state">Chưa có đợt đăng ký.</td></tr>}
    </tbody></table></div>
  </section>
}
