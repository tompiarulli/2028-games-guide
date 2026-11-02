import { test as base, expect } from '@playwright/test'

export { expect }

/** Every page's errors: console errors, uncaught exceptions and CSP violations. A test
 *  that expects one (the 404's own status line) lists it in `allowErrors`. */
export const test = base.extend<{
  allowErrors: RegExp[]
  errors: string[]
}>({
  allowErrors: [[], { option: true }],
  errors: [
    async ({ page, allowErrors }, use) => {
      const errors: string[] = []
      page.on('console', (msg) => {
        if (msg.type() === 'error') errors.push(`console: ${msg.text()}`)
      })
      page.on('pageerror', (error) => errors.push(`page: ${error.message}`))
      await page.exposeFunction('__reportCsp', (violation: string) =>
        errors.push(`csp: ${violation}`),
      )
      await page.addInitScript(() => {
        addEventListener('securitypolicyviolation', (e) => {
          const report = (window as unknown as { __reportCsp: (v: string) => void }).__reportCsp
          void report(`${e.violatedDirective} blocked ${e.blockedURI}`)
        })
      })
      await use(errors)
      expect(errors.filter((e) => !allowErrors.some((allow) => allow.test(e)))).toEqual([])
    },
    { auto: true },
  ],
})
