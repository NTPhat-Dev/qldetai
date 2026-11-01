import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import PersonalSettings from './PersonalSettings'

type Topic = {
  id: string; code: string; title: string; description?: string; lecturer?: string; department?: string
  published?: boolean; pending?: number; registered?: number; capacity?: number | null
  round_id?: string; round_code?: string; opens_at?: string; closes_at?: string
}
type Registration = {
  id: string; code?: string; title?: string; status: string; round_id?: string; submitted_at?: string
  reason?: string; student_code?: string; student_name?: string; topic_id?: string
  topic_code?: string; topic_title?: string; round_code?: string
}
type PendingRegistration = {
  requestId: string; topicId: string; roundId: string; topicCode: string; topicTitle: string
  roundCode: string; reason: string; createdAt: string
}
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
  const [pendingRegistrations, setPendingRegistrations] = useState<PendingRegistration[]>(() => readLocalList<PendingRegistration>(outboxKey))
  const pendingRef = useRef(pendingRegistrations)
  const syncingRef = useRef(false)
  const [page, setPage] = useState<'home'|'profile'|'settings'>('home')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    let lastError: Error | null = null
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(`${API}/portal/overview`, { headers: { Authorization: `Bearer ${token}` } })
        const body = await response.json().catch(() => ({}))
        if (!response.ok) {
          if (response.status < 500 || attempt === 3) throw new Error(body.error ?? 'Không thể tải dữ liệu tài khoản.')
          lastError = new Error(body.error ?? 'Dịch vụ đang khôi phục kết nối…')
        } else {
          setData(body as PortalData)
          try { sessionStorage.setItem(dataCacheKey, JSON.stringify(body)) } catch { }
          setError('')
          return
        }
      } catch (reason) {
        lastError = reason instanceof Error ? reason : new Error('Không kết nối được dịch vụ.')
        if (attempt === 3) throw lastError
      }
      await new Promise((resolve) => window.setTimeout(resolve, 700 * (attempt + 1)))
    }
    throw lastError ?? new Error('Không thể tải dữ liệu tài khoản.')
  }, [dataCacheKey, token])

  useEffect(() => {
    reload().catch((reason: Error) => {
      if (readSessionValue<PortalData>(dataCacheKey)) {
        setError('')
        setMessage('Đang hiển thị danh sách đã tải trước đó. Hệ thống sẽ cập nhật lại khi kết nối phục hồi.')
      } else setError(reason.message)
    })
  }, [dataCacheKey, reload])

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
      if (response.status >= 500) {
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
      try {
        for (const item of pendingRef.current) {
          if (!await sendPending(item)) break
        }
      } finally { syncingRef.current = false }
    }
    const interval = window.setInterval(() => void retryQueue(), 10000)
    window.addEventListener('online', retryQueue)
    void retryQueue()
    return () => { window.clearInterval(interval); window.removeEventListener('online', retryQueue) }
  }, [data?.role, sendPending])

  async function registerTopic(topic: Topic, reason: string) {
    if (syncingRef.current) return
    const item: PendingRegistration = {
      requestId: crypto.randomUUID(), topicId: topic.id, roundId: topic.round_id!,
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
      await reload()
      setMessage('Đã lưu thay đổi.')
      return true
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Không thực hiện được yêu cầu.'); return false }
    finally { setBusy(false) }
  }

  async function createTopic(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = event.currentTarget
    const values = Object.fromEntries(new FormData(form).entries())
    const payload = { ...values, opensAt: new Date(String(values.opensAt)).toISOString(), closesAt: new Date(String(values.closesAt)).toISOString() }
    if (await submit('/portal/topics', 'POST', payload)) form.reset()
  }

  if (error && !data) return <main className="portal-error"><p>{error}</p><button className="dark-button" onClick={onLogout}>Đăng xuất</button></main>
  if (!data) return <main className="portal-error">Đang tải cổng thông tin…</main>

  const student = data.role === 'SINH_VIEN'
  const name = data.profile?.ho_ten ?? 'Người dùng'
  const registrations = data.registrations ?? []
  const visibleRegistrations: Registration[] = student
    ? [...pendingRegistrations.map((item) => ({
      id: item.requestId, code: item.topicCode, title: item.topicTitle, status: 'DANG_CHO_XU_LY',
      round_id: item.roundId, round_code: item.roundCode, submitted_at: item.createdAt,
    })), ...registrations]
    : registrations
  return (
    <main className="user-portal">
      <header className="portal-header"><a className="portal-brand" href="/portal">DEMO</a><nav><button className={page === 'home' ? 'selected' : ''} onClick={() => setPage('home')}>Tổng quan</button><button onClick={() => { setPage('home'); setTimeout(() => document.getElementById(student ? 'topics' : 'my-topics')?.scrollIntoView(), 0) }}>{student ? 'Tìm đề tài' : 'Đề tài của tôi'}</button>{student && <button onClick={() => { setPage('home'); setTimeout(() => document.getElementById('registrations')?.scrollIntoView(), 0) }}>Đăng ký của tôi</button>}{!student && <button onClick={() => { setPage('home'); setTimeout(() => document.getElementById('review')?.scrollIntoView(), 0) }}>Duyệt đăng ký</button>}<button className={page === 'profile' ? 'selected' : ''} onClick={() => setPage('profile')}>Thông tin cá nhân</button><button className={page === 'settings' ? 'selected' : ''} onClick={() => setPage('settings')}>Cài đặt</button></nav><div className="portal-user"><span>{name}</span><button onClick={onLogout}>Đăng xuất</button></div></header>
      <section className="portal-main" id="home">
        <p className="eyebrow">CỔNG {student ? 'SINH VIÊN' : 'GIẢNG VIÊN'}</p>
        <h1>Xin chào, {name}</h1>
        <p className="portal-intro">{student ? 'Khám phá đề tài phù hợp và theo dõi tiến độ đăng ký.' : 'Quản lý đề tài hướng dẫn và xử lý đăng ký của sinh viên.'}</p>
        {student && <p className="server-clock-note">Hạn chốt theo giờ máy chủ · Đồng hồ hệ thống ghi nhận {data.serverTime ? new Date(data.serverTime).toLocaleString('vi-VN') : 'vừa cập nhật'}</p>}
        {error && <p className="account-message" role="alert">{error}</p>}{message && <p className="account-message" role="status">{message}</p>}
        <section className="portal-summary">
          <article><span>{student ? 'MÃ SINH VIÊN' : 'MÃ GIẢNG VIÊN'}</span><strong>{data.profile?.ma_sinh_vien ?? data.profile?.ma_giang_vien ?? '—'}</strong></article>
          {student && <article><span>LỚP</span><strong>{data.profile?.lop ?? '—'}</strong></article>}
          <article><span>{student ? 'ĐỀ TÀI ĐANG MỞ' : 'ĐỀ TÀI CỦA TÔI'}</span><strong>{data.topics.length}</strong></article>
          {student && <article><span>ĐƠN ĐĂNG KÝ</span><strong>{visibleRegistrations.length}</strong></article>}
          {!student && <article><span>ĐĂNG KÝ CHỜ DUYỆT</span><strong>{registrations.filter((item) => item.status === 'CHO_DUYET').length}</strong></article>}
        </section>
        {page === 'profile' ? <PersonalSettings token={token} page="profile" onTokenChange={onTokenChange}/> : page === 'settings' ? <PersonalSettings token={token} page="settings" onTokenChange={onTokenChange}/> : student ? <>
          <section className="portal-section" id="topics">
            <div className="portal-section-head"><div><h2>Đề tài đang mở</h2><p>Chỉ hiển thị đề tài trong thời hạn của đợt đăng ký</p></div></div>
            <div className="topic-grid">{data.topics.length ? data.topics.map((topic) => {
              const existing = registrations.find((item) => item.round_id === topic.round_id && ['CHO_DUYET', 'DA_DUYET'].includes(item.status))
              const queued = pendingRegistrations.some((item) => item.topicId === topic.id && item.roundId === topic.round_id)
              const full = topic.capacity != null && (topic.registered ?? 0) >= topic.capacity
              return <article className="topic-card" key={`${topic.id}-${topic.round_id}`}>
                <span className="topic-code">{topic.code} · Đợt {topic.round_code}</span><h3>{topic.title}</h3><p>{topic.description || 'Chưa có mô tả.'}</p>
                <div className="topic-meta">{topic.lecturer ?? 'Giảng viên'} · {topic.department ?? 'Khoa'}<br/>Hạn: {localDateTime(topic.closes_at)}<br/>Số lượng: {topic.capacity == null ? 'Không giới hạn' : `${topic.registered ?? 0}/${topic.capacity}`}</div>
                <form onSubmit={(event) => { event.preventDefault(); void registerTopic(topic, String(new FormData(event.currentTarget).get('reason') ?? '').trim()) }}>
                  <input name="reason" aria-label="Lý do đăng ký (không bắt buộc)" placeholder="Lý do đăng ký (không bắt buộc)"/>
                  <button className="dark-button" disabled={busy || queued || Boolean(existing) || full}>{queued ? 'Đang chờ xử lý' : existing ? 'Đã có đăng ký trong đợt' : full ? 'Đề tài đã đủ số lượng' : 'Gửi đăng ký'}</button>
                </form>
              </article>
            }) : <div className="portal-empty">Hiện không có đề tài nào đang trong thời hạn đăng ký.</div>}</div>
          </section>
          <section className="portal-section" id="registrations"><h2>Lịch sử đăng ký</h2><div className="portal-table">{visibleRegistrations.length ? visibleRegistrations.map((item) => <div className="portal-row" key={item.id}><span>{item.code}</span><strong>{item.title}</strong><em className={item.status === 'DANG_CHO_XU_LY' ? 'pending-status' : undefined}>{statusNames[item.status] ?? item.status}</em><small>{localDateTime(item.submitted_at)}</small>{item.status === 'CHO_DUYET' && <button className="outline-button" disabled={busy} onClick={() => void submit(`/portal/registrations/${item.id}/cancel`, 'PATCH')}>Hủy đơn</button>}</div>) : <div className="portal-empty">Bạn chưa gửi đăng ký đề tài nào.</div>}</div></section>
        </> : <>
          <section className="portal-section" id="my-topics"><div className="portal-section-head"><div><h2>Đề tài của tôi</h2><p>Tạo bản nháp, sau đó công bố để sinh viên có thể đăng ký</p></div></div><form className="topic-create-form" onSubmit={createTopic}><div className="generated-code-note"><span>MÃ ĐỀ TÀI</span><strong>Tự sinh khi lưu</strong></div><label>Tên đề tài<input name="title" required maxLength={240}/></label><label className="topic-description-field">Mô tả<textarea name="description" rows={3}/></label><label>Mở đăng ký<input name="opensAt" type="datetime-local" required/></label><label>Đóng đăng ký<input name="closesAt" type="datetime-local" required/></label><label>Số lượng<input name="capacity" type="number" min="1" step="1" required/></label><button className="dark-button" disabled={busy}>Tạo bản nháp</button></form><div className="portal-table">{data.topics.length ? data.topics.map((topic) => <div className="portal-row" key={topic.id}><span>{topic.code}</span><strong>{topic.title}</strong><em>{topic.pending ?? 0} chờ duyệt · {topic.registered ?? 0} đang hiệu lực</em><small>{topic.published ? 'Đã công bố' : 'Bản nháp'}</small><button className="outline-button" disabled={busy || (!topic.published && Boolean(topic.registered))} onClick={() => void submit(`/portal/topics/${topic.id}/publication`, 'PATCH', { published: !topic.published })}>{topic.published ? 'Ẩn đề tài' : 'Công bố'}</button></div>) : <div className="portal-empty">Bạn chưa có đề tài hướng dẫn.</div>}</div></section>
          <section className="portal-section" id="review"><h2>Đăng ký của sinh viên</h2><div className="portal-table">{registrations.length ? registrations.map((item) => <div className="portal-row review-row" key={item.id}><span>{item.student_code}</span><strong>{item.student_name} · {item.topic_title}</strong><small>Đợt {item.round_code} · {localDateTime(item.submitted_at)}</small><em>{statusNames[item.status] ?? item.status}</em>{item.status === 'CHO_DUYET' && <><button className="dark-button" disabled={busy} onClick={() => void submit(`/portal/registrations/${item.id}/decision`, 'PATCH', { status: 'DA_DUYET' })}>Duyệt</button><button className="outline-button" disabled={busy} onClick={() => { const note = window.prompt('Nhập lý do từ chối:'); if (note?.trim()) void submit(`/portal/registrations/${item.id}/decision`, 'PATCH', { status: 'TU_CHOI', note }) }}>Từ chối</button></>}</div>) : <div className="portal-empty">Chưa có đăng ký nào.</div>}</div></section>
        </>}
      </section>
    </main>
  )
}
