// Real browser child for wrapper kill/lock tests; never connects to Microsoft.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const require = createRequire(`${process.env.APP_DIR}/package.json`)
const { chromium } = require('patchright')
assert.notEqual(process.getuid(), 0)
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage()
await page.setContent('<title>offline-child</title>')
assert.equal(await page.title(), 'offline-child')
fs.writeFileSync(process.env.TEST_READY_FILE, 'ready\n', { mode: 0o600 })
// Deliberately resist TERM: wrapper must escalate and sweep the real browser group.
process.on('SIGTERM', () => {})
setInterval(() => {}, 1000)
