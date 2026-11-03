import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import PersonalSettings from './PersonalSettings'
import { api, fetchWithTimeout as fetch, newRequestId, shouldRetainQueuedRequest } from './api'

type Topic = {
  id: string; code: string; title: string; description?: string; lecturer?: string; department?: string
  published?: boolean; pending?: number; registered?: number; capacity?: number | null
  round_id?: string; round_code?: string; round_codes?: string; opens_at?: string; closes_at?: string
  semester_start?: string; semester_end?: string
}
type Registration = {
  id: string; code?: string; title?: string; status: string; round_id?: string; submitted_at?: string
  reason?: string; note?: string; history?: { new_status: string; changed_at: string; note?: string }[]; student_code?: string; student_name?: string; topic_id?: string
  topic_code?: string; topic_title?: string; round_code?: string
}
type PendingRegistration = {
  requestId: string; topicId: string; roundId: string; topicCode: string; topicTitle: string
  roundCode: string; reason: string; createdAt: string
}
type RegistrationRound = { id: string; code: string; opens_at: string; closes_at: string; is_open: boolean; semester_code: string; semester_name: string; semester_start?: string; semester_end?: string }
type PortalData = {
  role: 'SINH_VIEN' | 'GIANG_VIEN'
  profile: { ho_ten: string; ma_sinh_vien?: string; ma_giang_vien?: string; lop?: string } | null
  topics: Topic[]
  registrations?: Registration[]
  serverTime?: string
}

const API = '/api'
const statusNames: Record<string, string> = { DANG_CHO_XU_LY: 'Chờ kết nối để xử lý', CHO_DUYET: 'Chờ duyệt', DA_DUYET: 'Đã duyệt', TU_CHOI: 'Từ chối', DA_HUY: 'Đã hủy' }
const localDateTime = (value?: string) => value ? new Date(value).toLocaleString('vi-VN') : '—'
const addDays = (dateStr: string, days: number): string => {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d + days))
  return dt.toISOString().slice(0, 10)
}
const subjectFromToken = (token: string) => {
  try {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return String(JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).sub ?? 'unknown')
  } catch { return 'unknown' }
}
const readSessionValue = <T,>(key: string): T | null => {
  try { const value = sessionStorage.getItem(key); return value ? JSON.parse(value) as T : null } catch { return null }
}
const readLocalList = <T,>(key: string): T[] => {
  try { const value = localStorage.getItem(key); const parsed: unknown = value ? JSON.parse(value) : []; return Array.isArray(parsed) ? parsed as T[] : [] } catch { return [] }
}

