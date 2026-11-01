import { useCallback, useEffect, useState } from 'react'
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
type PortalData = {
  role: 'SINH_VIEN' | 'GIANG_VIEN'
  profile: { ho_ten: string; ma_sinh_vien?: string; ma_giang_vien?: string; lop?: string } | null
  topics: Topic[]
  registrations?: Registration[]
}

const API = 'http://localhost:3000/api'
const statusNames: Record<string, string> = { CHO_DUYET: 'Chờ duyệt', DA_DUYET: 'Đã duyệt', TU_CHOI: 'Từ chối', DA_HUY: 'Đã hủy' }
const localDateTime = (value?: string) => value ? new Date(value).toLocaleString('vi-VN') : '—'

export default function Portal({ token, onLogout, onTokenChange }: { token: string; onLogout: () => void; onTokenChange: (token: string) => void }) {
  const [data, setData] = useState<PortalData | null>(null)
  const [page, setPage] = useState<'home'|'profile'|'settings'>('home')
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = useCallback(async () => {
    const response = await fetch(`${API}/portal/overview`, { headers: { Authorization: `Bearer ${token}` } })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body.error ?? 'Không thể tải dữ liệu tài khoản.')
    setData(body as PortalData)
  }, [token])

  useEffect(() => { reload().catch((reason: Error) => setError(reason.message)) }, [reload])

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
  return (
    <main className="user-portal">
      <header className="portal-header"><a className="portal-brand" href="/portal"><span>Q</span>QL Đề Tài</a><nav><button className={page === 'home' ? 'selected' : ''} onClick={() => setPage('home')}>Tổng quan</button><button onClick={() => { setPage('home'); setTimeout(() => document.getElementById(student ? 'topics' : 'my-topics')?.scrollIntoView(), 0) }}>{student ? 'Tìm đề tài' : 'Đề tài của tôi'}</button>{student && <button onClick={() => { setPage('home'); setTimeout(() => document.getElementById('registrations')?.scrollIntoView(), 0) }}>Đăng ký của tôi</button>}{!student && <button onClick={() => { setPage('home'); setTimeout(() => document.getElementById('review')?.scrollIntoView(), 0) }}>Duyệt đăng ký</button>}<button className={page === 'profile' ? 'selected' : ''} onClick={() => setPage('profile')}>Thông tin cá nhân</button><button className={page === 'settings' ? 'selected' : ''} onClick={() => setPage('settings')}>Cài đặt</button></nav><div className="portal-user"><span>{name}</span><button onClick={onLogout}>Đăng xuất</button></div></header>
      <section className="portal-main" id="home">
        <p className="eyebrow">CỔNG {student ? 'SINH VIÊN' : 'GIẢNG VIÊN'}</p>
        <h1>Xin chào, {name}</h1>
        <p className="portal-intro">{student ? 'Khám phá đề tài phù hợp và theo dõi tiến độ đăng ký.' : 'Quản lý đề tài hướng dẫn và xử lý đăng ký của sinh viên.'}</p>
        {error && <p className="account-message" role="alert">{error}</p>}{message && <p className="account-message" role="status">{message}</p>}
        <section className="portal-summary">
          <article><span>{student ? 'MÃ SINH VIÊN' : 'MÃ GIẢNG VIÊN'}</span><strong>{data.profile?.ma_sinh_vien ?? data.profile?.ma_giang_vien ?? '—'}</strong></article>
          {student && <article><span>LỚP</span><strong>{data.profile?.lop ?? '—'}</strong></article>}
          <article><span>{student ? 'ĐỀ TÀI ĐANG MỞ' : 'ĐỀ TÀI CỦA TÔI'}</span><strong>{data.topics.length}</strong></article>
          {student && <article><span>ĐƠN ĐĂNG KÝ</span><strong>{registrations.length}</strong></article>}
          {!student && <article><span>ĐĂNG KÝ CHỜ DUYỆT</span><strong>{registrations.filter((item) => item.status === 'CHO_DUYET').length}</strong></article>}
        </section>
        {page === 'profile' ? <PersonalSettings token={token} page="profile" onTokenChange={onTokenChange}/> : page === 'settings' ? <PersonalSettings token={token} page="settings" onTokenChange={onTokenChange}/> : student ? <>
          <section className="portal-section" id="topics"><div className="portal-section-head"><div><h2>Đề tài đang mở</h2><p>Chỉ hiển thị đề tài trong thời hạn của đợt đăng ký</p></div></div><div className="topic-grid">{data.topics.length ? data.topics.map((topic) => { const existing = registrations.find((item) => item.round_id === topic.round_id && ['CHO_DUYET', 'DA_DUYET'].includes(item.status)); return <article className="topic-card" key={`${topic.id}-${topic.round_id}`}><span className="topic-code">{topic.code} · Đợt {topic.round_code}</span><h3>{topic.title}</h3><p>{topic.description || 'Chưa có mô tả.'}</p><div className="topic-meta">{topic.lecturer ?? 'Giảng viên'} · {topic.department ?? 'Khoa'}<br/>Hạn: {localDateTime(topic.closes_at)}<br/>Sức chứa: {topic.capacity == null ? 'Không giới hạn' : `${topic.registered ?? 0}/${topic.capacity}`}</div><form onSubmit={(event) => { event.preventDefault(); void submit('/portal/registrations', 'POST', { topicId: topic.id, roundId: topic.round_id, reason: new FormData(event.currentTarget).get('reason') }) }}><input name="reason" aria-label="Lý do đăng ký (không bắt buộc)" placeholder="Lý do đăng ký (không bắt buộc)"/><button className="dark-button" disabled={busy || Boolean(existing) || (topic.capacity != null && (topic.registered ?? 0) >= topic.capacity)}>{existing ? 'Đã có đăng ký trong đợt' : 'Gửi đăng ký'}</button></form></article>}) : <div className="portal-empty">Hiện không có đề tài nào đang trong thời hạn đăng ký.</div>}</div></section>
          <section className="portal-section" id="registrations"><h2>Lịch sử đăng ký</h2><div className="portal-table">{registrations.length ? registrations.map((item) => <div className="portal-row" key={item.id}><span>{item.code}</span><strong>{item.title}</strong><em>{statusNames[item.status] ?? item.status}</em><small>{localDateTime(item.submitted_at)}</small>{item.status === 'CHO_DUYET' && <button className="outline-button" disabled={busy} onClick={() => void submit(`/portal/registrations/${item.id}/cancel`, 'PATCH')}>Hủy đơn</button>}</div>) : <div className="portal-empty">Bạn chưa gửi đăng ký đề tài nào.</div>}</div></section>
        </> : <>
          <section className="portal-section" id="my-topics"><div className="portal-section-head"><div><h2>Đề tài của tôi</h2><p>Tạo bản nháp, sau đó công bố để sinh viên có thể đăng ký</p></div></div><form className="topic-create-form" onSubmit={createTopic}><label>Mã đề tài<input name="code" required/></label><label>Tên đề tài<input name="title" required/></label><label className="topic-description-field">Mô tả<textarea name="description" rows={3}/></label><label>Mở đăng ký<input name="opensAt" type="datetime-local" required/></label><label>Đóng đăng ký<input name="closesAt" type="datetime-local" required/></label><label>Sức chứa<input name="capacity" type="number" min="1" placeholder="Không giới hạn"/></label><button className="dark-button" disabled={busy}>Tạo bản nháp</button></form><div className="portal-table">{data.topics.length ? data.topics.map((topic) => <div className="portal-row" key={topic.id}><span>{topic.code}</span><strong>{topic.title}</strong><em>{topic.pending ?? 0} chờ duyệt · {topic.registered ?? 0} đang hiệu lực</em><small>{topic.published ? 'Đã công bố' : 'Bản nháp'}</small><button className="outline-button" disabled={busy || (!topic.published && Boolean(topic.registered))} onClick={() => void submit(`/portal/topics/${topic.id}/publication`, 'PATCH', { published: !topic.published })}>{topic.published ? 'Ẩn đề tài' : 'Công bố'}</button></div>) : <div className="portal-empty">Bạn chưa có đề tài hướng dẫn.</div>}</div></section>
          <section className="portal-section" id="review"><h2>Đăng ký của sinh viên</h2><div className="portal-table">{registrations.length ? registrations.map((item) => <div className="portal-row review-row" key={item.id}><span>{item.student_code}</span><strong>{item.student_name} · {item.topic_title}</strong><small>Đợt {item.round_code} · {localDateTime(item.submitted_at)}</small><em>{statusNames[item.status] ?? item.status}</em>{item.status === 'CHO_DUYET' && <><button className="dark-button" disabled={busy} onClick={() => void submit(`/portal/registrations/${item.id}/decision`, 'PATCH', { status: 'DA_DUYET' })}>Duyệt</button><button className="outline-button" disabled={busy} onClick={() => { const note = window.prompt('Nhập lý do từ chối:'); if (note?.trim()) void submit(`/portal/registrations/${item.id}/decision`, 'PATCH', { status: 'TU_CHOI', note }) }}>Từ chối</button></>}</div>) : <div className="portal-empty">Chưa có đăng ký nào.</div>}</div></section>
        </>}
      </section>
    </main>
  )
}
