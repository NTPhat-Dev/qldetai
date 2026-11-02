import { useCallback, useEffect, useState } from 'react'
import AccountManagement from './AccountManagement'
import RegistrationRounds from './RegistrationRounds'
import { api } from './api'

type Overview = {
  stats: { students: number; lecturers: number; topics: number; pendingRegistrations: number; rounds: number }
  recentTopics: { code: string; title: string; published: boolean; department: string | null; created_at: string }[]
}
type Entry = { id: string; student_name: string; student_code: string; topic_title: string; topic_code: string; round_code: string; status: string; submitted_at: string; reason?: string; note?: string; history?: { old_status: string | null; new_status: string; changed_at: string; note?: string }[] }
type Page = 'overview' | 'registrations' | 'rounds' | 'accounts' | 'organization'
const pageNames: Record<Page, string> = { overview: 'Tổng quan', registrations: 'Đăng ký', rounds: 'Đợt đăng ký', accounts: 'Tài khoản', organization: 'Khoa và lớp' }
const statusNames: Record<string, string> = { CHO_DUYET: 'Chờ duyệt', DA_DUYET: 'Đã duyệt', TU_CHOI: 'Từ chối', DA_HUY: 'Đã hủy' }
const date = (value: string) => new Date(value).toLocaleString('vi-VN')

export default function AdminDashboard({ token, onLogout }: { token: string; onLogout: () => void }) {
  const [page, setPage] = useState<Page>('overview')
  const [overview, setOverview] = useState<Overview | null>(null)
  const [entries, setEntries] = useState<Entry[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('')
  const reload = useCallback(async () => {
    setBusy(true)
    const results = await Promise.allSettled([api<Overview>('/admin/overview', token), api<Entry[]>('/admin/registrations', token)])
    if (results[0].status === 'fulfilled') setOverview(results[0].value)
    if (results[1].status === 'fulfilled') setEntries(results[1].value)
    const failure = results.find((result) => result.status === 'rejected')
    setError(failure?.status === 'rejected' ? failure.reason instanceof Error ? failure.reason.message : 'Không tải được dữ liệu.' : '')
    setBusy(false)
  }, [token])
  useEffect(() => {
    void reload()
    const timer = window.setInterval(() => void reload(), 30000)
    return () => window.clearInterval(timer)
  }, [reload])
  const visible = entries.filter((entry) => (!status || entry.status === status) && `${entry.student_name} ${entry.student_code} ${entry.topic_title} ${entry.topic_code} ${entry.round_code}`.toLocaleLowerCase('vi').includes(query.toLocaleLowerCase('vi')))
  return <main className="admin-shell">
    <aside className="sidebar">
      <div className="side-brand">DEMO</div>
      <nav aria-label="Quản trị">{Object.entries(pageNames).map(([key, label]) => <button key={key} className={`nav-item ${page === key ? 'active' : ''}`} aria-current={page === key ? 'page' : undefined} onClick={() => setPage(key as Page)}>{label}{key === 'registrations' && Boolean(overview?.stats.pendingRegistrations) && <b>{overview?.stats.pendingRegistrations}</b>}</button>)}</nav>
      <div className="sidebar-bottom"><span>Quản trị viên</span><button className="outline-button" onClick={onLogout}>Đăng xuất</button></div>
    </aside>
    <section className="admin-content">
      <header className="topbar"><div><p className="eyebrow">QUẢN TRỊ</p><h1>{pageNames[page]}</h1></div><button className="outline-button" disabled={busy} onClick={() => void reload()}>{busy ? 'Đang cập nhật…' : 'Làm mới số liệu'}</button></header>
      {error && <p className="notice" role="alert">{error} Dữ liệu đã tải vẫn được giữ lại.</p>}
      {page === 'overview' && <>
        <section className="stat-grid" aria-label="Thống kê">
          {[[overview?.stats.topics, 'Đề tài'], [overview?.stats.pendingRegistrations, 'Đăng ký chờ duyệt'], [overview?.stats.students, 'Sinh viên'], [overview?.stats.lecturers, 'Giảng viên']].map(([value, label]) => <article className="stat-card" key={label}><p>{label}</p><strong>{value ?? '—'}</strong></article>)}
        </section>
        <section className="content-card"><div className="card-heading"><h2>Đề tài gần đây</h2><span className="muted">{overview?.stats.rounds ?? '—'} đợt đăng ký</span></div><div className="table-wrap"><table><thead><tr><th>Mã đề tài</th><th>Tên đề tài</th><th>Khoa</th><th>Trạng thái</th></tr></thead><tbody>{overview?.recentTopics.length ? overview.recentTopics.map((topic) => <tr key={topic.code}><td>{topic.code}</td><td className="title-cell">{topic.title}</td><td>{topic.department ?? '—'}</td><td><span className={`status-pill ${topic.published ? 'published' : 'draft'}`}>{topic.published ? 'Đã công bố' : 'Bản nháp'}</span></td></tr>) : <tr><td colSpan={4} className="empty-state">{busy ? 'Đang tải dữ liệu…' : 'Chưa có đề tài.'}</td></tr>}</tbody></table></div></section>
        <div className="quick-actions"><button className="outline-button" onClick={() => setPage('rounds')}>Quản lý đợt đăng ký</button><button className="outline-button" onClick={() => setPage('accounts')}>Cấp tài khoản</button><button className="outline-button" onClick={() => setPage('registrations')}>Theo dõi đăng ký</button></div>
      </>}
      {page === 'registrations' && <section className="content-card"><div className="card-heading"><div><h2>Đăng ký của sinh viên</h2><p>Theo dõi quyết định và lịch sử xử lý.</p></div></div><div className="filter-bar"><input aria-label="Tìm đăng ký" placeholder="Tìm sinh viên, đề tài hoặc đợt" value={query} onChange={(event) => setQuery(event.target.value)}/><select aria-label="Lọc trạng thái đăng ký" value={status} onChange={(event) => setStatus(event.target.value)}><option value="">Tất cả trạng thái</option>{Object.entries(statusNames).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><span className="muted">{visible.length} đăng ký</span></div><div className="portal-table registration-list">{visible.length ? visible.map((entry) => <article className="registration-entry" key={entry.id}><div className="entry-heading"><strong>{entry.student_name} · {entry.student_code}</strong><span className="status-pill">{statusNames[entry.status] ?? entry.status}</span></div><p>{entry.topic_title} <span className="muted">· {entry.topic_code}</span></p><small>Đợt {entry.round_code} · {date(entry.submitted_at)}</small>{entry.reason && <p>Lý do đăng ký: {entry.reason}</p>}{entry.note && <p>Phản hồi: {entry.note}</p>}{entry.history?.length ? <details><summary>Lịch sử xử lý</summary><ol>{entry.history.map((item, index) => <li key={index}>{date(item.changed_at)} · {statusNames[item.new_status] ?? item.new_status}{item.note ? ` · ${item.note}` : ''}</li>)}</ol></details> : null}</article>) : <p className="empty-state">Không có đăng ký phù hợp.</p>}</div></section>}
      {page === 'rounds' && <RegistrationRounds token={token}/>}
      {page === 'accounts' && <AccountManagement token={token} mode="accounts"/>}
      {page === 'organization' && <AccountManagement token={token} mode="organization"/>}
    </section>
  </main>
}
