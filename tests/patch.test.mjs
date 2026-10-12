// Unit tests for the custom TypeScript patch, run against the compiled dist/.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dist = process.env.DIST_DIR
assert.ok(dist, 'DIST_DIR must point at the compiled dist/ directory')
const rs = require(path.join(dist, 'util/RunSummary.js'))
const { applyAccountFilter } = require(path.join(dist, 'util/Load.js'))

const ok = (email, pts = 10) => ({ email, success: true, collectedPoints: pts })
const bad = (email, error = 'Flow failed') => ({ email, success: false, collectedPoints: 0, error })

test('all accounts ok -> exit 0', () => {
    const s = rs.buildRunSummary(['a@x.io', 'b@x.io'], [ok('a@x.io'), ok('b@x.io', 5)], '1')
    assert.equal(s.exitCode, rs.EXIT_OK)
    assert.deepEqual(s.failedEmails, [])
    assert.equal(s.totalCollectedPoints, 15)
})

test('a failed account -> exit 2 and listed', () => {
    const s = rs.buildRunSummary(['a@x.io', 'b@x.io'], [ok('a@x.io'), bad('b@x.io')], '1')
    assert.equal(s.exitCode, rs.EXIT_ACCOUNT_FAILED)
    assert.deepEqual(s.failedEmails, ['b@x.io'])
})

test('missing result (crashed worker) counts as failed', () => {
    const s = rs.buildRunSummary(['a@x.io', 'b@x.io'], [ok('a@x.io')], '1')
    assert.deepEqual(s.failedEmails, ['b@x.io'])
    assert.equal(s.accounts[1].error, 'No result reported')
})

test('bot-score skip is reported but not retried', () => {
    const s = rs.buildRunSummary(['a@x.io'], [bad('a@x.io', rs.BOT_WARNING_ERROR)], '1')
    assert.equal(s.exitCode, rs.EXIT_OK)
    assert.deepEqual(s.botWarningEmails, ['a@x.io'])
    assert.deepEqual(s.failedEmails, [])
})

test('e-mail matching is case-insensitive', () => {
    const s = rs.buildRunSummary(['Alice@X.io'], [ok('alice@x.io')], '1')
    assert.equal(s.exitCode, rs.EXIT_OK)
})

test('summary written atomically with mode 0600, no secrets', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'))
    const file = path.join(dir, 'nested', 'summary.json')
    rs.writeRunSummary(rs.buildRunSummary(['a@x.io'], [ok('a@x.io')], '9.9.9'), file)
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.equal(data.version, '9.9.9')
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.ok(!/password|totp/i.test(fs.readFileSync(file, 'utf8')))
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['summary.json'])
})

test('writeRunSummary is a no-op without a target and never throws', () => {
    assert.doesNotThrow(() => rs.writeRunSummary(rs.buildRunSummary([], [], '1'), ''))
    // parent path is a regular file -> ENOTDIR; must be swallowed and logged
    const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rs-')), 'file')
    fs.writeFileSync(blocker, '')
    assert.doesNotThrow(() => rs.writeRunSummary(rs.buildRunSummary([], [], '1'), path.join(blocker, 'x.json')))
})

test('RUN_ACCOUNT_FILTER selects accounts case-insensitively', () => {
    const accounts = [{ email: 'a@x.io' }, { email: 'B@x.io' }, { email: 'c@x.io' }]
    process.env.RUN_ACCOUNT_FILTER = ' b@x.io , C@X.IO '
    assert.deepEqual(applyAccountFilter(accounts).map(a => a.email), ['B@x.io', 'c@x.io'])
    process.env.RUN_ACCOUNT_FILTER = ''
    assert.equal(applyAccountFilter(accounts).length, 3)
    process.env.RUN_ACCOUNT_FILTER = 'nobody@x.io'
    assert.throws(() => applyAccountFilter(accounts), /matched no configured account/)
    delete process.env.RUN_ACCOUNT_FILTER
})

test('account filter refuses partly unknown filters', () => {
    process.env.RUN_ACCOUNT_FILTER = 'a@x.io,unknown@x.io'
    assert.throws(() => applyAccountFilter([{ email: 'a@x.io' }]), /unknown accounts/)
    delete process.env.RUN_ACCOUNT_FILTER
})

