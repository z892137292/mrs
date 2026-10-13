// Real compiled upstream Browser, real Chromium/CDP/IPC and session DB; isolated local HTTP fixture.
// This is NOT Microsoft login acceptance.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { execFileSync,spawnSync } from 'node:child_process'
import { token } from '../admin/src/security.mjs'
import { Accounts } from '../admin/src/accounts.mjs'
import { pathToFileURL } from 'node:url'
const codeRoot=fs.existsSync('/opt/mrs-admin/src/agent.mjs')?'/opt/mrs-admin/src/':new URL('../admin/src/',import.meta.url).pathname
const {createAgent}=await import(pathToFileURL(path.join(codeRoot,'agent.mjs')))
const {createWeb}=await import(pathToFileURL(path.join(codeRoot,'server.mjs')))
const upstream=process.env.APP_DIR || process.env.UPSTREAM_TEST_DIR
assert.notEqual(process.getuid(),0,'Chromium integration must run as non-root')
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mrs-interactive-')),owner=token()
let risk=false,identity='FIXTURE-ONE',challenge=false,authExpired=false
const fixture=http.createServer((req,res)=>{
 if(req.url==='/userinfo'){
  res.setHeader('content-type','application/json')
  if(authExpired || !req.headers.cookie?.includes('fixture=verified')){res.statusCode=401;res.end('{}');return}
  res.end(JSON.stringify({dashboard:{userStatus:{isRewardsUser:true,ePuid:identity,availablePoints:123},userWarnings:risk?[{name:'Fraud_UserWarning_BotScore_UX'}]:[]}}));return
 }
 const authenticated=!challenge&&req.headers.cookie?.includes('fixture=verified')
 res.setHeader('content-type','text/html');res.end('<!doctype html><title>Offline manual login fixture</title><input id="value" style="position:absolute;left:10px;top:10px;width:250px;height:30px"><button style="position:absolute;left:10px;top:60px;width:220px;height:40px" onclick="document.cookie=\'fixture=verified; path=/; max-age=3600\';document.querySelector(\'p\').textContent=\'Fixture authenticated\'">Confirm manual action</button><p>'+(authenticated?'Fixture authenticated':'Authenticator verification fixture: no real Microsoft account')+'</p>')
})
await new Promise(r=>fixture.listen(0,'127.0.0.1',r))
for(const n of ['state','logs','sessions','config'])fs.mkdirSync(path.join(directory,n))
for(const n of ['dist','node_modules','package.json'])fs.symlinkSync(path.join(upstream,n),path.join(directory,n))
const config=JSON.parse(fs.readFileSync(path.join(upstream,'config.example.json')));config.sessionPath='./sessions';config.proxy.ignoreCertificateErrors=false;fs.writeFileSync(path.join(directory,'config/config.json'),JSON.stringify(config));fs.symlinkSync('config/config.json',path.join(directory,'config.json'))
const env={...process.env,APP_DIR:directory,STATE_DIR:path.join(directory,'state'),LOG_DIR:path.join(directory,'logs'),CONTROL_DATA_DIR:path.join(directory,'control'),CONTROL_API_TOKEN:token(),CRON_SCHEDULE:'0 0 1 1 *',TZ:'UTC',ACCOUNT_1_EMAIL:'Fixture@example.invalid',ACCOUNT_1_PASSWORD:'SYNTHETIC_ONLY',MRS_OFFLINE_TEST:'true',MRS_LOGIN_FIXTURE_URL:`http://127.0.0.1:${fixture.address().port}/`}
// Only the resume-dispatch consumer is a fixture; login, native DB, API, signatures and flock remain real.
const dispatchFile=path.join(directory,'dispatch'),fixtureCtl=path.join(directory,'fixture-ctl')
fs.writeFileSync(fixtureCtl,`#!/usr/bin/env bash\nif [ "$1" = run ]; then exec /usr/bin/flock -n '${env.STATE_DIR}/run.lock' bash -c 'printf "%s\\n" "$RUN_ACCOUNT_FILTER" >> "${dispatchFile}"; sleep 0.3'; fi\nexec /usr/local/bin/rewards-ctl "$@"\n`,{mode:0o700});env.CTL_PATH=fixtureCtl
const agent=createAgent(env),server=agent.app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r))
const id=agent.snapshot().accounts[0].id
try{
 // Invoke the ACTUAL compiled evidence hook, not a replacement executor.
 const require=createRequire(path.join(upstream,'package.json')),run='compiled-hook-fixture'
 agent.ledger.create(run,'fixture-signature',0,0,[id])
 const originalEnv=process.env
 try{process.env={...env,CONTROL_API_ENABLED:'true',MRS_RUN_ID:run,MRS_ACCOUNT_IDS:JSON.stringify({'fixture@example.invalid':id})};const {controlEvidence}=require(path.join(upstream,'dist/util/ControlEvidence.js'));controlEvidence(' FIXTURE@example.invalid ','account.started');controlEvidence('fixture@example.invalid','task.step.started','mobile_search');controlEvidence('fixture@example.invalid','task.step.completed','mobile_search',90,0);controlEvidence('fixture@example.invalid','task.step.returned','mobile_search');controlEvidence('fixture@example.invalid','account.completed')}finally{process.env=originalEnv}
 agent.ledger.finish(run,'success');assert.equal(agent.ledger.get(run).state,'completed');assert.equal(agent.ledger.get(run).evidence.find(x=>x.stage==='mobile_search').observed,90)
 await agent.interactive.start(id,owner)
 assert.match(fs.readFileSync(path.join(env.STATE_DIR,'STOP'),'utf8'),/manual login/)
 assert.throws(()=>execFileSync('/usr/bin/flock',['-n',path.join(env.STATE_DIR,'run.lock'),'true']))
 await assert.rejects(()=>agent.interactive.call(id,token(),'frame'),/归属/)
 let frame=await agent.interactive.call(id,owner,'frame');assert.ok(frame.image.length>100);assert.equal(frame.state,'waiting_manual')
 await agent.interactive.call(id,owner,'input',{type:'click',x:50,y:25});await agent.interactive.call(id,owner,'input',{type:'type',text:'HUMAN_INPUT'})
 await assert.rejects(()=>agent.interactive.call(id,owner,'input',{type:'evaluate',text:'arbitrary shell'}),/无效/)
 await assert.rejects(()=>agent.interactive.call(id,owner,'verify',{identityConfirmed:true}),/尚未/)
 await agent.interactive.call(id,owner,'input',{type:'click',x:100,y:80})
 await assert.rejects(()=>agent.interactive.call(id,owner,'verify',{}),/人工确认/)
 let result=await agent.interactive.call(id,owner,'verify',{identityConfirmed:true});assert.equal(result.state,'verified');assert.equal(result.availablePoints,123);assert.match(result.source,/fixture/)
 await assert.rejects(()=>agent.interactive.call(id,owner,'frame'),/不允许/)
 await agent.interactive.close();execFileSync('/usr/bin/flock',['-n',path.join(env.STATE_DIR,'run.lock'),'true'])
 // Actual stopped native sessions.db backup/restore into a NEW directory; never publish this private archive.
 const archive=path.join(directory,'private-native.tar'),restored=path.join(directory,'restored-native');fs.mkdirSync(restored)
 execFileSync('tar',['-C',directory,'-cf',archive,'sessions']);fs.chmodSync(archive,0o600);execFileSync('tar',['-C',restored,'-xf',archive])
 const native=require(path.join(upstream,'dist/util/SessionStore.js'));assert.ok(native.loadSession(path.join(restored,'sessions'),env.ACCOUNT_1_EMAIL,true).storageState.cookies.some(c=>c.name==='fixture'&&c.value==='verified'));native.closeSessionStore()
 await agent.interactive.start(id,owner)
 authExpired=true;await assert.rejects(()=>agent.interactive.call(id,owner,'verify',{}),/尚未/);authExpired=false
 result=await agent.interactive.call(id,owner,'verify',{});assert.equal(result.state,'verified') // actual cookie restored by original Browser factory
 await agent.interactive.close()
 const verifiedBeforeChallenge=JSON.parse(fs.readFileSync(path.join(env.CONTROL_DATA_DIR,'verified-sessions.json')))[`${id}:mobile`].verifiedAt
 challenge=true;await agent.interactive.start(id,owner);assert.equal((await agent.interactive.call(id,owner,'frame')).state,'waiting_manual');await assert.rejects(()=>agent.interactive.call(id,owner,'verify',{identityConfirmed:true}),/尚未完成/);await agent.interactive.close();challenge=false
 assert.equal(JSON.parse(fs.readFileSync(path.join(env.CONTROL_DATA_DIR,'verified-sessions.json')))[`${id}:mobile`].verifiedAt,verifiedBeforeChallenge) // A previously valid cookie must NOT override a currently pending challenge.
 identity='DIFFERENT-ACCOUNT';await agent.interactive.start(id,owner);await assert.rejects(()=>agent.interactive.call(id,owner,'verify',{identityConfirmed:true}),/身份/);await agent.interactive.close()
 identity='FIXTURE-ONE';risk=true;await agent.interactive.start(id,owner);await assert.rejects(()=>agent.interactive.call(id,owner,'verify',{}),/风险/);await assert.rejects(()=>agent.interactive.call(id,owner,'input',{type:'key',key:'Enter'}),error=>error.status===409);await agent.interactive.close()
 assert.ok(fs.existsSync(path.join(env.STATE_DIR,'STOP')))
 const serialized=JSON.stringify(agent.journal.list());assert.ok(!serialized.includes('HUMAN_INPUT') && !serialized.includes('SYNTHETIC_ONLY') && !serialized.includes('image'))
 assert.ok(agent.journal.list().some(e=>e.kind==='risk_paused'))
 assert.ok(agent.journal.list().some(e=>e.kind==='verification_required'))
 assert.equal(agent.snapshot().accounts.find(a=>a.id===id).loginState,'restricted')
 const edited=new Accounts(env);edited.update({action:'save',id,revision:0,values:{password:'SYNTHETIC_CHANGED_ONLY'}});assert.equal(edited.read().accounts[0].email,env.ACCOUNT_1_EMAIL) // Preserve the exact native case-sensitive session key during ordinary edits.
 const current=JSON.parse(fs.readFileSync(path.join(env.CONTROL_DATA_DIR,'verified-sessions.json')));assert.ok(current[`${id}:mobile`].storageHash)
 // Real authenticated Web -> Core -> SAME native browser; Web restart retains owner/session.
 risk=false
 const webEnv={...env,CONTROL_URL:`http://127.0.0.1:${server.address().port}`,WEB_DATA_DIR:path.join(directory,'web'),WEB_BOOTSTRAP_TOKEN:token(),ADMIN_PUBLIC_URL:'http://127.0.0.1:8088'}
 let web=createWeb(webEnv,{background:false}),webServer=web.app.listen(0,'127.0.0.1');await new Promise(r=>webServer.once('listening',r));let cookie='',csrf=''
 const request=async(route,body)=>{const r=await fetch(`http://127.0.0.1:${webServer.address().port}/api${route}`,{method:body?'POST':'GET',headers:{cookie,...(body?{'content-type':'application/json',origin:webEnv.ADMIN_PUBLIC_URL,'x-csrf-token':csrf}:{})},body:body?JSON.stringify(body):undefined});const c=r.headers.get('set-cookie');if(c)cookie=c.split(';')[0];return {status:r.status,data:await r.json()}}
 try{
  csrf=(await request('/session')).data.csrf
  assert.equal((await request('/setup',{username:'admin',password:'FixtureAdminPassword123',bootstrapToken:webEnv.WEB_BOOTSTRAP_TOKEN})).status,200)
  const login=await request('/login',{username:'admin',password:'FixtureAdminPassword123'});assert.equal(login.status,200);csrf=login.data.csrf
  assert.equal((await request('/login-interaction',{accountId:id,action:'start',password:'FixtureAdminPassword123',confirmation:'仅人工登录，不解除风险暂停'})).status,200)
  assert.equal((await request('/login-interaction',{accountId:'bbbbbbbbbbbbbbbb',action:'frame'})).status,403)
  assert.ok((await request('/login-interaction',{accountId:id,action:'frame'})).data.image.length>100)
  webServer.closeAllConnections();await new Promise(r=>webServer.close(r));await web.close()
  web=createWeb(webEnv,{background:false});webServer=web.app.listen(0,'127.0.0.1');await new Promise(r=>webServer.once('listening',r))
  assert.ok((await request('/session')).data.authenticated)
  assert.ok((await request('/login-interaction',{accountId:id,action:'frame'})).data.image.length>100)
  assert.equal((await request('/login-interaction',{accountId:id,action:'verify',input:{}})).data.state,'verified')
  const accountView=(await request('/snapshot')).data.accounts.find(a=>a.id===id);assert.equal(accountView.loginState,'session_verified_history');assert.equal(accountView.lastSessionVerification.availablePoints,123);assert.ok(!JSON.stringify(accountView).includes('storageHash'));assert.match(accountView.lastSessionVerification.currentStatus,/历史/)
  const sessions=await request('/sessions');assert.equal(sessions.status,200);assert.ok(!JSON.stringify(sessions.data).includes('storageHash'));assert.match(sessions.data[0].currentStatus,/重新/)
  assert.equal((await request('/login-interaction',{accountId:id,action:'close'})).status,200)
  const review=await request('/risk-review',{password:'FixtureAdminPassword123'});assert.equal(review.status,200)
  assert.equal((await request('/risk-resume',{nonce:review.data.nonce,confirmation:'已完成人工核查并确认恢复'})).status,200)
  const {signature}=require(path.join(codeRoot,'ledger.cjs')),resumeId='verified-pending-fixture',runtime=new Accounts(env).runtime()
  agent.ledger.create(resumeId,signature(env,runtime.accounts,JSON.parse(fs.readFileSync(path.join(directory,'config/config.json')))),runtime.revision,0,[id]);agent.ledger.finish(resumeId,'failed')
  const priorCwd=process.cwd();process.chdir(directory)
  let second,secondServer
  try{
   const eligible=await request('/tasks/recovery',{id:resumeId});assert.equal(eligible.data.eligible,true)
   second=createAgent(env);secondServer=second.app.listen(0,'127.0.0.1');await new Promise(r=>secondServer.once('listening',r))
   const body={id:resumeId,execute:true,confirmation:'只继续未开始账号'}
   const attempts=await Promise.all([request('/tasks/recovery',body),fetch(`http://127.0.0.1:${secondServer.address().port}/tasks/recovery`,{method:'POST',headers:{authorization:'Bearer '+env.CONTROL_API_TOKEN,'content-type':'application/json'},body:JSON.stringify(body)}).then(async r=>({status:r.status,data:await r.json()}))])
   assert.equal(attempts.filter(x=>x.data.accepted===true).length,1);assert.equal(attempts.filter(x=>x.status===409).length,1)
   for(let i=0;i<100&&!fs.existsSync(dispatchFile);i++)await new Promise(r=>setTimeout(r,20))
   assert.equal(fs.readFileSync(dispatchFile,'utf8'),env.ACCOUNT_1_EMAIL+'\n')
   assert.equal(agent.ledger.get(resumeId).state,'recovery_requested')
   native.closeSessionStore()
  }finally{process.chdir(priorCwd);if(second){await second.shutdown();secondServer.closeAllConnections();await new Promise(r=>secondServer.close(r))}}
  assert.equal((await request('/logout',{})).status,200)
  assert.equal((await request('/tasks')).status,401)
 }finally{webServer.closeAllConnections();await new Promise(r=>webServer.close(r));await web.close()}
 // Real wrapper + real Chromium + ACTUAL compiled hook: an uncertain return must halt, not just paint a paused label.
 for(let i=0;i<100;i++){try{execFileSync('/usr/bin/flock',['-n',path.join(env.STATE_DIR,'run.lock'),'true']);break}catch{await new Promise(r=>setTimeout(r,20))}}
 const suspectScript=path.join(directory,'suspect-browser.mjs')
 fs.writeFileSync(suspectScript,`import fs from 'node:fs';import {createRequire} from 'node:module';const require=createRequire(process.env.APP_DIR+'/package.json');const {chromium}=require('patchright');const {Ledger}=require('/opt/mrs-admin/src/ledger.cjs');const {controlEvidence}=require(process.env.APP_DIR+'/dist/util/ControlEvidence.js');const l=new Ledger(process.env.CONTROL_DATA_DIR);l.create(process.env.MRS_RUN_ID,'offline-hook-fixture',1,Number(process.env.MRS_WRAPPER_PID),[${JSON.stringify(id)}]);l.close();controlEvidence(process.env.ACCOUNT_1_EMAIL,'account.started');controlEvidence(process.env.ACCOUNT_1_EMAIL,'task.step.started','pc_search');const browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.setContent('<title>isolated uncertainty probe</title>');const stat=fs.readFileSync('/proc/self/stat','utf8');const pgid=stat.slice(stat.lastIndexOf(')')+2).trim().split(/\\s+/)[2];fs.writeFileSync(process.env.STATE_DIR+'/suspect-pgid',pgid,{mode:0o600});controlEvidence(process.env.ACCOUNT_1_EMAIL,'task.step.progress','pc_search',30,120);controlEvidence(process.env.ACCOUNT_1_EMAIL,'task.step.returned','pc_search');throw Error('unsafe hook returned instead of stopping');`,{mode:0o600})
 const quote=p=>"'"+p.replaceAll("'","'\\''")+"'"
 const suspectRun=spawnSync('/usr/local/bin/rewards-run',['manual'],{env:{...env,MRS_ACCOUNT_IDS:JSON.stringify({'fixture@example.invalid':id}),REWARDS_RUN_CMD:'node '+quote(suspectScript),MAX_RETRIES:'2',MIN_SLEEP_MINUTES:'0',MAX_SLEEP_MINUTES:'0',WATCH_INTERVAL_SECONDS:'1',STOP_GRACE_SECONDS:'2',RUN_TIMEOUT_SECONDS:'30'},encoding:'utf8',timeout:45000})
 assert.equal(suspectRun.status,78,suspectRun.stderr || suspectRun.stdout);assert.match(fs.readFileSync(path.join(env.STATE_DIR,'STOP'),'utf8'),/execution evidence suspect/)
 assert.equal(JSON.parse(fs.readFileSync(path.join(env.STATE_DIR,'status.json'))).result,'suspect');assert.equal(agent.ledger.unreviewed().length,1)
 const pgid=fs.readFileSync(path.join(env.STATE_DIR,'suspect-pgid'),'utf8').trim()
 const members=()=>fs.readdirSync('/proc').filter(p=>/^\d+$/.test(p)).filter(p=>{try{const s=fs.readFileSync(`/proc/${p}/stat`,'utf8');return s.slice(s.lastIndexOf(')')+2).trim().split(/\s+/)[2]===pgid}catch{return false}})
 for(let i=0;i<100&&members().length;i++)await new Promise(r=>setTimeout(r,20));assert.equal(members().length,0,'suspect exit must clean real Chromium process group')
 const skipped=spawnSync('/usr/local/bin/rewards-run',['schedule'],{env:{...env,SKIP_RANDOM_SLEEP:'true',REWARDS_RUN_CMD:'exit 99'},encoding:'utf8',timeout:10000});assert.equal(skipped.status,0);assert.match(skipped.stdout,/paused/i)
 // Missing STOP alone must not bypass durable uncertainty; exercise actual adapter before its consumer.
 fs.renameSync(path.join(env.STATE_DIR,'STOP'),path.join(env.STATE_DIR,'stop-before-missing-marker-probe'))
 const refused=await fetch(`http://127.0.0.1:${server.address().port}/control`,{method:'POST',headers:{authorization:'Bearer '+env.CONTROL_API_TOKEN,'content-type':'application/json'},body:JSON.stringify({action:'run'})});assert.equal(refused.status,409)
 const probe=path.join(directory,'adapter-probe');for(const d of ['dist/util','config'])fs.mkdirSync(path.join(probe,d),{recursive:true});fs.symlinkSync(path.join(upstream,'dist/util/Load.js'),path.join(probe,'dist/util/Load.js'));fs.copyFileSync(path.join(directory,'config/config.json'),path.join(probe,'config/config.json'));fs.writeFileSync(path.join(probe,'dist/index.js'),"require('fs').writeFileSync(process.env.PROBE_STARTED,'unsafe')")
 const started=path.join(directory,'unsafe-consumer'),guard=spawnSync(process.execPath,[path.join(codeRoot,'account-launch.mjs')],{env:{...env,APP_DIR:probe,MRS_RUN_ID:'blocked-adapter-fixture',MRS_WRAPPER_PID:'0',PROBE_STARTED:started},encoding:'utf8',timeout:10000});assert.equal(guard.status,78);assert.equal(fs.existsSync(started),false)
 const ordinary=spawnSync('/usr/local/bin/rewards-ctl',['resume'],{env,encoding:'utf8',timeout:10000});assert.equal(ordinary.status,78)
 execFileSync('/usr/bin/flock',['-n',path.join(env.STATE_DIR,'run.lock'),'/usr/local/bin/rewards-ctl','resume','--reviewed'],{env});assert.equal(agent.ledger.unreviewed().length,0);assert.equal(fs.existsSync(path.join(env.STATE_DIR,'STOP')),false)
 agent.ledger.create('lost-wrapper-fixture','offline',1,0,[id]);agent.ledger.event('lost-wrapper-fixture',id,'account.started');agent.ledger.event('lost-wrapper-fixture',id,'task.step.started','pc_search')
 const recovered=await fetch(`http://127.0.0.1:${server.address().port}/tasks`,{headers:{authorization:'Bearer '+env.CONTROL_API_TOKEN}});assert.equal(recovered.status,200);assert.equal((await recovered.json()).find(r=>r.id==='lost-wrapper-fixture').state,'suspect');assert.ok(fs.existsSync(path.join(env.STATE_DIR,'STOP')))
 console.log('PASS: real non-root Chromium/CDP; pending challenge cannot be overridden by a valid old cookie; native session case-preserving edit/restart/backup; Web/Core authentication and Web restart; two-Core one-time recovery; compiled uncertain hook physically halts real wrapper/Chromium; scheduled retry and missing STOP cannot bypass durable review; manual acknowledgement and stale-wrapper reconciliation. NOT Microsoft online acceptance or online Rewards resume')
}finally{await agent.shutdown();server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>fixture.close(r));fs.rmSync(directory,{recursive:true,force:true})}
