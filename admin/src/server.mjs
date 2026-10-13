import express from 'express'
import helmet from 'helmet'
import session from 'express-session'
import { rateLimit } from 'express-rate-limit'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { Store, SqliteSessionStore } from './store.mjs'
import { LiveEventHub } from './live-events.mjs'
import { Notifications, validateConfig, configPublic } from './notifications.mjs'
import { token, equal, hashPassword, checkPassword, passwordValid, httpError, redact } from './security.mjs'
const publicDirectory=fileURLToPath(new URL('../public/',import.meta.url))
export function createWeb(env=process.env, options={}) {
    if ((env.CONTROL_API_TOKEN || '').length<32 || (env.WEB_BOOTSTRAP_TOKEN || '').length<32) throw new Error('Web control and bootstrap secrets must contain at least 32 characters')
    const publicUrl=new URL(env.ADMIN_PUBLIC_URL || 'http://localhost:8088')
    if(!['http:','https:'].includes(publicUrl.protocol) || publicUrl.username || publicUrl.password)throw new Error('Invalid ADMIN_PUBLIC_URL')
    const secure=env.WEB_COOKIE_SECURE==='true'
    if(secure && publicUrl.protocol!=='https:')throw new Error('Secure cookies require HTTPS public URL')
    const store=new Store(env.WEB_DATA_DIR || '/data'), app=express()
    const notifications=new Notifications(store,{publicUrl:publicUrl.href,...options.notificationOptions})
    let stopped=false, polling=false, connected=null, schedulerHealthy=null
    const agentUrl=env.CONTROL_URL || 'http://rewards:8090'
    const liveHub=new LiveEventHub(store,{baseUrl:agentUrl,token:env.CONTROL_API_TOKEN})
    async function agent(route, body) {
        const r=await fetch(new URL(route,agentUrl),{method:body?'POST':'GET',headers:{authorization:`Bearer ${env.CONTROL_API_TOKEN}`,...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(route==='/login'?35000:12000),redirect:'error'})
        if(!r.ok){ const data=await r.json().catch(()=>({}));throw httpError(r.status,redact(data.error || '控制服务暂不可用')) }
        return route.startsWith('/logs/')?r.text():r.json()
    }
    app.disable('x-powered-by')
    if(env.WEB_TRUST_PROXY==='true')app.set('trust proxy',1)
    app.use(helmet({contentSecurityPolicy:{directives:{defaultSrc:["'self'"],scriptSrc:["'self'"],styleSrc:["'self'"],connectSrc:["'self'"],imgSrc:["'self'",'data:'],objectSrc:["'none'"],frameAncestors:["'none'"],upgradeInsecureRequests:secure?[]:null}},strictTransportSecurity:secure?undefined:false}))
    app.use(express.json({limit:'16kb'}))
    app.get('/healthz',(_req,res)=>res.json({healthy:true,uid:process.getuid(),version:env.MRS_VERSION || '1.1.0-rc.5'}))
    app.use(session({name:'mrs.sid',secret:store.get('sessionSecret'),resave:false,saveUninitialized:false,store:new SqliteSessionStore(store),cookie:{httpOnly:true,sameSite:'strict',secure,maxAge:8*3600000}}))
    app.use('/api',(_req,res,next)=>{res.set('Cache-Control','no-store');next()})
    app.get('/api/session',(req,res)=>{
        req.session.csrf ||= token()
        res.json({initialized:!!store.get('admin'),authenticated:req.session.admin===true,csrf:req.session.csrf,secureCookie:secure})
    })
    app.use('/api',(req,_res,next)=>{
        if(['GET','HEAD','OPTIONS'].includes(req.method))return next()
        store.audit(req.session.admin===true?'admin':'anonymous',`request_${req.path.slice(0,100)}`,'修改类请求')
        if(req.headers.origin!==publicUrl.origin || !equal(req.headers['x-csrf-token'],req.session.csrf))return next(httpError(403,'请求来源或 CSRF 校验失败'))
        next()
    })
    const loginLimit=(req,res,next)=>{
        const id=crypto.createHash('sha256').update(req.ip).digest('hex'), now=Date.now()
        store.db.prepare('DELETE FROM login_limits WHERE until<?').run(now)
        const row=store.db.prepare('SELECT * FROM login_limits WHERE id=?').get(id)
        if(row?.count>=Number(env.WEB_LOGIN_LIMIT || 10)){store.audit('anonymous','login_rate_limited','拒绝');return res.status(429).json({error:'登录过于频繁，请稍后再试'})}
        store.db.prepare('INSERT OR REPLACE INTO login_limits VALUES(?,?,?)').run(id,(row?.count || 0)+1,row?.until || now+15*60000)
        store.db.exec('DELETE FROM login_limits WHERE id NOT IN (SELECT id FROM login_limits ORDER BY until DESC LIMIT 5000)')
        next()
    }
    let initializing=false
    app.post('/api/setup',loginLimit,async(req,res)=>{
        if(store.get('admin') || initializing)throw httpError(409,'管理员已初始化')
        if(!equal(req.body.bootstrapToken,env.WEB_BOOTSTRAP_TOKEN) || !passwordValid(req.body.password) || !/^[\w-]{3,32}$/.test(req.body.username || '')){store.audit('anonymous','setup_failed','无效初始化信息');throw httpError(400,'初始化令牌、用户名或密码无效（密码至少 12 位）')}
        initializing=true
        try{const admin={username:req.body.username,...await hashPassword(req.body.password)};store.set('admin',admin);store.audit('admin','setup','成功');res.json({ok:true})}finally{initializing=false}
    })
    app.post('/api/login',loginLimit,async(req,res)=>{
        const a=store.get('admin')
        const password=typeof req.body.password==='string'?req.body.password.slice(0,129):''
        if(!await checkPassword(password,a) || req.body.username!==a?.username){store.audit('anonymous','login_failed','凭证错误');throw httpError(401,'用户名或密码错误')}
        await new Promise((resolve,reject)=>req.session.regenerate(e=>e?reject(e):resolve()))
        req.session.admin=true;req.session.csrf=token();store.audit('admin','login','成功');res.json({ok:true,csrf:req.session.csrf})
    })
    app.use('/api',(req,_res,next)=>req.session.admin===true?next():next(httpError(401,'请先登录')))
    app.post('/api/logout',async(req,res)=>{store.audit('admin','logout','成功');if(req.session.loginBinding)await agent('/login',{...req.session.loginBinding,action:'close'}).catch(()=>{});await new Promise((resolve,reject)=>req.session.destroy(e=>e?reject(e):resolve()));res.clearCookie('mrs.sid',{httpOnly:true,sameSite:'strict',secure});res.json({ok:true})})
    app.get('/api/snapshot',async(_req,res)=>res.json(await agent('/snapshot')))
    app.get('/api/logs',async(req,res)=>res.json(await agent(`/logs?date=${encodeURIComponent(req.query.date || '')}&result=${encodeURIComponent(req.query.result || '')}`)))
    app.get('/api/logs/:name',async(req,res)=>{
        if(!/^run-\d{8}-\d{6}-\d+\.log$/.test(req.params.name))throw httpError(400,'日志名称无效')
        const text=redact(await agent(`/logs/${req.params.name}`))
        if(req.query.download==='1')res.attachment(req.params.name)
        res.type('text/plain').send(text)
    })
    const mutationLimit=rateLimit({windowMs:60000,limit:30,standardHeaders:'draft-8',legacyHeaders:false})
    app.get('/api/accounts',async(_req,res)=>res.json(await agent('/accounts')))
    app.get('/api/sessions',async(_req,res)=>res.json(await agent('/sessions')))
    app.get('/api/tasks',async(_req,res)=>res.json(await agent('/tasks')))
    app.post('/api/tasks/recovery',mutationLimit,async(req,res)=>{store.audit('admin','task_recovery',req.body.execute===true?'执行请求':'校验请求');res.json(await agent('/tasks/recovery',req.body))})
    app.post('/api/login-interaction',rateLimit({windowMs:60000,limit:120,standardHeaders:'draft-8',legacyHeaders:false}),async(req,res)=>{
        const {action,accountId,input}=req.body
        if(!['start','state','frame','input','verify','close'].includes(action))throw httpError(400,'登录操作不允许')
        if(action==='start'){
            if(!await checkPassword(String(req.body.password || '').slice(0,129),store.get('admin')) || req.body.confirmation!=='仅人工登录，不解除风险暂停')throw httpError(403,'人工登录需要管理员密码与明确确认')
            if(req.session.loginBinding && req.session.loginBinding.accountId!==accountId)throw httpError(409,'请先关闭原账号登录交互')
            req.session.loginBinding ||= {accountId,owner:token()}
        }
        const b=req.session.loginBinding
        if(!b || b.accountId!==accountId)throw httpError(403,'该登录交互不属于当前管理会话')
        if(action!=='frame' && action!=='state')store.audit('admin','login_'+action,'人工操作；不记录输入内容')
        const result=await agent('/login',{accountId,owner:b.owner,action,input})
        if(action==='close')delete req.session.loginBinding
        res.json(result)
    })
    app.post('/api/accounts',mutationLimit,async(req,res)=>{
        store.audit('admin','account_configuration','请求')
        try{const data=await agent('/accounts',req.body);store.audit('admin','account_configuration',`已保存 revision ${data.revision}`);res.json(data)}catch(e){store.audit('admin','account_configuration','拒绝/失败，未确认保存');throw e}
    })
    app.post('/api/control',mutationLimit,async(req,res)=>{
        const action=req.body.action
        if(!['run','stop','pause','resume'].includes(action))throw httpError(400,'操作不允许')
        store.audit('admin',`control_${action}`,'请求')
        try{const data=await agent('/control',{action});store.audit('admin',`control_${action}`,'已接受');res.status(action==='run'?202:200).json(data)}catch(e){store.audit('admin',`control_${action}`,'拒绝/失败');throw e}
    })
    app.post('/api/risk-review',loginLimit,mutationLimit,async(req,res)=>{
        if(!await checkPassword(typeof req.body.password==='string'?req.body.password.slice(0,129):'',store.get('admin'))){store.audit('admin','risk_review','密码核查失败');throw httpError(401,'请重新输入管理员密码')}
        const s=await agent('/snapshot')
        if(s.active || !s.risk)throw httpError(409,'没有可人工恢复的风险暂停，或任务仍在运行')
        req.session.review={nonce:token(),expires:Date.now()+60000,reason:s.pauseReason}
        store.audit('admin','risk_review','生成一次性确认');res.json({nonce:req.session.review.nonce,reason:s.pauseReason,expiresInSeconds:60})
    })
    app.post('/api/risk-resume',mutationLimit,async(req,res)=>{
        const review=req.session.review;delete req.session.review
        if(!review || review.expires<Date.now() || !equal(review.nonce,req.body.nonce) || req.body.confirmation!=='已完成人工核查并确认恢复'){store.audit('admin','risk_resume','确认失败');throw httpError(403,'二次确认无效或过期')}
        const s=await agent('/snapshot')
        if(s.active || !s.risk || s.pauseReason!==review.reason)throw httpError(409,'暂停状态已变化，请重新核查')
        store.audit('admin','risk_resume','人工二次确认，提交恢复')
        try{res.json(await agent('/control',{action:'resume-reviewed',reviewed:true}))}catch(e){store.audit('admin','risk_resume','控制服务拒绝/失败');throw e}
    })
    app.get('/api/notifications',(_req,res)=>res.json({config:configPublic(store.get('notifications')),deliveries:notifications.list()}))
    app.post('/api/notifications',mutationLimit,(req,res)=>{
        const c=validateConfig(req.body,store.get('notifications'));store.set('notifications',c);store.audit('admin','notification_settings','已保存');res.json(configPublic(c))
    })
    app.post('/api/notifications/test',mutationLimit,(req,res)=>{
        const config=store.get('notifications')
        if(!config.telegram.enabled && !config.smtp.enabled){store.audit('admin','notification_test','拒绝：未启用渠道');throw httpError(409,'请至少启用一个已配置的通知渠道')}
        const eventId=notifications.enqueue({kind:'test',result:'管理员测试通知'})
        if(!store.db.prepare('SELECT id FROM deliveries WHERE event=? LIMIT 1').get(eventId)){store.audit('admin','notification_test','拒绝：队列已满');throw httpError(429,'通知队列已满，请稍后再试')}
        store.audit('admin','notification_test','已入队');res.status(202).json({eventId})
    })
    app.get('/api/audit',(_req,res)=>res.json(store.db.prepare('SELECT time,actor,action,result FROM audit ORDER BY id DESC LIMIT 200').all()))
    app.get('/api/events',(_req,res)=>res.json(store.db.prepare('SELECT time,kind,v FROM events ORDER BY time DESC LIMIT 100').all().map(x=>({...x,...JSON.parse(x.v),v:undefined}))))
    app.get('/api/events/history',(req,res)=>res.json(/^\d+$/.test(String(req.query.after||''))?liveHub.recent(Number(req.query.after),100):liveHub.latest(100)))
    app.get('/api/events/live',(req,res)=>liveHub.subscribe(req,res))
    app.use('/api',(_req,res)=>res.status(404).json({error:'接口不存在'}))
    app.use(express.static(publicDirectory,{index:'index.html'}))
    app.use((err,_req,res,_next)=>res.status(err.status || 500).json({error:err.status && err.status<500?redact(err.message):'服务暂不可用，请查看审计记录'}))
    async function poll(){
        if(polling || stopped)return
        polling=true
        try{
            const epoch=store.get('coreLiveGap')?.time
            const s=await agent('/snapshot')
            const events=await agent(`/events?after=${store.get('eventCursor') || 0}`)
            if(epoch!==store.get('coreLiveGap')?.time)return // A simultaneous Core reset invalidates this old cursor response.
            // Declare recovery only after BOTH endpoints work, not before a failing event fetch.
            if(connected===false)notifications.enqueue({id:`recovered-${Date.now()}`,kind:'service_recovered',result:'任务控制连接恢复'})
            connected=true
            const healthy=s.health.schedulerProcesses>0
            if(schedulerHealthy!==healthy && schedulerHealthy!==null)notifications.enqueue({id:`scheduler-${Date.now()}`,kind:healthy?'service_recovered':'service_unavailable',result:'调度器健康状态变化'})
            schedulerHealthy=healthy
            for(const e of events){
                const identity=`agent-${e.id}-${e.time || 'legacy'}`
                notifications.enqueue({...e,id:identity})
                if(e.kind==='task_finished' && e.result==='failed')notifications.enqueue({...e,id:`${identity}-failed`,kind:'task_failed'})
                store.set('eventCursor',e.id)
            }
        }catch{
            if(connected!==false)notifications.enqueue({id:`unavailable-${Date.now()}`,kind:'service_unavailable',reason:'任务控制接口不可达，未触发或重试核心任务'})
            connected=false
        }finally{polling=false}
    }
    const timers=options.background===false?[]:[setInterval(()=>{poll().catch(()=>{})},2000),setInterval(()=>{notifications.tick().catch(()=>{})},1000)]
    for(const t of timers)t.unref()
    if(options.background!==false)liveHub.start()
    return {app,store,notifications,poll,agent,liveHub,async close(){stopped=true;for(const t of timers)clearInterval(t);await liveHub.stop();while(polling || notifications.running)await new Promise(r=>setTimeout(r,50));store.close()}}
}
if(process.argv[1] && path.basename(process.argv[1])==='server.mjs'){
    const web=createWeb(),server=web.app.listen(Number(process.env.WEB_PORT || 8080),'0.0.0.0')
    const stop=async()=>{setTimeout(()=>process.exit(0),15000).unref();await web.close();server.closeAllConnections();server.close(()=>process.exit(0))}
    process.once('SIGTERM',stop);process.once('SIGINT',stop)
}
