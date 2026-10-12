// Real, offline Chromium repetition/soak. This is not a Rewards task test.
import { createRequire } from 'node:module'
import fs from 'node:fs'
import assert from 'node:assert/strict'
const app = process.env.APP_DIR || '/usr/src/microsoft-rewards-script'
const require = createRequire(`${app}/package.json`)
const { chromium } = require('patchright')
assert.notEqual(process.getuid(), 0, 'Chromium verification must run as non-root')
const seconds = Number(process.env.SOAK_SECONDS || 3600)
assert.ok(Number.isInteger(seconds) && seconds >= 60, 'SOAK_SECONDS must be >= 60')
const samples = []
function resources() {
    let rssKiB = 0, processes = 0, fds = 0
    for (const pid of fs.readdirSync('/proc').filter(p => /^\d+$/.test(p))) {
        try {
            const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8')
            rssKiB += Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] || 0)
            processes++
            try { fds += fs.readdirSync(`/proc/${pid}/fd`).length } catch {}
        } catch {}
    }
    return { rssKiB, processes, fds }
}
const deadline = Date.now() + seconds * 1000
let cycles = 0
while (Date.now() < deadline) {
    const browser = await chromium.launch({ headless: true })
    try {
        const page = await browser.newPage()
        await page.setContent('<title>offline-runtime-check</title><input data-testid="otpCodeEntry">')
        assert.equal(await page.title(), 'offline-runtime-check')
        await page.locator('input').fill('fixture')
        assert.equal(await page.locator('input').inputValue(), 'fixture')
    } finally { await browser.close() }
    await new Promise(resolve => setTimeout(resolve, 1000))
    cycles++
    if (cycles === 3 || cycles % 30 === 0) samples.push({ cycles, ...resources() })
}
samples.push({ cycles, ...resources() })
assert.ok(cycles >= 3)
const first = samples[0], last = samples.at(-1)
assert.ok(last.rssKiB - first.rssKiB <= 256 * 1024, 'container RSS growth exceeded 256 MiB')
assert.ok(last.fds - first.fds <= 32, 'FD growth exceeded 32')
assert.ok(last.processes - first.processes <= 8, 'process growth exceeded 8')
console.log(JSON.stringify({ uid: process.getuid(), seconds, cycles, samples, limits: { rssKiB: 262144, fds: 32, processes: 8 } }, null, 2))
