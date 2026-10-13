import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createAgent, readFile } from '../src/agent.mjs'
import { createWeb } from '../src/server.mjs'
import { redact, token } from '../src/security.mjs'
const root=fileURLToPath(new URL('../../',import.meta.url))
async function listen(app){const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));return {server,url:`http://127.0.0.1:${server.address().port}`}}
async function close(server){await new Promise(r=>server.close(r))}
async function until(check){for(let i=0;i<150;i++){if(await check())return;await new Promise(r=>setTimeout(r,100))}throw new Error('Condition timed out')}
async function fixture(){
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mrs-admin-')),appDir=path.join(dir,'app')
    for(const d of ['state','logs','config','sessions','diagnostics'])fs.mkdirSync(path.join(appDir,d),{recursive:true})
    const calls=path.join(dir,'calls');fs.writeFileSync(calls,'')
    const ctl=path.join(dir,'ctl');fs.writeFileSync(ctl,`#!/usr/bin/env bash\nif [ "$1" = run ]; then exec bash '${root}docker/rewards-run.sh' manual; fi\nexec bash '${root}docker/rewards-ctl.sh' "$@"\n`,{mode:0o700})
    const env={...process.env,CONTROL_API_TOKEN:token(),WEB_BOOTSTRAP_TOKEN:token(),APP_DIR:appDir,STATE_DIR:path.join(appDir,'state'),LOG_DIR:path.join(appDir,'logs'),CONTROL_DATA_DIR:path.join(dir,'control'),WEB_DATA_DIR:path.join(dir,'web'),CTL_PATH:ctl,REWARDS_CTL_ALLOW_ROOT:'1',REWARDS_LIB:root+'docker/lib.sh',SUMMARY_MERGE_JQ:root+'docker/merge-summary.jq',REWARDS_RUN_CMD:`bash ${root}tests/fake-bot.sh`,FAKE_CALLS:calls,FAKE_GRANDCHILD:path.join(dir,'grandchild'),FAKE_MODE:'slow',MAX_RETRIES:'0',MAX_CONSECUTIVE_FAILED_RUNS:'2',WATCH_INTERVAL_SECONDS:'1',STOP_GRACE_SECONDS:'1',MIN_SLEEP_MINUTES:'0',MAX_SLEEP_MINUTES:'0',CRON_SCHEDULE:'0 9 * * *',TZ:'Asia/Shanghai',ACCOUNT_1_EMAIL:'alice@example.invalid',ACCOUNT_1_PASSWORD:'NEVER_EXPOSE_PASSWORD',ACCOUNT_1_TOTP_SECRET:'NEVER_EXPOSE_TOTP',ADMIN_PUBLIC_URL:'http://127.0.0.1:8088',WEB_LOGIN_LIMIT:'50'}
    const agent=createAgent(env),a=await listen(agent.app);env.CONTROL_URL=a.url
    const web=createWeb(env,{background:false}),w=await listen(web.app)
    let cookie='',csrf=''
    const request=async(url,body,{origin=env.ADMIN_PUBLIC_URL,csrfOverride,anonymous=false}={})=>{
        const headers={...(anonymous?{}:cookie?{cookie}:{}),...(body?{'content-type':'application/json',origin,'x-csrf-token':csrfOverride ?? csrf}:{})}
        const res=await fetch(w.url+'/api'+url,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined})
        const sc=res.headers.get('set-cookie');if(sc && !anonymous)cookie=sc.split(';')[0]
        const data=(res.headers.get('content-type')||'').includes('json')?await res.json():await res.text()
        return {res,data}
    }
    const session=async()=>{const r=await request('/session');csrf=r.data.csrf;return r}
    const login=async()=>{await session();await request('/setup',{username:'admin',password:'ValidPassword12345',bootstrapToken:env.WEB_BOOTSTRAP_TOKEN});const r=await request('/login',{username:'admin',password:'ValidPassword12345'});csrf=r.data.csrf;assert.equal(r.res.status,200)}
    return {dir,env,agent,web,a,w,request,session,login,getCookie:()=>cookie,async cleanup(){await close(w.server);await web.close();await close(a.server);agent.close();fs.rmSync(dir,{recursive:true,force:true})}}
}
test('credential redaction covers headers, multi-cookie, URL userinfo, JSON and emails',()=>{
    const s=redact('Cookie: A=COOKIESECRET; B=SECONDSECRET\nAuthorization: Basic AUTHSECRET\nhttp://user:PROXYSECRET@proxy.invalid\nhttps://api.telegram.org/bot123:TOKENVALUE/sendMessage\n{"totpSecret":"TOTPSECRET","accessToken":"ACCESSSECRET"}\nalice@example.invalid')
    for(const v of ['COOKIESECRET','SECONDSECRET','AUTHSECRET','PROXYSECRET','TOKENVALUE','TOTPSECRET','ACCESSSECRET','alice@'])assert.ok(!s.includes(v),v)
})
test('proc reads and symbolic-link log reads do not produce false status or leak files',t=>{
    if (!readFile(`/proc/${process.pid}/cmdline`).length && !process.env.CI) { t.skip('Local sandbox PID namespace does not match /proc; real Docker CI may not skip'); return }
    assert.ok(readFile(`/proc/${process.pid}/cmdline`).length>0)
    const d=fs.mkdtempSync(path.join(os.tmpdir(),'mrs-link-'));fs.writeFileSync(path.join(d,'secret'),'SECRET');fs.symlinkSync(path.join(d,'secret'),path.join(d,'link'));assert.equal(readFile(path.join(d,'link')),'');fs.rmSync(d,{recursive:true})
})
test('first-run bootstrap, password hashing, authorization, CSRF, fixation and persistence',async()=>{
    const f=await fixture()
    try{
        assert.equal((await f.request('/snapshot')).res.status,401)
        const s=await f.session();assert.match(s.res.headers.get('set-cookie'),/HttpOnly/);assert.match(s.res.headers.get('set-cookie'),/SameSite=Strict/)
        assert.equal((await f.request('/setup',{username:'admin',password:'ValidPassword12345',bootstrapToken:'wrong'})).res.status,400)
        assert.equal((await f.request('/setup',{username:'admin',password:'ValidPassword12345',bootstrapToken:f.env.WEB_BOOTSTRAP_TOKEN},{origin:'http://evil.invalid'})).res.status,403)
        assert.equal((await f.request('/setup',{username:'admin',password:'ValidPassword12345',bootstrapToken:f.env.WEB_BOOTSTRAP_TOKEN},{csrfOverride:'wrong'})).res.status,403)
        const original=f.getCookie();await f.login();assert.notEqual(f.getCookie(),original)
        const stored=f.web.store.get('admin');assert.equal(stored.algorithm,'scrypt-N32768-r8-p3');assert.ok(!JSON.stringify(stored).includes('ValidPassword'))
        assert.equal((await f.request('/setup',{username:'other',password:'ValidPassword12345',bootstrapToken:f.env.WEB_BOOTSTRAP_TOKEN})).res.status,409)
        assert.equal((await f.request('/control',{action:'run'},{csrfOverride:'wrong'})).res.status,403)
        assert.equal((await f.request('/control',{action:'sh -c echo x'})).res.status,400)
        const snapshot=await f.request('/snapshot');assert.equal(snapshot.res.status,200);const text=JSON.stringify(snapshot.data)
        assert.ok(!text.includes('NEVER_EXPOSE') && !text.includes('alice@'))
        assert.equal(snapshot.data.points.currentBalance,null);assert.equal(snapshot.data.settings.setup.usableAccountSlots,0);assert.ok(snapshot.data.settings.setup.issues.length>0);assert.match(snapshot.data.settings.nextScheduledAt,/Z$/)
        assert.equal(snapshot.data.settings.timezone,'Asia/Shanghai')
        await close(f.w.server);await f.web.close()
        f.web=createWeb(f.env,{background:false});f.w=await listen(f.web.app)
        // request closure references fixture's original web endpoint; verify persisted session explicitly.
        const persisted=await fetch(f.w.url+'/api/snapshot',{headers:{cookie:f.getCookie()}});assert.equal(persisted.status,200)
        await close(f.w.server);await f.web.close();await close(f.a.server);f.agent.close();fs.rmSync(f.dir,{recursive:true,force:true})
    }catch(e){await f.cleanup().catch(()=>{});throw e}
})
test('login failures are rate-limited across Web restart and written to audit',async()=>{
    const f=await fixture()
    try{
        f.env.WEB_LOGIN_LIMIT='2';await f.session()
        assert.equal((await f.request('/login',{username:'x',password:'bad'})).res.status,401)
        assert.equal((await f.request('/login',{username:'x',password:'bad'})).res.status,401)
        assert.equal((await f.request('/login',{username:'x',password:'bad'})).res.status,429)
        assert.ok(f.web.store.db.prepare("SELECT count(*) AS n FROM audit WHERE action='login_failed'").get().n>=2)
        await close(f.w.server);await f.web.close();const newWeb=createWeb(f.env,{background:false}),w=await listen(newWeb.app)
        const session=await fetch(w.url+'/api/session'),data=await session.json(),cookie=session.headers.get('set-cookie').split(';')[0]
        const r=await fetch(w.url+'/api/login',{method:'POST',headers:{cookie,origin:f.env.ADMIN_PUBLIC_URL,'content-type':'application/json','x-csrf-token':data.csrf},body:JSON.stringify({username:'x',password:'bad'})});assert.equal(r.status,429)
        await close(w.server);await newWeb.close();await close(f.a.server);f.agent.close();fs.rmSync(f.dir,{recursive:true,force:true})
    }catch(e){await f.cleanup().catch(()=>{});throw e}
})
test('manual Web trigger and scheduled wrapper share the real flock; risk pause cannot be overwritten',async()=>{
    const f=await fixture()
    try{
        await f.login();assert.equal((await f.request('/control',{action:'run'})).res.status,202)
        await until(()=>fs.readFileSync(f.env.FAKE_CALLS,'utf8').includes('filter='))
        assert.equal((await f.request('/control',{action:'run'})).res.status,409)
        const schedule=spawn('bash',[root+'docker/rewards-run.sh','schedule'],{env:{...f.env,SKIP_RANDOM_SLEEP:'true'},stdio:'ignore'})
        await new Promise(r=>schedule.once('exit',r))
        assert.equal(fs.readFileSync(f.env.FAKE_CALLS,'utf8').trim().split('\n').length,1)
        await until(()=>!f.agent.snapshot().active)
        fs.writeFileSync(path.join(f.env.STATE_DIR,'STOP'),'Microsoft risk - manual review')
        assert.equal((await f.request('/control',{action:'run'})).res.status,409)
        await f.request('/control',{action:'pause'})
        assert.match(fs.readFileSync(path.join(f.env.STATE_DIR,'STOP'),'utf8'),/Microsoft risk/)
        execFileSync('bash',[root+'docker/rewards-ctl.sh','pause','ordinary pause'],{env:f.env})
        assert.match(fs.readFileSync(path.join(f.env.STATE_DIR,'STOP'),'utf8'),/Microsoft risk/)
        assert.equal((await f.request('/control',{action:'resume'})).res.status,409)
        assert.equal((await f.request('/risk-resume',{nonce:'missing',confirmation:'已完成人工核查并确认恢复'})).res.status,403)
        const review=await f.request('/risk-review',{password:'ValidPassword12345'});assert.equal(review.res.status,200)
        assert.equal((await f.request('/risk-resume',{nonce:review.data.nonce,confirmation:'已完成人工核查并确认恢复'})).res.status,200)
        assert.ok(!fs.existsSync(path.join(f.env.STATE_DIR,'STOP')))
        assert.equal((await f.request('/risk-resume',{nonce:review.data.nonce,confirmation:'已完成人工核查并确认恢复'})).res.status,403)
        const audit=(await f.request('/audit')).data;assert.ok(audit.some(a=>a.action==='risk_resume'))
    }finally{await f.cleanup()}
})
test('logs are sanitized, traversal and symbolic links denied, notifications never expose saved credentials',async()=>{
    const f=await fixture()
    try{
        await f.login();const n='run-20261013-090000-123.log'
        fs.writeFileSync(path.join(f.env.LOG_DIR,n),'Cookie: A=SECRETONE; B=SECRETTWO\npassword=PASSWORDVALUE\nalice@example.invalid\n<script>alert(1)</script>')
        assert.equal((await f.request('/logs?date=../../')).res.status,400)
        assert.equal((await f.request('/logs?date=20261013')).data.length,1)
        const r=await f.request('/logs/'+n+'?download=1');assert.match(r.res.headers.get('content-disposition'),/attachment/);assert.equal(r.res.headers.get('content-type').split(';')[0],'text/plain')
        for(const v of ['SECRETONE','SECRETTWO','PASSWORDVALUE','alice@'])assert.ok(!r.data.includes(v))
        assert.equal((await f.request('/notifications/test',{})).res.status,409)
        const payload={telegram:{enabled:true,token:'123456:ABC123SECRET_abcdefghijklmnop',chatId:'123'},smtp:{enabled:false,password:'SMTPCREDENTIAL'}}
        assert.equal((await f.request('/notifications',payload)).res.status,200)
        assert.equal((await f.request('/notifications/test',{})).res.status,202)
        const result=JSON.stringify((await f.request('/notifications')).data);assert.ok(!result.includes('ABC123SECRET') && !result.includes('SMTPCREDENTIAL'))
        assert.equal(fs.statSync(path.join(f.env.WEB_DATA_DIR,'admin.sqlite')).mode&0o777,0o600)
        const html=await fetch(f.w.url+'/');assert.match(await html.text(),/中文|控制台/);assert.ok(html.headers.get('content-security-policy').includes("script-src 'self'"))
        assert.ok(!fs.readFileSync(root+'admin/public/app.js','utf8').includes('innerHTML'))
    }finally{await f.cleanup()}
})
test('durable agent event cursor prevents enqueue loops; connection failure never invokes core task',async()=>{
    const f=await fixture()
    try{
        f.agent.journal.add('risk_paused',{result:'risk_paused',reason:'manual review'})
        await f.web.poll();await f.web.poll()
        assert.equal(f.web.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='risk_paused'").get().n,1)
        await close(f.a.server);await f.web.poll();await f.web.poll()
        assert.equal(f.web.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='service_unavailable'").get().n,1)
        assert.equal(fs.readFileSync(f.env.FAKE_CALLS,'utf8'),'')
        await close(f.w.server);await f.web.close();f.agent.close();fs.rmSync(f.dir,{recursive:true,force:true})
    }catch(e){await f.cleanup().catch(()=>{});throw e}
})
test('agent journal storage failure cannot fail a successful core pause operation',async()=>{
    const f=await fixture()
    try{
        await f.login();f.agent.journal.db.exec('PRAGMA query_only=ON')
        assert.equal((await f.request('/control',{action:'pause'})).res.status,200)
        assert.ok(fs.existsSync(path.join(f.env.STATE_DIR,'STOP')))
        assert.equal(fs.readFileSync(f.env.FAKE_CALLS,'utf8'),'')
    }finally{await f.cleanup()}
})
test('a broken event endpoint cannot alternate recovered/unavailable notifications forever',async()=>{
    const f=await fixture()
    try{
        f.agent.journal.db.exec('DROP TABLE events')
        await f.web.poll();await f.web.poll();await f.web.poll()
        assert.equal(f.web.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='service_unavailable'").get().n,1)
        assert.equal(f.web.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='service_recovered'").get().n,0)
        f.agent.journal.db.exec('CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT,kind TEXT,v TEXT)')
        await f.web.poll();await f.web.poll()
        assert.equal(f.web.store.db.prepare("SELECT count(*) AS n FROM events WHERE kind='service_recovered'").get().n,1)
        assert.equal(fs.readFileSync(f.env.FAKE_CALLS,'utf8'),'')
    }finally{await f.cleanup()}
})
