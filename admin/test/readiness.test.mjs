import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeReadiness, isUsableEmail } from '../src/readiness.mjs'

test('empty and candidate placeholder accounts report non-ready without leaking secrets', () => {
  const env = { ACCOUNT_1_EMAIL: 'ci@example.invalid', ACCOUNT_1_PASSWORD: 'ULTRA_SECRET', CONTROL_API_TOKEN: 'PRIVATE_TOKEN', CRON_SCHEDULE: '0 0 1 1 *' }
  const r = runtimeReadiness(env)
  assert.equal(r.usableAccountSlots, 0)
  assert.equal(r.placeholderAccountSlots, 1)
  assert.ok(r.issues.some(s => s.includes('年度测试计划')))
  assert.ok(!JSON.stringify(r).includes('ULTRA_SECRET'))
  assert.ok(!JSON.stringify(r).includes('ci@example.invalid'))
  assert.ok(!JSON.stringify(r).includes('PRIVATE_TOKEN'))
  assert.equal(isUsableEmail('ci@example.invalid'), false)
})

test('valid configured account does not claim login has succeeded', () => {
  const r = runtimeReadiness({ ACCOUNT_1_EMAIL: 'person@contoso.com', ACCOUNT_1_PASSWORD: 'secret', CRON_SCHEDULE: '15 9 * * *' })
  assert.equal(r.usableAccountSlots, 1)
  assert.deepEqual(r.issues, [])
  assert.match(r.loginVerification, /未验证/)
  assert.equal(isUsableEmail('person@contoso.com'), true)
})

test('passwordless and malformed account inputs are explicitly flagged', () => {
  const r = runtimeReadiness({ACCOUNT_2_EMAIL:'user@outlook.com', ACCOUNT_3_EMAIL:'not-an-email', ACCOUNT_3_PASSWORD:'should-not-leak'})
  assert.equal(r.usableAccountSlots, 1)
  assert.equal(r.placeholderAccountSlots, 1)
  assert.ok(r.issues.some(s => s.includes('未配置密码')))
  assert.ok(!JSON.stringify(r).includes('should-not-leak'))
})
