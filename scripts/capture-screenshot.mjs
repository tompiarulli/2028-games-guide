// Captures the README screenshot: the top of the session list in light mode at a
// 1275×684 desktop viewport, rendered at 2× and quantized to a palette PNG so it
// stays under ~100 KB.
//
// Usage: node scripts/capture-screenshot.mjs [url] [outFile]
//        (defaults: https://28games.tompiarulli.com/, screenshot.png)
import { chromium } from '@playwright/test'
import sharp from 'sharp'

const [url = 'https://28games.tompiarulli.com/', outFile = 'screenshot.png'] = process.argv.slice(2)

const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 1275, height: 684 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
  })
  const response = await page.goto(url, { waitUntil: 'networkidle' })
  if (!response?.ok()) throw new Error(`${url} returned HTTP ${response?.status()}`)
  await page.locator('[data-session-item]').first().waitFor()
  await page.evaluate(() => document.fonts.ready)

  const png = await page.screenshot({ animations: 'disabled', caret: 'hide' })
  const { size } = await sharp(png)
    .png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 })
    .toFile(outFile)
  console.log(`Wrote ${outFile} (${Math.round(size / 1024)} KB) from ${url}`)
} finally {
  await browser.close()
}