test('risk marker and persistent STOP are private', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'risk-'))
    const marker = path.join(dir, 'risk')
    rs.markRiskPause(marker)
    assert.ok(fs.existsSync(path.join(dir, 'STOP')))
    assert.equal(fs.statSync(marker).mode & 0o777, 0o600)
    assert.equal(fs.statSync(path.join(dir, 'STOP')).mode & 0o777, 0o600)
    fs.rmSync(dir, { recursive: true })
})

test('real local HTTP 403/429 exits immediately without automatic retry', async () => {
    const http = await import('node:http')
    const { spawn } = await import('node:child_process')
    for (const code of [403, 429]) {
        let calls = 0
        const server = http.createServer((_req, res) => { calls++; res.writeHead(code); res.end('restricted') })
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'http-risk-'))
        try {
            const script = `const Client = require(${JSON.stringify(path.join(dist, 'util/Http.js'))}).default;
                new Client({url:'',port:0,proxyHttp:false,username:'',password:''}).request({url:${JSON.stringify(`http://127.0.0.1:${server.address().port}/`)},retries:3}).catch(()=>process.exit(1));`
            const child = spawn(process.execPath, ['-e', script], { env: { ...process.env, REWARDS_BOT: '1', RUN_RISK_FILE: path.join(dir, 'marker') }, stdio: 'ignore' })
            let timedOut = false
            const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 30000)
            const status = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) }).finally(() => clearTimeout(timer))
            assert.equal(timedOut, false)
            assert.equal(status, 78)
            assert.equal(calls, 1)
            assert.ok(fs.existsSync(path.join(dir, 'STOP')))
        } finally {
            delete process.env.REWARDS_BOT
            delete process.env.RUN_RISK_FILE
            await new Promise(resolve => server.close(resolve))
            fs.rmSync(dir, { recursive: true })
        }
    }
})

test('risk marker write failure exits 78 instead of becoming retryable', async () => {
    const { spawnSync } = await import('node:child_process')
    const script = `require(${JSON.stringify(path.join(dist, 'util/RunSummary.js'))}).markRiskPause('/dev/null/risk')`
    const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 78)
})

test('upstream log dispatch and summary errors scrub credential text', () => {
    const secret = 'Cookie: SID=SID_SECRET; OTHER=OTHER_SECRET\nhttp://user:PROXY_SECRET@proxy.invalid\nhttps://api.telegram.org/botTG_SECRET/sendMessage\n{"accessToken":"ACCESS_SECRET"} password=PASS_SECRET'
    const clean = rs.redactSensitiveText(secret)
    for (const value of ['SID_SECRET', 'OTHER_SECRET', 'PROXY_SECRET', 'TG_SECRET', 'ACCESS_SECRET', 'PASS_SECRET']) assert.ok(!clean.includes(value))
    const summary = rs.buildRunSummary(['a@x.io'], [bad('a@x.io', secret)], '1')
    assert.equal(summary.accounts[0].error, clean)
})

test('login verification and account restrictions require manual review', async () => {
    const safety = require(path.join(dist, 'util/LoginSafety.js'))
    for (const state of ['ACCOUNT_LOCKED', 'ERROR_ALERT', 'EMAIL_VERIFICATION_INPUT', 'RECOVERY_EMAIL_INPUT', '2FA_TOTP', 'LOGIN_PASSWORDLESS', 'PASSWORDLESS_SEND_CODE', 'OTP_CODE_ENTRY', 'PASSKEY_VIDEO', 'PASSKEY_ERROR', 'SIGN_IN_METHOD_PICKER', 'FOOTER_ACTION', 'CAPTCHA']) assert.equal(safety.requiresManualLoginReview(state), true)
    for (const state of ['LOGGED_IN', 'EMAIL_INPUT', 'PASSWORD_INPUT', 'KMSI_PROMPT', 'CHROMEWEBDATA_ERROR']) assert.equal(safety.requiresManualLoginReview(state), false)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-review-'))
    try {
        const { spawnSync } = await import('node:child_process')
        const script = `require(${JSON.stringify(path.join(dist, 'util/LoginSafety.js'))}).enforceLoginSafety('OTP_CODE_ENTRY')`
        const result = spawnSync(process.execPath, ['-e', script], { env: { ...process.env, REWARDS_BOT: '1', RUN_RISK_FILE: path.join(dir, 'risk') }, encoding: 'utf8', timeout: 30000 })
        assert.equal(result.status, 78)
        assert.ok(fs.existsSync(path.join(dir, 'STOP')))
    } finally {
        delete process.env.REWARDS_BOT; delete process.env.RUN_RISK_FILE
        fs.rmSync(dir, { recursive: true })
    }
})
