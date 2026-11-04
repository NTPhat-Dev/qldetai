import test from 'node:test'
import assert from 'node:assert/strict'
import { semesterBounds, validCalendarDate, validateWindow } from '../academic/src/window.js'

const ctx = { throw(status, message) { throw Object.assign(new Error(message), { status }) } }
const semester = { semesterStart: '2026-09-01', semesterEnd: '2027-01-31' }

test('calendar and semester bounds reject impossible or too-short windows', () => {
  assert.equal(validCalendarDate('2026-02-30'), false)
  assert.equal(validCalendarDate('2028-02-29'), true)
  assert.equal(semesterBounds('2026-09-01', '2026-09-02').first, semesterBounds('2026-09-01', '2026-09-02').last)
})

test('topic window stays inside semester and registration round', () => {
  const options = { ...semester, roundOpensAt: '2026-09-02T00:00:00+07:00', roundClosesAt: '2027-01-30T23:59:59+07:00' }
  const accepted = validateWindow(ctx, '2026-09-02T00:00:00+07:00', '2027-01-30T23:59:59+07:00', options)
  assert.equal(accepted.opensAt, '2026-09-01T17:00:00.000Z')
  assert.throws(() => validateWindow(ctx, '2026-09-01T23:59:59+07:00', '2026-09-03T00:00:00+07:00', semester), { status: 400 })
  assert.throws(() => validateWindow(ctx, '2027-01-29T00:00:00+07:00', '2027-01-31T00:00:00+07:00', semester), { status: 400 })
  assert.throws(() => validateWindow(ctx, '2026-09-02T00:00:00+07:00', '2027-01-31T00:00:00+07:00', options), { status: 400 })
  assert.throws(() => validateWindow(ctx, 'invalid', '2026-09-03T00:00:00+07:00', semester), { status: 400 })
})
