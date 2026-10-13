import express from 'express'
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { CronExpressionParser } from 'cron-parser'
import { Journal } from './journal.mjs'
import { streamCoreEvents } from './live-events.mjs'
import { equal, redact, maskEmail, httpError } from './security.mjs'
import { runtimeReadiness, isUsableEmail } from './readiness.mjs'
import { Accounts } from './accounts.mjs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { Interactive } from './interactive.mjs'
const {Ledger,signature}=createRequire(import.meta.url)('./ledger.cjs')
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
    const environmentLoadedAt = new Date().toISOString()
    const app = express(), dir = env.APP_DIR || '/usr/src/microsoft-rewards-script'
    const state = env.STATE_DIR || path.join(dir, 'state'), logs = env.LOG_DIR || path.join(dir, 'logs')
    const journal = new Journal(env.CONTROL_DATA_DIR || path.join(dir, 'control-data'))
    const accountStore = new Accounts(env)
    const interactive=new Interactive(env,journal),ledger=new Ledger(env.CONTROL_DATA_DIR || path.join(dir,'control-data'))
    let launching = false, mutating = false
    const ctl = env.CTL_PATH || '/usr/local/bin/rewards-ctl'
    const processMatches = (pid, marker) => /^\d+$/.test(String(pid)) && readFile(`/proc/${pid}/cmdline`, 4096).includes(marker)
    const pids = marker => { try { return fs.readdirSync('/proc').filter(p => /^\d+$/.test(p) && processMatches(p, marker)).length } catch { return null } }
    const reconcile=()=>{if(!ledger.list().some(r=>r.state==='running'))return;try{execFileSync('/usr/bin/flock',['-n',path.join(state,'run.lock'),process.execPath,fileURLToPath(new URL('./ledger.cjs',import.meta.url)),'reconcile'],{env:{...env,APP_DIR:dir,STATE_DIR:state},timeout:5000,stdio:'ignore'})}catch{/* Busy means the actual task/login still owns the original lock. */}}
    reconcile()
    function snapshot() {
        const pid = readFile(path.join(state, 'run.pid')).trim(), needsReview=ledger.unreviewed().length>0, stop = readFile(path.join(state, 'STOP'), 1000) || (needsReview?'manual review: suspect execution evidence needs explicit human acknowledgement':'')
        const status = jsonFile(path.join(state, 'status.json')), summary = jsonFile(path.join(state, 'last-summary.json'))
        const active = launching || processMatches(pid, 'rewards-run')
        let elapsedSeconds = null
        if (processMatches(pid, 'rewards-run')) { try { elapsedSeconds = Math.max(0, Math.floor((Date.now()-fs.statSync(path.join(state,'run.pid')).mtimeMs)/1000)) } catch {} }
        const risk = /bot-score|Microsoft risk|manual review|verification|restriction/i.test(stop)
        const scheduler = pids('supercronic')
        let next = null, scheduleError = null
        try { next = CronExpressionParser.parse(env.CRON_SCHEDULE || '', { tz: env.TZ || 'UTC' }).next().toISOString() } catch { scheduleError = '定时计划或时区无效' }
        const configuration=accountStore.read(), applied=jsonFile(path.join(state,'account-applied.json'))
        const sessionReceipts=jsonFile(path.join(env.CONTROL_DATA_DIR || path.join(dir,'control-data'),'verified-sessions.json'))
        const sessionEvents=new Map(),sessionStates={'session.login.started':'manual_verification','session.auth.required':'manual_verification','session.restricted':'restricted','session.login.failed':'login_failed','session.verified':'session_verified_history'}
        try{for(const e of journal.recent())if(e.accountId&&sessionStates[e.kind]&&!sessionEvents.has(e.accountId))sessionEvents.set(e.accountId,e)}catch{/* An optional journal outage cannot break the existing pause/stop controls. */}
        const accounts = configuration.accounts.map(a => {
            const email = String(a.email || '').trim(), same=applied.revision===configuration.revision && applied.accounts?.some(x=>x.id===a.id && x.modifiedAt===a.modifiedAt)
            const r = (!configuration.revision || same) ? (Array.isArray(summary.accounts) ? summary.accounts : []).find(x => String(x.email).toLowerCase() === email.toLowerCase()) : null
            const login=same ? applied.login?.[a.id] : null
            const receipt=Object.entries(sessionReceipts).filter(([key,r])=>[`${a.id}:mobile`,`${a.id}:desktop`].includes(key)&&r&&Number.isFinite(Date.parse(r.verifiedAt))&&Date.parse(r.verifiedAt)<=Date.now()).sort((x,y)=>Date.parse(y[1].verifiedAt)-Date.parse(x[1].verifiedAt))[0]
            const lastSessionVerification=receipt?{platform:receipt[0].split(':')[1],verifiedAt:receipt[1].verifiedAt,availablePoints:Number.isFinite(receipt[1].availablePoints)?receipt[1].availablePoints:null,source:redact(String(receipt[1].source || '').slice(0,400)),configurationMatches:receipt[1].revision===configuration.revision,currentStatus:'历史核验记录；当前有效性需要重新实时核验'}:null
            const evidence=[]
            if(login)evidence.push({state:login.status,time:Date.parse(login.time)||0})
            if(lastSessionVerification?.configurationMatches)evidence.push({state:'session_verified_history',time:Date.parse(lastSessionVerification.verifiedAt)})
            const sessionEvent=sessionEvents.get(a.id)
            if(sessionEvent)evidence.push({state:sessionEvent.kind==='session.verified'&&!lastSessionVerification?.configurationMatches?'unverified':sessionStates[sessionEvent.kind],time:Date.parse(sessionEvent.time)||0})
            const loginState=evidence.sort((x,y)=>y.time-x.time)[0]?.state || 'unverified'
            return { id:a.id, label:maskEmail(email), enabled:a.enabled, configured:isUsableEmail(email), placeholder:!isUsableEmail(email), passwordConfigured:!!a.password, proxyConfigured:!!a.proxyUrl, configurationState:!configuration.revision?'environment':same?'loaded':'saved_pending_run', configurationRevision:configuration.revision, loginState,lastSessionVerification, loginEvidence:login || null, result:r?.status || null, reportedPoints:number(r?.collectedPoints), pointsSource:'上游 last-summary.json 的 collectedPoints；并非已核验余额', exception:r?.error?redact(r.error):null, pauseReason:stop?redact(stop):null }
        })
        let runLog = ''
        try { runLog = fs.readdirSync(logs).filter(n => /^run-\d{8}-\d{6}-\d+\.log$/.test(n)).sort().at(-1) || '' } catch {}
        const log = runLog ? readFile(path.join(logs, runLog)) : ''
        const verification = /Login verification or restriction requires manual review/.test(log) ? '最近任务日志提示登录验证或账号限制；关联账号未单独报告' : null
        if (risk && verification) for (const a of accounts) a.pauseReason = `${a.pauseReason}；${verification}`
        const started = /Run \d{8}-\d{6}-\d+ started/.test(log) ? /\[([^\]]+)\]/.exec(log)?.[1] : null
        const durations = [...log.matchAll(/Bot exited with code \d+ after (\d+)s/g)].map(m => Number(m[1]))
        const last = { finishedAt: status.finishedAt || null, result: status.result || null, exitCode: number(status.exitCode), attempts: number(status.attempts), trigger: ['schedule','startup','manual'].includes(status.trigger) ? status.trigger : null }
        const readinessEnv={...env}
        if(configuration.revision){for(const k of Object.keys(readinessEnv))if(/^ACCOUNT_[1-9]\d*_/.test(k))delete readinessEnv[k];configuration.accounts.filter(a=>a.enabled).forEach((a,i)=>{readinessEnv[`ACCOUNT_${i+1}_EMAIL`]=a.email;readinessEnv[`ACCOUNT_${i+1}_PASSWORD`]=a.password})}
        return { observedAt: new Date().toISOString(), version: env.MRS_VERSION || 'unknown', commit: env.MRS_COMMIT || 'unknown', upstreamCommit: 'd0f07d74a0ed4dda127855d6e3dde98bf4c89d6e', imageVersion: env.MRS_VERSION || 'unknown', dockerStatus: '控制服务可达；未访问 Docker Engine', uid: process.getuid(), active, elapsedSeconds, verification, paused: fs.existsSync(path.join(state, 'STOP')) || needsReview, risk, pauseReason: redact(stop), failures: number(readFile(path.join(state,'consecutive-failures')).trim() || 0), last, startedAt: started, reportedAttemptSeconds: durations.length ? durations.reduce((a,b)=>a+b,0) : null, durationSource: '任务日志中的各次 Bot 运行耗时之和，不含等待/重试延迟', points: { currentBalance: null, reportedChange: active ? null : number(summary.totalCollectedPoints), source: '上游累计运行摘要；非独立核验余额，崩溃未报告部分未知' }, accounts, health: { schedulerProcesses: scheduler, chromiumProcesses: pids('chrome-headless-shell'), note: '浏览器无任务时没有进程属于正常；未执行真实账号探测' }, settings: { setup: {...runtimeReadiness(readinessEnv), envLoadedAt: environmentLoadedAt, accountConfigurationRevision:configuration.revision, accountConfigurationSource:configuration.revision?"持久化账号配置":"启动环境变量", restartRequiredSettings:["CRON_SCHEDULE","TZ","PUID","PGID","CONFIG_*","HTTP_PROXY","HTTPS_PROXY"]}, schedule: env.CRON_SCHEDULE || '', timezone: env.TZ || 'UTC', nextScheduledAt: next, scheduleError, logRetentionDays: number(env.LOG_RETENTION_DAYS || 14), validation: { valid: !scheduleError, errors: scheduleError ? [scheduleError] : [] }, directories: ['config','sessions','state','logs','diagnostics'].map(n => ({ name: n, readable: fs.existsSync(path.join(dir,n)) })) } }
    }
    app.disable('x-powered-by'); app.use(express.json({ limit: '8kb' }))
    app.use((req,res,next) => equal(req.headers.authorization, `Bearer ${env.CONTROL_API_TOKEN}`) ? next() : res.status(401).json({ error: '未授权' }))
    app.get('/snapshot', (_req,res) => res.json(snapshot()))
    app.get('/tasks',(_req,res)=>{reconcile();res.json(ledger.list().map(x=>ledger.public(x.id)))})
    app.get('/sessions',(_req,res)=>{const records=jsonFile(path.join(env.CONTROL_DATA_DIR || path.join(dir,'control-data'),'verified-sessions.json'));res.json(Object.entries(records).map(([key,r])=>({accountId:key.split(':')[0],platform:key.split(':')[1],lastVerifiedAt:r.verifiedAt,revision:r.revision,availablePoints:r.availablePoints,source:r.source,currentStatus:'需要重新实时核验；历史记录不代表当前有效'})))})
    app.post('/tasks/recovery',async(req,res)=>{
        const run=ledger.get(req.body.id);if(!run)throw httpError(404,'运行记录不存在')
        const runtime=accountStore.runtime(),config=jsonFile(path.join(dir,'config/config.json'))
        const current=signature(env,runtime.accounts,config),suspect=run.evidence.some(x=>x.state==='running'||x.state==='suspect')
        const pending=run.accounts.filter(id=>!run.evidence.some(x=>x.account===id && x.stage==='account'))
        let sessions={};try{sessions=jsonFile(path.join(env.CONTROL_DATA_DIR || path.join(dir,'control-data'),'verified-sessions.json'))}catch{}
        const fresh=pending.every(id=>{const record=sessions[`${id}:mobile`],age=Date.now()-Date.parse(record?.verifiedAt);if(!record || record.revision!==runtime.revision || !Number.isFinite(age) || age<0 || age>=300000)return false;try{const account=runtime.accounts.find(a=>a.id===id),loaded=createRequire(import.meta.url)(path.join(dir,'dist/util/SessionStore.js')).loadSession(config.sessionPath,account.email.trim(),true);return loaded?.storageState && createRequire(import.meta.url)('node:crypto').createHmac('sha256',env.CONTROL_API_TOKEN).update(JSON.stringify(loaded.storageState)).digest('hex')===record.storageHash}catch{return false}})
        const reason=['running','completed','recovery_requested'].includes(run.state)?'run_not_recoverable':current!==run.signature?'config_changed':fs.existsSync(path.join(state,'STOP'))?'risk_or_manual_pause':suspect?'step_suspect':snapshot().paused?'risk_or_manual_pause':!pending.length?'no_safe_pending_account':!fresh?'session_recheck_required':'pending_accounts_only'
        if(req.body.execute!==true)return res.json({taskId:run.id,eligible:reason==='pending_accounts_only',reason,pendingAccounts:pending,granularity:'仅未开始账号；不按搜索索引或完成时间跳过阶段'})
        if(reason!=='pending_accounts_only' || req.body.confirmation!=='只继续未开始账号')throw httpError(409,'恢复条件未通过：'+reason)
        if(interactive.worker || launching || snapshot().active)throw httpError(409,'已有任务或登录交互')
        const reserved=ledger.db.prepare("UPDATE runs SET state='recovery_requested' WHERE id=? AND state=?").run(run.id,run.state);if(reserved.changes!==1)throw httpError(409,'恢复请求已经被其他实例接受');
        const emails=runtime.accounts.filter(a=>pending.includes(a.id)).map(a=>a.email)
        const child=spawn(ctl,['run'],{env:{...env,RUN_ACCOUNT_FILTER:emails.join(',')},stdio:'ignore',shell:false});launching=true;child.once('exit',()=>{launching=false});child.once('error',()=>{launching=false});res.status(202).json({accepted:true,pendingAccounts:pending})
    })
    app.post('/login',async(req,res)=>{
        const {accountId,owner,action,input}=req.body
        if(typeof owner!=='string'||owner.length<32)throw httpError(400,'登录归属令牌无效')
        if(!accountStore.read().accounts.some(a=>a.id===accountId&&a.enabled))throw httpError(404,'启用账号不存在')
        if(action==='start'){if(mutating || launching || snapshot().active)throw httpError(409,'任务进行中');res.json(await interactive.start(accountId,owner))}
        else if(action==='close'){await interactive.call(accountId,owner,'state');await interactive.close();res.json({closed:true})}
        else res.json(await interactive.call(accountId,owner,action,input))
    })
    app.get('/accounts',(_req,res)=>res.json(accountStore.public()))
    app.post('/accounts',(req,res,next)=>{
        try{
            if(mutating || launching || interactive.worker || snapshot().active)throw httpError(409,'任务或登录交互进行中，不能修改账号')
            mutating=true
            let data
            try{data=JSON.parse(execFileSync('/usr/bin/flock',['-n',path.join(state,'run.lock'),process.execPath,fileURLToPath(new URL('./accounts.mjs',import.meta.url))],{env,input:JSON.stringify(req.body),timeout:10000,maxBuffer:262144,stdio:['pipe','pipe','ignore']}).toString())}
            catch(e){let error;try{error=JSON.parse(String(e.stdout))}catch{};throw httpError(error?.status || 409,error?.error || '任务锁占用或配置保存失败；原配置未变')}
            journal.add('configuration_applied',{result:'账号配置已保存，下一次任务加载',reason:`revision ${data.revision}`})
            res.json({...data,message:'已原子保存；下次任务启动加载，登录尚未验证'})
        }catch(e){next(e)}finally{mutating=false}
    })
    app.get('/events', (req,res) => res.json(journal.list(/^\d+$/.test(req.query.after || '') ? Number(req.query.after) : 0)))
    app.get('/events/stream', (req,res) => streamCoreEvents(journal,req,res))
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
            if(action==='run' && interactive.worker)throw httpError(409,'人工登录占用原任务锁')
            if(action==='run' && accountStore.read().revision && !current.accounts.some(a=>a.enabled))throw httpError(409,'没有启用账号')
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
    return { app, snapshot, journal, ledger, interactive, shutdown:async()=>{await interactive.close();ledger.close();journal.close()},close: () => {interactive.close().catch(()=>{});ledger.close();journal.close()} }
}
if (process.argv[1] && path.basename(process.argv[1]) === 'agent.mjs') {
    const agent = createAgent(), server = agent.app.listen(Number(process.env.CONTROL_PORT || 8090),'0.0.0.0')
    const stop = async () => {setTimeout(()=>process.exit(0),10000).unref();server.closeAllConnections();await agent.shutdown();server.close(()=>process.exit(0))}
    process.once('SIGTERM',stop); process.once('SIGINT',stop)
}
