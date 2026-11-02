import assert from 'node:assert/strict'
import path from 'node:path'
import { chromium } from 'playwright'

export async function browserSmoke({ base, fixtures, password, run, waitReady, call, root }) {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  const failures = []
  async function signIn(page, username, secret, route = '/login') {
    await page.goto(`${base}${route}`)
    await page.locator('#username').fill(username)
    await page.locator('#password').fill(secret)
    await page.getByRole('button', { name: 'Đăng nhập', exact: true }).click()
  }
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
    page.on('pageerror', (error) => failures.push(error.message))
    await signIn(page, 'admin.test', password)
    await page.getByRole('alert').filter({ hasText: 'Sai tên đăng nhập hoặc mật khẩu.' }).waitFor()
    assert.ok(page.url().endsWith('/login'))
    const background = await page.locator('.login-page').evaluate((element) => getComputedStyle(element).backgroundImage)
    assert.ok(background.includes('nen.png'), 'Keep project login background')
    await page.screenshot({ path: path.join(root, 'test-results', 'login.png'), fullPage: true })
    await signIn(page, fixtures.students[11].username, password, '/admin')
    await page.getByRole('alert').filter({ hasText: 'Sai tên đăng nhập hoặc mật khẩu.' }).waitFor()
    await signIn(page, 'admin.test', password, '/admin')
    await page.getByRole('heading', { level: 1, name: 'Tổng quan' }).waitFor()
    for (const label of ['Đợt đăng ký', 'Tài khoản', 'Khoa và lớp', 'Đăng ký', 'Tổng quan']) {
      await page.getByRole('navigation', { name: 'Quản trị' }).getByRole('button', { name: label === 'Đăng ký' ? /^Đăng ký(?:\s+\d+)?$/ : label, exact: label !== 'Đăng ký' }).click()
      await page.getByRole('heading', { level: 1, name: label }).waitFor()
    }
    assert.ok((await page.locator('body').evaluate((element) => getComputedStyle(element).fontFamily)).includes('Arial'))
    await page.screenshot({ path: path.join(root, 'test-results', 'admin-desktop.png'), fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'No mobile page overflow')
    await page.screenshot({ path: path.join(root, 'test-results', 'admin-mobile.png'), fullPage: true })
    await page.close()

    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    // Exercise the UUID fallback used by phones on plain HTTP LAN URLs.
    await context.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined, configurable: true }))
    const student = await context.newPage()
    student.on('pageerror', (error) => failures.push(error.message))
    await signIn(student, fixtures.students[11].username, password)
    const card = student.locator('.topic-card').filter({ has: student.getByRole('heading', { name: 'Pending request recovery', exact: true }) })
    await card.waitFor()
    assert.ok(await student.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 2), 'No student mobile overflow')
    await student.screenshot({ path: path.join(root, 'test-results', 'student-mobile.png'), fullPage: true })
    await run(['stop', '-t', '2', 'registration-db'])
    try {
      await student.reload()
      await card.waitFor()
      await card.getByRole('button', { name: 'Gửi đăng ký', exact: true }).click()
      await student.waitForFunction(() => Object.keys(localStorage).some((key) => key.includes('registration-outbox') && JSON.parse(localStorage.getItem(key) || '[]').length === 1))
      await student.reload()
      await card.waitFor()
      assert.equal(await student.evaluate(() => Object.keys(localStorage).filter((key) => key.includes('registration-outbox')).reduce((sum, key) => sum + JSON.parse(localStorage.getItem(key) || '[]').length, 0)), 1, 'Pending request persists across reload')
      assert.ok(await card.getByRole('button', { name: 'Đang chờ xử lý', exact: true }).isDisabled())
    } finally { await run(['start', 'registration-db']) }
    await waitReady()
    await student.waitForFunction(() => Object.keys(localStorage).filter((key) => key.includes('registration-outbox')).every((key) => JSON.parse(localStorage.getItem(key) || '[]').length === 0), null, { timeout: 45000 })
    const overview = await call('/api/portal/overview', { token: fixtures.students[11].token })
    assert.equal(overview.status, 200)
    assert.equal(overview.data.registrations.filter((row) => row.topic_id === fixtures.recoveryTopic.id || row.title === 'Pending request recovery').length, 1, 'Browser queue replay creates exactly one registration')
    await context.close()

    const lecturer = await browser.newPage({ viewport: { width: 1280, height: 900 } })
    lecturer.on('pageerror', (error) => failures.push(error.message))
    await signIn(lecturer, fixtures.lecturer.username, password)
    await lecturer.getByRole('heading', { name: 'Đề tài của tôi', exact: true }).waitFor()
    assert.equal(await lecturer.getByText('Tự sinh khi lưu', { exact: true }).count(), 0)
    await lecturer.screenshot({ path: path.join(root, 'test-results', 'lecturer.png'), fullPage: true })
    await lecturer.close()
    assert.deepEqual(failures, [], 'No uncaught browser errors')
  } finally { await browser.close() }
}
