export const validCalendarDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

export const semesterBounds = (start, end) => ({
  first: Date.parse(`${start}T23:59:59.999+07:00`) + 1,
  last: Date.parse(`${end}T00:00:00+07:00`),
})

export function validateWindow(ctx, opensAt, closesAt, { semesterStart, semesterEnd, roundOpensAt, roundClosesAt } = {}) {
  const open = new Date(opensAt).getTime()
  const close = new Date(closesAt).getTime()
  if (!Number.isFinite(open) || !Number.isFinite(close) || open >= close) ctx.throw(400, 'Thời gian đóng nhận đăng ký phải sau thời gian mở.')
  if (semesterStart && semesterEnd) {
    const { first, last } = semesterBounds(semesterStart, semesterEnd)
    if (open < first) ctx.throw(400, 'Ngày mở nhận đăng ký phải sau ngày bắt đầu học kỳ.')
    if (close >= last) ctx.throw(400, 'Ngày đóng nhận đăng ký phải trước ngày kết thúc học kỳ.')
  }
  if (roundOpensAt && open < new Date(roundOpensAt).getTime()) ctx.throw(400, 'Thời gian mở nhận đăng ký phải nằm trong đợt đăng ký.')
  if (roundClosesAt && close > new Date(roundClosesAt).getTime()) ctx.throw(400, 'Thời gian đóng nhận đăng ký phải nằm trong đợt đăng ký.')
  return { opensAt: new Date(open).toISOString(), closesAt: new Date(close).toISOString() }
}
