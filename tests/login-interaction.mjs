// Real compiled upstream Browser, real Chromium/CDP/IPC and session DB; isolated local HTTP fixture.
// This is NOT Microsoft login acceptance.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { token } from '../admin/src/security.mjs'
import { pathToFileURL } from 'node:url'
const codeRoot=fs.existsSync('/opt/mrs-admin/src/agent.mjs')?'/opt/mrs-admin/src/':new URL('../admin/src/',import.meta.url).pathname
const {createAgent}=await import(pathToFileURL(path.join(codeRoot,'agent.mjs')))
const {createWeb}=await import(pathToFileURL(path.join(codeRoot,'server.mjs')))
const upstream=process.env.APP_DIR || process.env.UPSTREAM_TEST_DIR
assert.notEqual(process.getuid(),0,'Chromium integration must run as non-root')
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'mrs-interactive-')),owner=token()
let risk=false,identity='FIXTURE-ONE'
const fixture=http.createServer((req,res)=>{
 if(req.url==='/userinfo'){
  res.setHeader('content-type','application/json')
  if(!req.headers.cookie?.includes('fixture=verified')){res.statusCode=401;res.end('{}');return}
  res.end(JSON.stringify({dashboard:{userStatus:{isRewardsUser:true,ePuid:identity,availablePoints:123},userWarnings:risk?[{name:'Fraud_UserWarning_BotScore_UX'}]:[]}}));return
 }
 res.setHeader('content-type','text/html');res.end('<!doctype html><title>Offline manual login fixture</title><input id="value" style="position:absolute;left:10px;top:10px;width:250px;height:30px"><button style="position:absolute;left:10px;top:60px;width:220px;height:40px" onclick="document.cookie=\'fixture=verified; path=/; max-age=3600\';document.querySelector(\'p\').textContent=\'Fixture authenticated\'">Confirm manual action</button><p>Authenticator verification fixture: no real Microsoft account</p>')
})
await new Promise(r=>fixture.listen(0,'127.0.0.1',r))
for(const n of ['state','logs','sessions','config'])fs.mkdirSync(path.join(directory,n))
for(const n of ['dist','node_modules','package.json'])fs.symlinkSync(path.join(upstream,n),path.join(directory,n))
const config=JSON.parse(fs.readFileSync(path.join(upstream,'config.example.json')));config.sessionPath='./sessions';config.proxy.ignoreCertificateErrors=false;fs.writeFileSync(path.join(directory,'config/config.json'),JSON.stringify(config));fs.symlinkSync('config/config.json',path.join(directory,'config.json'))
const env={...process.env,APP_DIR:directory,STATE_DIR:path.join(directory,'state'),LOG_DIR:path.join(directory,'logs'),CONTROL_DATA_DIR:path.join(directory,'control'),CONTROL_API_TOKEN:token(),CRON_SCHEDULE:'0 0 1 1 *',TZ:'UTC',ACCOUNT_1_EMAIL:'fixture@example.invalid',ACCOUNT_1_PASSWORD:'SYNTHETIC_ONLY',MRS_OFFLINE_TEST:'true',MRS_LOGIN_FIXTURE_URL:`http://127.0.0.1:${fixture.address().port}/`}
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
 const native=require(path.join(upstream,'dist/util/SessionStore.js'));assert.ok(native.loadSession(path.join(restored,'sessions'),'fixture@example.invalid',true).storageState.cookies.some(c=>c.name==='fixture'&&c.value==='verified'));native.closeSessionStore()
 await agent.interactive.start(id,owner)
 result=await agent.interactive.call(id,owner,'verify',{});assert.equal(result.state,'verified') // actual cookie restored by original Browser factory
 await agent.interactive.close()
 identity='DIFFERENT-ACCOUNT';await agent.interactive.start(id,owner);await assert.rejects(()=>agent.interactive.call(id,owner,'verify',{identityConfirmed:true}),/身份/);await agent.interactive.close()
 identity='FIXTURE-ONE';risk=true;await agent.interactive.start(id,owner);await assert.rejects(()=>agent.interactive.call(id,owner,'verify',{}),/风险/);await assert.rejects(()=>agent.interactive.call(id,owner,'input',{type:'key',key:'Enter'}),error=>error.status===409);await agent.interactive.close()
 assert.ok(fs.existsSync(path.join(env.STATE_DIR,'STOP')))
 const serialized=JSON.stringify(agent.journal.list());assert.ok(!serialized.includes('HUMAN_INPUT') && !serialized.includes('SYNTHETIC_ONLY') && !serialized.includes('image'))
 assert.ok(agent.journal.list().some(e=>e.kind==='risk_paused'))
 assert.ok(agent.journal.list().some(e=>e.kind==='verification_required'))
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
  const sessions=await request('/sessions');assert.equal(sessions.status,200);assert.ok(!JSON.stringify(sessions.data).includes('storageHash'));assert.match(sessions.data[0].currentStatus,/重新/)
  assert.equal((await request('/login-interaction',{accountId:id,action:'close'})).status,200)
  assert.equal((await request('/logout',{})).status,200)
  assert.equal((await request('/tasks')).status,401)
 }finally{webServer.closeAllConnections();await new Promise(r=>webServer.close(r));await web.close()}
 console.log('PASS: real non-root upstream Chromium, compiled evidence hook, CDP input/screenshot, manual waiting, same flock, binding isolation, fresh HTTP/cookie verification, native session DB restart and private tar backup/restore, identity mismatch/risk refusal, Web/Core HTTP plus Web restart and cleanup; NOT Microsoft online acceptance')
}finally{await agent.shutdown();server.closeAllConnections();await new Promise(r=>server.close(r));await new Promise(r=>fixture.close(r));fs.rmSync(directory,{recursive:true,force:true})}
