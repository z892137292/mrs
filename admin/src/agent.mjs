import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { CronExpressionParser } from 'cron-parser'
import { Journal } from './journal.mjs'
import { equal, redact, accountId, httpError } from './security.mjs'
const number = v => Number.isFinite(Number(v)) ? Number(v) : null
export function readFile(file, limit = 262144) {
    let fd
    try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
        const stat = fs.fstatSync(fd)
        if (!stat.isFile()) return ''
        const size = stat.size === 0 ? limit : Math.min(stat.size, limit), buffer = Buffer.alloc(size)
        const length = fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - limit))
        return buffer.subarray(0, length).toString()
    } catch { return '' } finally { if (fd !== undefined) fs.closeSync(fd) }
}
function jsonFile(file) { try { return JSON.parse(readFile(file)) } catch { return {} } }
export function createAgent(env = process.env) {
    if ((env.CONTROL_API_TOKEN || '').length < 32) throw new Error('CONTROL_API_TOKEN must contain at least 32 characters')
    const app = express(), dir = env.APP_DIR || '/usr/src/microsoft-rewards-script'
    const state = env.STATE_DIR || path.join(dir, 'state'), logs = env.LOG_DIR || path.join(dir, 'logs')
    const journal = new Journal(env.CONTROL_DATA_DIR || path.join(dir, 'control-data'))
    let launching = false, mutating = false
    const ctl = env.CTL_PATH || '/usr/local/bin/rewards-ctl'
    const processMatches = (pid, marker) => /^\d+$/.test(String(pid)) && readFile(`/proc/${pid}/cmdline`, 4096).includes(marker)
    const pids = marker => { try { return fs.readdirSync('/proc').filter(p => /^\d+$/.test(p) && processMatches(p, marker)).length } catch { return null } }
    function snapshot() {
        const pid = readFile(path.join(state, 'run.pid')).trim(), stop = readFile(path.join(state, 'STOP'), 1000)
        const status = jsonFile(path.join(state, 'status.json')), summary = jsonFile(path.join(state, 'last-summary.json'))
        const active = launching || processMatches(pid, 'rewards-run')
        const risk = /bot-score|Microsoft risk|manual review|verification|restriction/i.test(stop)
        const scheduler = pids('supercronic')
        let next = null, scheduleError = null
        try { next = CronExpressionParser.parse(env.CRON_SCHEDULE || '', { tz: env.TZ || 'UTC' }).next().toISOString() } catch { scheduleError = '定时计划或时区无效' }
        const accounts = Object.keys(env).filter(k => /^ACCOUNT_[1-9]\d*_EMAIL$/.test(k)).sort((a,b) => Number(a.split('_')[1])-Number(b.split('_')[1])).map(k => {
            const email = env[k], r = (Array.isArray(summary.accounts) ? summary.accounts : []).find(x => String(x.email).toLowerCase() === email.toLowerCase())
            return { id: accountId(email), label: redact(email), configured: !!email, passwordConfigured: !!env[k.replace('_EMAIL','_PASSWORD')], proxyConfigured: !!env[k.replace('_EMAIL','_PROXY_URL')], result: r?.status || null, reportedPoints: number(r?.collectedPoints), pointsSource: '上游 last-summary.json 的 collectedPoints；并非已核验余额', exception: r?.error ? redact(r.error) : null, pauseReason: stop ? redact(stop) : null }
        })
        let runLog = ''
        try { runLog = fs.readdirSync(logs).filter(n => /^run-\d{8}-\d{6}-\d+\.log$/.test(n)).sort().at(-1) || '' } catch {}
        const log = runLog ? readFile(path.join(logs, runLog)) : ''
        const started = /Run \d{8}-\d{6}-\d+ started/.test(log) ? /\[([^\]]+)\]/.exec(log)?.[1] : null
        const durations = [...log.matchAll(/Bot exited with code \d+ after (\d+)s/g)].map(m => Number(m[1]))
        const last = { finishedAt: status.finishedAt || null, result: status.result || null, exitCode: number(status.exitCode), attempts: number(status.attempts), trigger: ['schedule','startup','manual'].includes(status.trigger) ? status.trigger : null }
        return { observedAt: new Date().toISOString(), version: env.MRS_VERSION || 'unknown', commit: env.MRS_COMMIT || 'unknown', upstreamCommit: 'd0f07d74a0ed4dda127855d6e3dde98bf4c89d6e', imageVersion: env.MRS_VERSION || 'unknown', dockerStatus: '控制服务可达；未访问 Docker Engine', uid: process.getuid(), active, paused: fs.existsSync(path.join(state, 'STOP')), risk, pauseReason: redact(stop), failures: number(readFile(path.join(state,'consecutive-failures')).trim() || 0), last, startedAt: started, reportedAttemptSeconds: durations.length ? durations.reduce((a,b)=>a+b,0) : null, durationSource: '任务日志中的各次 Bot 运行耗时之和，不含等待/重试延迟', points: { currentBalance: null, reportedChange: active ? null : number(summary.totalCollectedPoints), source: '上游累计运行摘要；非独立核验余额，崩溃未报告部分未知' }, accounts, health: { schedulerProcesses: scheduler, chromiumProcesses: pids('chrome-headless-shell'), note: '浏览器无任务时没有进程属于正常；未执行真实账号探测' }, settings: { schedule: env.CRON_SCHEDULE || '', timezone: env.TZ || 'UTC', nextScheduledAt: next, scheduleError, logRetentionDays: number(env.LOG_RETENTION_DAYS || 14), validation: { valid: !scheduleError, errors: scheduleError ? [scheduleError] : [] }, directories: ['config','sessions','state','logs','diagnostics'].map(n => ({ name: n, readable: fs.existsSync(path.join(dir,n)) })) } }
    }
    app.disable('x-powered-by'); app.use(express.json({ limit: '8kb' }))
    app.use((req,res,next) => equal(req.headers.authorization, `Bearer ${env.CONTROL_API_TOKEN}`) ? next() : res.status(401).json({ error: '未授权' }))
    app.get('/snapshot', (_req,res) => res.json(snapshot()))
    app.get('/events', (req,res) => res.json(journal.list(/^\d+$/.test(req.query.after || '') ? Number(req.query.after) : 0)))
    app.get('/logs', (req,res) => {
        const date = String(req.query.date || '')
        if (date && !/^\d{8}$/.test(date)) throw httpError(400,'日期格式错误')
        const result = String(req.query.result || '')
        const events = journal.recent()
        let names = []; try { names = fs.readdirSync(logs).filter(n => /^run-\d{8}-\d{6}-\d+\.log$/.test(n) && (!date || n.startsWith(`run-${date}-`))).sort().reverse().slice(0,100) } catch {}
        res.json(names.map(name => ({ name, result: events.find(e => e.runId === name.slice(4,-4) && e.kind==='task_finished')?.result || 'unknown' })).filter(x => !result || x.result === result))
    })
    app.get('/logs/:name', (req,res) => {
        if (!/^run-\d{8}-\d{6}-\d+\.log$/.test(req.params.name)) throw httpError(400,'日志名称无效')
        res.type('text/plain').send(redact(readFile(path.join(logs,req.params.name))))
    })
    app.post('/control', async (req,res,next) => {
        try {
            const action = req.body.action
            if (!['run','stop','pause','resume','resume-reviewed'].includes(action)) throw httpError(400,'操作不允许')
            if (mutating) throw httpError(409,'控制操作进行中')
            mutating = true
            const current = snapshot()
            if (action === 'run' && (current.active || current.paused)) throw httpError(409, current.paused ? '任务已暂停，不能运行' : '已有任务运行')
            if (action === 'pause' && current.paused) return res.json({ accepted:true, message:'保留原暂停原因' })
            if (action.startsWith('resume') && current.active) throw httpError(409,'运行中不能恢复')
            if (action === 'resume' && current.risk) throw httpError(409,'风险暂停需要人工核查与二次确认')
            if (action === 'resume-reviewed' && req.body.reviewed !== true) throw httpError(400,'缺少人工确认')
            const args = action === 'resume-reviewed' ? ['resume','--reviewed'] : action === 'pause' ? ['pause','Web 管理员维护暂停'] : [action]
            if (action === 'run') {
                launching = true
                const child = spawn(ctl,args,{ env, stdio:'ignore', shell:false })
                child.once('exit',()=>{ launching=false }); child.once('error',()=>{ launching=false })
                journal.add('manual_trigger',{result:'accepted'})
                return res.status(202).json({accepted:true,message:'已提交现有 rewards-ctl；最终结果以运行记录为准'})
            }
            // Resume holds the SAME flock while inspecting and clearing STOP; schedule cannot start between them.
            const binary = action.startsWith('resume') ? '/usr/bin/flock' : ctl
            const commandArgs = action.startsWith('resume') ? ['-n',path.join(state,'run.lock'),ctl,...args] : args
            execFileSync(binary,commandArgs,{ env, timeout:10000, stdio:'pipe', maxBuffer:8192 })
            journal.add(action === 'pause' ? 'account_paused' : 'control_action',{result:action,reason:current.pauseReason})
            res.json({accepted:true})
        } catch(e) { next(e.status ? e : httpError(409,'现有控制命令拒绝操作或超时')) } finally { mutating = false }
    })
    app.use((err,_req,res,_next)=>res.status(err.status || 500).json({error:err.status ? redact(err.message) : '控制服务错误'}))
    journal.add('container_started',{result:'控制服务启动'})
    return { app, snapshot, journal, close: () => journal.close() }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'agent.mjs') {
    const agent = createAgent(), server = agent.app.listen(Number(process.env.CONTROL_PORT || 8090),'0.0.0.0')
    const stop = () => { server.close(()=>{ agent.close(); process.exit(0) }); setTimeout(()=>process.exit(0),5000).unref() }
    process.once('SIGTERM',stop); process.once('SIGINT',stop)
}
