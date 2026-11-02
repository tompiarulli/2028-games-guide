import { expect, test } from './fixtures'

// Tagged @smoke: Checkly runs these against production every 30 minutes, and against
// each Vercel preview. Keep them read-only and independent of the generated content.

test('/ loads the session list', { tag: '@smoke' }, async ({ page }) => {
  const response = await page.goto('/')
  expect(response?.status()).toBe(200)
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'")
  // Server-rendered, before any script runs.
  expect(await response?.text()).toContain('data-session-item')
  await expect(page).toHaveTitle(/2028 Games Session Guide/)
  await expect(page.locator('[data-session-item]').first()).toBeVisible()
})

test('a sport filter narrows the list', { tag: '@smoke' }, async ({ page, isMobile }) => {
  await page.goto('/')
  // A click that lands before hydration does nothing.
  await page.waitForLoadState('networkidle')
  if (isMobile) await page.getByRole('button', { name: 'Filters' }).click()
  await page.getByRole('combobox', { name: 'Sports' }).click()
  await page.getByRole('option', { name: 'Archery', exact: true }).click()
  await expect(page).toHaveURL(/[?&]sport=Archery/)
  const items = page.locator('[data-session-item]')
  await expect(items.first()).toContainText('Archery')
  await expect(items.filter({ hasNotText: 'Archery' })).toHaveCount(0)
})

test('a ?session= link opens its drawer', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/?session=ARC01')
  await expect(page).toHaveTitle(/ARC01/)
  const drawer = page.getByRole('dialog', { name: 'ARC01 Archery' })
  await expect(drawer).toBeVisible()
  await expect(drawer.getByRole('heading', { level: 2 })).toContainText('Archery')
})

test('an unknown ?session= says it was not found', { tag: '@smoke' }, async ({ page }) => {
  await page.goto('/?session=ZZZ99')
  await expect(page.getByRole('heading', { name: 'Session not found' })).toBeVisible()
})

test.describe('not found', () => {
  // Chromium logs the page's own 404 as a failed load.
  test.use({ allowErrors: [/status of 404/] })

  test('an unknown URL gets Page not found with a 404', { tag: '@smoke' }, async ({ page }) => {
    const response = await page.goto('/no/such/page')
    expect(response?.status()).toBe(404)
    await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible()
  })
})
