// Read-only diagnostics. Never return e-mail addresses, passwords, cookies or tokens.
const isPlaceholder = value => /(?:^ci@example\.invalid$|@(?:example\.(?:com|net|org)|[^@]+\.invalid)$)/i.test(value)
const isEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
export function runtimeReadiness(env = {}) {
  const names = Object.keys(env).filter(k => /^ACCOUNT_[1-9]\d*_EMAIL$/.test(k))
  let usable = 0
  let placeholders = 0
  let missingPassword = 0
  for (const name of names) {
    const email = String(env[name] || '').trim()
    if (!email || !isEmail(email) || isPlaceholder(email)) { placeholders++; continue }
    usable++
    if (!env[name.replace('_EMAIL', '_PASSWORD')]) missingPassword++
  }
  const issues = []
  if (!usable) issues.push('没有可识别的真实微软账号配置；示例账号不能用于积分任务')
  if (placeholders) issues.push('存在 '+placeholders+' 个空白、格式错误或测试占位账号')
  if (missingPassword) issues.push(missingPassword+' 个账号未配置密码；可能采用无密码或会话登录，登录状态尚未核验')
  if ((env.CRON_SCHEDULE || '') === '0 0 1 1 *') issues.push('仍使用候选版年度测试计划，不会每日自动执行')
  return {
    configuredAccountSlots: names.length,
    usableAccountSlots: usable,
    placeholderAccountSlots: placeholders,
    loginVerification: '未验证：账号已配置不等于已成功登录，需查看实际任务结果',
    issues,
  }
}
export function isUsableEmail(value) {
  const email = String(value || '').trim()
  return !!email && isEmail(email) && !isPlaceholder(email)
}