export default function Portal({ token, onLogout, onTokenChange }: { token: string; onLogout: () => void; onTokenChange: (token: string) => void }) {
  const subject = subjectFromToken(token)
  const dataCacheKey = `qldetai:portal-cache:${subject}`
  const outboxKey = `qldetai:registration-outbox:${subject}`
  const [data, setData] = useState<PortalData | null>(() => readSessionValue<PortalData>(dataCacheKey))
  const [rounds, setRounds] = useState<RegistrationRound[]>([])
  const [roundsError, setRoundsError] = useState('')
  const [selectedRoundId, setSelectedRoundId] = useState('')
  const [topicOpensAt, setTopicOpensAt] = useState('')
  const [topicClosesAt, setTopicClosesAt] = useState('')
  const [pendingRegistrations, setPendingRegistrations] = useState<PendingRegistration[]>(() => readLocalList<PendingRegistration>(outboxKey))
  const pendingRef = useRef(pendingRegistrations)
  const syncingRef = useRef(false)
  const [page, setPage] = useState<'home'|'registrations'|'review'|'profile'|'settings'>('home')
  const [query, setQuery] = useState('')
  const [stale, setStale] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const body = await api<PortalData>('/portal/overview', token)
    setData(body)
    try { sessionStorage.setItem(dataCacheKey, JSON.stringify(body)) } catch { }
    setStale(false); setError('')
  }, [dataCacheKey, token])

  useEffect(() => {
    const refresh = () => void reload().catch((reason: Error) => {
      setStale(true)
      if (!readSessionValue<PortalData>(dataCacheKey)) setError(reason.message)
    })
    refresh()
    const interval = window.setInterval(refresh, 15000)
    window.addEventListener('online', refresh)
    return () => { window.clearInterval(interval); window.removeEventListener('online', refresh) }
  }, [dataCacheKey, reload])

  useEffect(() => {
    if (data?.role !== 'GIANG_VIEN') return
    let cancelled = false
    fetch(`${API}/portal/rounds`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (response) => {
        const result = await response.json().catch(() => [])
        if (!response.ok) throw new Error(result.error ?? 'Không tải được các đợt đăng ký.')
        if (!cancelled) { setRounds(result as RegistrationRound[]); setRoundsError('') }
      })
      .catch((reason: Error) => { if (!cancelled) setRoundsError(reason.message) })
    return () => { cancelled = true }
  }, [data?.role, token])

  const savePending = useCallback((next: PendingRegistration[]) => {
    pendingRef.current = next
    setPendingRegistrations(next)
    try { localStorage.setItem(outboxKey, JSON.stringify(next)) } catch { }
  }, [outboxKey])

  const sendPending = useCallback(async (item: PendingRegistration) => {
    try {
      const response = await fetch(`${API}/portal/registrations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: item.requestId, topicId: item.topicId, roundId: item.roundId, reason: item.reason }),
      })
      const result = await response.json().catch(() => ({}))
      if (shouldRetainQueuedRequest(response.status)) {
        setMessage('Kết nối máy chủ đang gián đoạn. Yêu cầu đã được lưu và sẽ tự gửi lại khi kết nối phục hồi.')
        return false
      }
      if (!response.ok) {
        savePending(pendingRef.current.filter((queued) => queued.requestId !== item.requestId))
        setError(result.error ?? 'Không thể gửi đăng ký.')
        setMessage('')
        return true
      }
      savePending(pendingRef.current.filter((queued) => queued.requestId !== item.requestId))
      setError('')
      setMessage('Đăng ký đã được hệ thống tiếp nhận.')
      void reload().catch(() => setMessage('Đăng ký đã được tiếp nhận. Danh sách sẽ đồng bộ khi kết nối phục hồi.'))
      return true
    } catch {
      setMessage('Đang ngoại tuyến. Yêu cầu đã được lưu và sẽ tự gửi lại khi kết nối phục hồi.')
      return false
    }
  }, [reload, savePending, token])

  useEffect(() => {
    if (data?.role !== 'SINH_VIEN') return
    const retryQueue = async () => {
      if (syncingRef.current || !navigator.onLine || pendingRef.current.length === 0) return
      syncingRef.current = true
      setBusy(true)
      try {
        for (const item of pendingRef.current) {
          if (!await sendPending(item)) break
        }
      } finally { syncingRef.current = false; setBusy(false) }
    }
    const interval = window.setInterval(() => void retryQueue(), 10000)
    window.addEventListener('online', retryQueue)
    void retryQueue()
    return () => { window.clearInterval(interval); window.removeEventListener('online', retryQueue) }
  }, [data?.role, sendPending])

  async function registerTopic(topic: Topic, reason: string) {
    if (syncingRef.current) return
    const item: PendingRegistration = {
      requestId: newRequestId(), topicId: topic.id, roundId: topic.round_id!,
      topicCode: topic.code, topicTitle: topic.title, roundCode: topic.round_code ?? '', reason, createdAt: new Date().toISOString(),
    }
    syncingRef.current = true
    savePending([...pendingRef.current, item])
    setBusy(true); setError(''); setMessage('Đang gửi yêu cầu đăng ký…')
    try { await sendPending(item) }
    finally { syncingRef.current = false; setBusy(false) }
  }

  async function submit(path: string, method: string, payload?: unknown) {
    setBusy(true); setError(''); setMessage('')
    try {
      const response = await fetch(`${API}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error ?? 'Không thực hiện được yêu cầu.')
      await reload().catch(() => setStale(true))
      setMessage('Đã lưu thay đổi.')
      return true
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thực hiện được yêu cầu.'); return false }
    finally { setBusy(false) }
  }

  async function createTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    const round = rounds.find((item) => item.id === values.roundId)
    if (values.opensAt && values.closesAt) {
      const open = new Date(String(values.opensAt))
      const close = new Date(String(values.closesAt))
      if (open >= close) {
        setMessage('Thời gian đóng nhận đăng ký phải sau thời gian mở.')
        return
      }
      if (round?.semester_start) {
        const semStartEndOfDay = new Date(`${round.semester_start}T23:59:59`)
        if (open <= semStartEndOfDay) {
          setMessage(`Ngày mở nhận đăng ký phải sau ngày bắt đầu học kỳ (từ ngày ${addDays(round.semester_start, 1)} trở đi).`)
          return
        }
      }
      if (round?.semester_end) {
        const semEndStartOfDay = new Date(`${round.semester_end}T00:00:00`)
        if (close >= semEndStartOfDay) {
          setMessage(`Ngày đóng nhận đăng ký phải trước ngày kết thúc học kỳ (trước ngày ${round.semester_end}).`)
          return
        }
      }
      values.opensAt = open.toISOString()
      values.closesAt = close.toISOString()
    }
    if (await submit('/portal/topics', 'POST', values)) {
      form.reset()
      setSelectedRoundId('')
      setTopicOpensAt('')
      setTopicClosesAt('')
    }
  }

  if (error && !data) return <main className="portal-error"><p>{error}</p><button className="outline-button" onClick={() => void reload().catch((reason: Error) => setError(reason.message))}>Thử lại</button><button className="dark-button" onClick={onLogout}>Đăng xuất</button></main>
  if (!data) return <main className="portal-error">Đang tải cổng thông tin…</main>

  const student = data.role === 'SINH_VIEN'
  const name = data.profile?.ho_ten ?? 'Người dùng'
  const registrations = data.registrations ?? []
  const lecturerRegistrations = registrations.filter((item) => item.status !== 'DA_HUY')
  const filteredTopics = data.topics.filter((topic) => `${topic.title} ${topic.code} ${topic.lecturer ?? ''} ${topic.department ?? ''}`.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi')))
  const visibleRegistrations: Registration[] = student
    ? [...pendingRegistrations.filter((item) => !registrations.some((registration) => registration.id === item.requestId)).map((item) => ({
      id: item.requestId, code: item.topicCode, title: item.topicTitle, status: 'DANG_CHO_XU_LY',
      round_id: item.roundId, round_code: item.roundCode, submitted_at: item.createdAt,
    })), ...registrations]
    : lecturerRegistrations
  return (
    <main className="user-portal">
      <header className="portal-header"><a className="portal-brand" href="/portal">DEMO</a><nav aria-label="Cổng người dùng"><button className={page === 'home' ? 'selected' : ''} onClick={() => setPage('home')}>{student ? 'Tìm đề tài' : 'Đề tài của tôi'}</button><button className={page === (student ? 'registrations' : 'review') ? 'selected' : ''} onClick={() => setPage(student ? 'registrations' : 'review')}>{student ? 'Đăng ký của tôi' : 'Duyệt đăng ký'}</button><button className={page === 'profile' ? 'selected' : ''} onClick={() => setPage('profile')}>Hồ sơ</button><button className={page === 'settings' ? 'selected' : ''} onClick={() => setPage('settings')}>Cài đặt</button></nav><div className="portal-user"><span>{name}</span><button onClick={onLogout}>Đăng xuất</button></div></header>
      <section className="portal-main" id="home">
        <p className="eyebrow">CỔNG {student ? 'SINH VIÊN' : 'GIẢNG VIÊN'}</p>
        <div className="page-heading"><h1>{page === 'home' ? `Xin chào, ${name}` : page === 'registrations' ? 'Đăng ký của tôi' : page === 'review' ? 'Duyệt đăng ký' : page === 'profile' ? 'Hồ sơ cá nhân' : 'Cài đặt tài khoản'}</h1><button className="outline-button" disabled={busy} onClick={() => void reload().catch(() => setStale(true))}>Làm mới</button></div>
        {page === 'home' && <p className="portal-intro">{student ? 'Khám phá đề tài phù hợp và theo dõi tiến độ đăng ký.' : 'Quản lý đề tài hướng dẫn và xử lý đăng ký của sinh viên.'}</p>}

        {stale && <p className="account-message" role="status">Đang hiển thị dữ liệu đã tải trước đó. Yêu cầu đăng ký được giữ ở trạng thái chờ; hệ thống tự đồng bộ khi kết nối phục hồi.</p>}
        {error && <p className="account-message" role="alert">{error}</p>}{message && <p className="account-message" role="status">{message}</p>}
        {page === 'home' && <section className="portal-summary">
          <article><span>{student ? 'MÃ SINH VIÊN' : 'MÃ GIẢNG VIÊN'}</span><strong>{data.profile?.ma_sinh_vien ?? data.profile?.ma_giang_vien ?? '—'}</strong></article>
          {student && <article><span>LỚP</span><strong>{data.profile?.lop ?? '—'}</strong></article>}
          <article><span>{student ? 'ĐỀ TÀI ĐANG MỞ' : 'ĐỀ TÀI CỦA TÔI'}</span><strong>{data.topics.length}</strong></article>
          {student && <article><span>ĐƠN ĐĂNG KÝ</span><strong>{visibleRegistrations.length}</strong></article>}
          {!student && <article><span>ĐĂNG KÝ CHỜ DUYỆT</span><strong>{lecturerRegistrations.filter((item) => item.status === 'CHO_DUYET').length}</strong></article>}
        </section>}
        {page === 'profile' ? <PersonalSettings token={token} page="profile" onTokenChange={onTokenChange}/> : page === 'settings' ? <PersonalSettings token={token} page="settings" onTokenChange={onTokenChange}/> : student ? <>
          <section className="portal-section" id="topics" hidden={page !== 'home'}>
            <div className="portal-section-head"><div><h2>Đề tài đang mở</h2><p>Chỉ hiển thị đề tài trong thời hạn của đợt đăng ký</p></div></div>
            <div className="filter-bar"><input aria-label="Tìm đề tài" placeholder="Tìm tên đề tài, mã, giảng viên hoặc khoa" value={query} onChange={(event) => setQuery(event.target.value)}/></div>
            <div className="topic-grid">{filteredTopics.length ? filteredTopics.map((topic) => {
              const existing = registrations.find((item) => item.round_id === topic.round_id && ['CHO_DUYET', 'DA_DUYET'].includes(item.status))
              const queued = pendingRegistrations.some((item) => item.roundId === topic.round_id)
              const full = topic.capacity != null && (topic.registered ?? 0) >= topic.capacity
              return <article className="topic-card" key={`${topic.id}-${topic.round_id}`}>
                <span className="topic-code">{topic.code} · Đợt {topic.round_code}</span><h3>{topic.title}</h3><p>{topic.description || 'Chưa có mô tả.'}</p>
                <div className="topic-meta">{topic.lecturer ?? 'Giảng viên'} · {topic.department ?? 'Khoa'}<br/>Hạn: {localDateTime(topic.closes_at)}<br/>Số lượng: {topic.capacity == null ? 'Không giới hạn' : `${topic.registered ?? 0}/${topic.capacity}`}</div>
                <form onSubmit={(event) => { event.preventDefault(); void registerTopic(topic, String(new FormData(event.currentTarget).get('reason') ?? '').trim()) }}>
                  <input name="reason" aria-label="Lý do đăng ký (không bắt buộc)" placeholder="Lý do đăng ký (không bắt buộc)"/>
                  <button className="dark-button" disabled={busy || queued || Boolean(existing) || full}>{queued ? 'Đang chờ xử lý' : existing ? 'Đã có đăng ký trong đợt' : full ? 'Đề tài đã đủ số lượng' : 'Gửi đăng ký'}</button>
                </form>
              </article>
            }) : <div className="portal-empty">{query ? 'Không có đề tài phù hợp với từ khóa.' : 'Hiện không có đề tài nào đang trong thời hạn đăng ký.'}</div>}</div>
          </section>
          <section className="portal-section" id="registrations" hidden={page !== 'registrations'}><h2>Lịch sử đăng ký</h2><div className="portal-table">{visibleRegistrations.length ? visibleRegistrations.map((item) => <div className="portal-row" key={item.id}><span>{item.code}</span><strong>{item.title}</strong><em className={item.status === 'DANG_CHO_XU_LY' ? 'pending-status' : undefined}>{statusNames[item.status] ?? item.status}</em><small>{localDateTime(item.submitted_at)}</small>{item.note && <span className="registration-note">Phản hồi: {item.note}</span>}{item.status === 'DANG_CHO_XU_LY' && <button className="outline-button" disabled={busy} onClick={() => { savePending(pendingRef.current.filter((queued) => queued.requestId !== item.id)); setMessage('Đã bỏ yêu cầu chưa gửi. Đăng ký chưa được máy chủ tiếp nhận.') }}>Bỏ yêu cầu chưa gửi</button>}{item.status === 'CHO_DUYET' && <button className="outline-button" disabled={busy} onClick={() => void submit(`/portal/registrations/${item.id}/cancel`, 'PATCH')}>Hủy đơn</button>}</div>) : <div className="portal-empty">Bạn chưa gửi đăng ký đề tài nào.</div>}</div></section>
        </> : <>
          <section className="portal-section" id="my-topics" hidden={page !== 'home'}>
            <div className="portal-section-head"><div><h2>Đề tài của tôi</h2><p>Tạo bản nháp, chọn đợt nhận đăng ký do quản trị viên cấu hình</p></div></div>
            {roundsError && <p className="account-message" role="alert">{roundsError}</p>}
            {rounds.length === 0 && !roundsError && <p className="account-message">Chưa có đợt đăng ký còn hạn. Hãy nhờ quản trị viên tạo đợt trước.</p>}
            <form className="topic-create-form" onSubmit={createTopic}>
              <label className="topic-title-field">Tên đề tài<input name="title" required maxLength={240}/></label>
              <label className="topic-description-field">Mô tả<textarea name="description" rows={3}/></label>
              <label>Đợt đăng ký<select name="roundId" value={selectedRoundId} onChange={(e) => { setSelectedRoundId(e.target.value); setTopicOpensAt(''); setTopicClosesAt('') }} required disabled={rounds.filter((r) => r.is_open).length === 0}><option value="">Chọn đợt đăng ký</option>{rounds.filter((r) => r.is_open).map((round) => <option key={round.id} value={round.id}>{round.semester_code} · {round.semester_name} · {round.code}{round.semester_start && round.semester_end ? ` · Học kỳ: ${round.semester_start} – ${round.semester_end}` : ''}</option>)}</select></label>
              <label>Mở nhận đăng ký<input name="opensAt" type="datetime-local" required value={topicOpensAt} min={rounds.find((r) => r.id === selectedRoundId)?.semester_start ? `${addDays(rounds.find((r) => r.id === selectedRoundId)!.semester_start!, 1)}T00:00` : undefined} max={topicClosesAt || (rounds.find((r) => r.id === selectedRoundId)?.semester_end ? `${addDays(rounds.find((r) => r.id === selectedRoundId)!.semester_end!, -1)}T23:59` : undefined)} onChange={(e) => setTopicOpensAt(e.target.value)}/></label>
              <label>Đóng nhận đăng ký<input name="closesAt" type="datetime-local" required value={topicClosesAt} min={topicOpensAt || (rounds.find((r) => r.id === selectedRoundId)?.semester_start ? `${addDays(rounds.find((r) => r.id === selectedRoundId)!.semester_start!, 1)}T00:00` : undefined)} max={rounds.find((r) => r.id === selectedRoundId)?.semester_end ? `${addDays(rounds.find((r) => r.id === selectedRoundId)!.semester_end!, -1)}T23:59` : undefined} onChange={(e) => setTopicClosesAt(e.target.value)}/></label>
              <label>Số lượng<input name="capacity" type="number" min="1" step="1" required/></label>
              <button className="dark-button" disabled={busy || rounds.length === 0}>Tạo bản nháp</button>
            </form>
            <p className="topic-round-note">Cấu hình thời gian mở và đóng nhận đăng ký cho đề tài.</p>
            <div className="portal-table">{data.topics.length ? data.topics.map((topic) => <article key={topic.id}>
              <div className="portal-row"><span>{topic.code}{topic.round_codes ? ` · Đợt ${topic.round_codes}` : ''}</span><strong>{topic.title}</strong><em>{topic.pending ?? 0} chờ duyệt · {topic.registered ?? 0} đang hiệu lực</em><small>{topic.published ? 'Đã công bố' : 'Bản nháp'}</small><button className="outline-button" disabled={busy || (Boolean(topic.published) && Boolean(topic.registered))} onClick={() => void submit(`/portal/topics/${topic.id}/publication`, 'PATCH', { published: !topic.published })}>{topic.published ? 'Ẩn đề tài' : 'Công bố'}</button></div>
              {!topic.published && !topic.registered && <details className="topic-editor"><summary>Sửa bản nháp</summary><form onSubmit={(event) => {
                event.preventDefault();
                const val = Object.fromEntries(new FormData(event.currentTarget).entries());
                const open = val.opensAt ? new Date(String(val.opensAt)) : null;
                const close = val.closesAt ? new Date(String(val.closesAt)) : null;
                if (open && close && open >= close) { setMessage('Thời gian đóng nhận đăng ký phải sau thời gian mở.'); return }
                if (topic.semester_start && open) {
                  const semStartEndOfDay = new Date(`${topic.semester_start}T23:59:59`);
                  if (open <= semStartEndOfDay) { setMessage(`Ngày mở nhận đăng ký phải sau ngày bắt đầu học kỳ (từ ngày ${addDays(topic.semester_start, 1)} trở đi).`); return }
                }
                if (topic.semester_end && close) {
                  const semEndStartOfDay = new Date(`${topic.semester_end}T00:00:00`);
                  if (close >= semEndStartOfDay) { setMessage(`Ngày đóng nhận đăng ký phải trước ngày kết thúc học kỳ (trước ngày ${topic.semester_end}).`); return }
                }
                if (val.opensAt) val.opensAt = open!.toISOString();
                if (val.closesAt) val.closesAt = close!.toISOString();
                void submit(`/portal/topics/${topic.id}`, 'PATCH', val)
              }}><label>Tên đề tài<input name="title" defaultValue={topic.title} maxLength={240} required/></label><label>Mô tả<textarea name="description" defaultValue={topic.description ?? ''} rows={3}/></label><label>Mở nhận đăng ký<input name="opensAt" type="datetime-local" defaultValue={topic.opens_at ? new Date(new Date(topic.opens_at).getTime() - new Date().getTimezoneOffset()*60000).toISOString().slice(0, 16) : ''} min={topic.semester_start ? `${addDays(topic.semester_start, 1)}T00:00` : undefined} max={topic.semester_end ? `${addDays(topic.semester_end, -1)}T23:59` : undefined}/></label><label>Đóng nhận đăng ký<input name="closesAt" type="datetime-local" defaultValue={topic.closes_at ? new Date(new Date(topic.closes_at).getTime() - new Date().getTimezoneOffset()*60000).toISOString().slice(0, 16) : ''} min={topic.semester_start ? `${addDays(topic.semester_start, 1)}T00:00` : undefined} max={topic.semester_end ? `${addDays(topic.semester_end, -1)}T23:59` : undefined}/></label><label>Số lượng<input name="capacity" type="number" min="1" step="1" defaultValue={topic.capacity ?? 1} required/></label><button className="dark-button" disabled={busy}>Lưu bản nháp</button></form></details>}
            </article>) : <div className="portal-empty">Bạn chưa có đề tài hướng dẫn.</div>}</div>
          </section>
          <section className="portal-section" id="review" hidden={page !== 'review'}><h2>Đăng ký của sinh viên</h2><div className="portal-table">{lecturerRegistrations.length ? lecturerRegistrations.map((item) => <div className="portal-row review-row" key={item.id}><span>{item.student_code}</span><strong>{item.student_name} · {item.topic_title}</strong><small>Đợt {item.round_code} · {localDateTime(item.submitted_at)}</small><em>{statusNames[item.status] ?? item.status}</em>{item.reason && <span className="registration-note">Lý do đăng ký: {item.reason}</span>}{item.note && <span className="registration-note">Phản hồi: {item.note}</span>}{item.history?.length ? <details className="registration-note"><summary>Lịch sử xử lý</summary>{item.history.map((event, index) => <p key={index}>{localDateTime(event.changed_at)} · {statusNames[event.new_status] ?? event.new_status}{event.note ? ` · ${event.note}` : ''}</p>)}</details> : null}{item.status === 'CHO_DUYET' && <><button className="dark-button" disabled={busy} onClick={() => void submit(`/portal/registrations/${item.id}/decision`, 'PATCH', { status: 'DA_DUYET' })}>Duyệt</button><button className="outline-button" disabled={busy} onClick={() => { const note = window.prompt('Nhập lý do từ chối:'); if (note?.trim()) void submit(`/portal/registrations/${item.id}/decision`, 'PATCH', { status: 'TU_CHOI', note }) }}>Từ chối</button></>}</div>) : <div className="portal-empty">Chưa có đăng ký nào.</div>}</div></section>
        </>}
      </section>
    </main>
  )
}
