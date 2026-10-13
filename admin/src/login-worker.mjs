// This process holds the SAME flock as rewards-run. No TCP CDP port is opened.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { Accounts,atomicPrivate,privateRead } from './accounts.mjs'
import { httpError } from './security.mjs'
const env=process.env,dir=env.APP_DIR,require=createRequire(path.join(dir,'package.json'))
let context,page,cdp,closed=false,busy=false,last=Date.now(),state='starting'
const created=Date.now()
const stateFile=path.join(env.CONTROL_DATA_DIR || path.join(dir,'control-data'),'verified-sessions.json')
const allowed=new Set(['rewards.bing.com','www.bing.com','login.live.com','login.microsoftonline.com','account.live.com','account.microsoft.com'])
const fixtures=env.MRS_LOGIN_FIXTURE_URL && env.MRS_OFFLINE_TEST==='true'
const permitted=url=>{try{const u=new URL(url);return fixtures?u.origin===new URL(env.MRS_LOGIN_FIXTURE_URL).origin:u.protocol==='https:'&&allowed.has(u.hostname)}catch{return false}}
const emitted=new Set()
const emit=(event)=>{if(event!=='session.screenshot.ready'){if(emitted.has(event))return;emitted.add(event)}process.send?.({event,state})}
function pause(reason){const stop=path.join(env.STATE_DIR || path.join(dir,'state'),'STOP');try{fs.writeFileSync(stop,reason,{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}}
async function close(){if(closed)return;closed=true;clearInterval(timer);const browser=context?.browser();await context?.close().catch(()=>{});await browser?.close().catch(()=>{});sessionStore?.closeSessionStore();process.exit(0)}
let sessionStore,account,config,revision
const timer=setInterval(()=>{if(Date.now()-last>10*60000 || Date.now()-created>30*60000)close()},10000);timer.unref()
process.once('disconnect',close);process.once('SIGTERM',close);process.once('SIGINT',close)
async function inspect(){
 if(state==='restricted')throw httpError(409,'微软风险/限制已停止，禁止继续交互')
 if(page.isClosed())throw httpError(409,'浏览器页面已关闭')
 if(page.url()==='about:blank')throw httpError(409,'官方新窗口正在加载，请稍后刷新')
 if(!permitted(page.url())){state='blocked_navigation';await close();throw httpError(409,'非授权登录导航已关闭')}
 const text=await page.locator('body').innerText({timeout:3000}).catch(()=>'')
 if(/Fraud_UserWarning_BotScore_UX|ACCOUNT_LOCKED|account (?:has been |is )?(?:locked|suspended|restricted)|帐户已锁定|账户已锁定|账号受限/i.test(text)){state='restricted';pause('Microsoft restriction - manual review required');emit('session.restricted');throw httpError(409,'微软风险/限制已停止；需要人工核查')}
 if(/captcha|verify your identity|Authenticator|验证码|验证你的身份/i.test(text)){state='waiting_manual';emit('session.auth.required')}
 else state='interactive'
}
async function verify(input){
 await inspect();const endpoint=fixtures?new URL('/userinfo',env.MRS_LOGIN_FIXTURE_URL).href:'https://rewards.bing.com/api/getuserinfo'
 const response=await context.request.get(endpoint,{maxRedirects:0,timeout:15000});if(response.status()!==200){state='unverified';throw httpError(409,'会话尚未通过服务端核验；请继续人工登录')}
 const data=await response.json(),user=data?.dashboard?.userStatus
 if(/Fraud_UserWarning_BotScore_UX|ACCOUNT_LOCKED/i.test(JSON.stringify(data))){pause('Microsoft risk - manual review required');state='restricted';emit('session.restricted');throw httpError(409,'服务端返回风险限制，未保存为有效会话')}
 if(!user?.isRewardsUser || typeof user.ePuid!=='string' || !user.ePuid || !Number.isFinite(user.availablePoints)){state='unverified';throw httpError(409,'没有可信Rewards会话证据')}
 let records={};try{records=privateRead(stateFile)}catch(e){if(e.code!=='ENOENT')throw e}
 const identity=crypto.createHmac('sha256',env.CONTROL_API_TOKEN).update(user.ePuid).digest('hex'),key=`${account.id}:${env.INTERACTIVE_PLATFORM || 'mobile'}`
 if(records[key]?.identity && records[key].identity!==identity)throw httpError(409,'服务端账号身份与先前绑定不符，禁止覆盖')
 if(!records[key]?.identity && input?.identityConfirmed!==true)throw httpError(409,'官方接口未提供邮箱，请核对真实页面账号并明确人工确认身份绑定')
 const storage=await context.storageState();sessionStore.saveStorageState(config.sessionPath,account.email,env.INTERACTIVE_PLATFORM!=='desktop',storage)
 records[key]={identity,storageHash:crypto.createHmac('sha256',env.CONTROL_API_TOKEN).update(JSON.stringify(storage)).digest('hex'),revision,verifiedAt:new Date().toISOString(),availablePoints:user.availablePoints,source:fixtures?'隔离本地fixture响应；不是微软账号验收':'同一Core浏览器cookie的官方getuserinfo实时响应；首次邮箱归属由人工确认'};atomicPrivate(stateFile,records)
 state='verified';emit('session.verified');return {state,verifiedAt:records[key].verifiedAt,availablePoints:user.availablePoints,source:records[key].source}
}
async function initialize(){
 const managed=new Accounts(env),runtime=managed.runtime();account=runtime.accounts.find(a=>a.id===env.INTERACTIVE_ACCOUNT_ID);if(!account?.enabled)throw Error('Unknown/disabled account');revision=runtime.revision
 pause('manual login session - verification requires manual review; no automatic task resume')
 const load=require(path.join(dir,'dist/util/Load.js')),original=process.env;let loaded
 try{process.env=runtime.env;loaded=load.loadAccounts().find(a=>a.email.trim().toLowerCase()===account.email.trim().toLowerCase());config=load.loadConfig()}finally{process.env=original}
 if(!loaded)throw Error('Account not loaded');account.email=loaded.email;config.headless=true;config.proxy.ignoreCertificateErrors=false
 sessionStore=require(path.join(dir,'dist/util/SessionStore.js'))
 const Browser=require(path.join(dir,'dist/browser/Browser.js')).default,Util=require(path.join(dir,'dist/util/Utils.js')).default,{resolveAccountLocale}=require(path.join(dir,'dist/util/Locale.js'))
 const logger={info(){},warn(){},error(){},debug(){}}
 const bot={config,isMobile:env.INTERACTIVE_PLATFORM!=='desktop',logger,utils:new Util(),accountLocale:resolveAccountLocale(loaded)}
 const session=await new Browser(bot).createBrowser(loaded);context=session.context;page=await context.newPage();await page.setViewportSize({width:1000,height:760})
 context.on('page',p=>{page=p;cdp=null})
 await page.goto(fixtures?env.MRS_LOGIN_FIXTURE_URL:'https://rewards.bing.com/auth/login',{waitUntil:'domcontentloaded',timeout:20000});state='interactive';emit('session.login.started')
}
const ready=initialize()
process.on('message',async m=>{
 if(busy){process.send?.({id:m.id,error:'浏览器操作正在执行',status:409});return}busy=true;last=Date.now()
 try{await ready;let result
  if(m.action==='close'){process.send?.({id:m.id,result:{closed:true}});await close();return}
  if(m.action==='verify')result=await verify(m.input)
  else if(m.action==='state')result={state,accountId:account.id,width:1000,height:760}
  else{if(state==='restricted' || state==='verified')throw httpError(409,'当前阶段不允许截图或输入');await inspect();cdp ||= await context.newCDPSession(page)
   if(m.action==='input'){
    const i=m.input || {}
    if(i.type==='click' && Number.isFinite(i.x)&&Number.isFinite(i.y)&&i.x>=0&&i.x<=1000&&i.y>=0&&i.y<=760){for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,x:i.x,y:i.y,button:'left',clickCount:1})}
    else if(i.type==='type' && typeof i.text==='string' && i.text.length<=2048)await cdp.send('Input.insertText',{text:i.text})
    else if(i.type==='key' && ['Enter','Tab','Backspace','Escape','ArrowDown','ArrowUp'].includes(i.key))await page.keyboard.press(i.key)
    else if(i.type==='scroll' && Number.isFinite(i.deltaY)&&Math.abs(i.deltaY)<=800)await cdp.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:500,y:380,deltaX:0,deltaY:i.deltaY})
    else throw httpError(400,'输入类型或坐标无效')
    emit('session.screenshot.ready');result={accepted:true}
   }else if(m.action==='frame'){const frame=await cdp.send('Page.captureScreenshot',{format:'jpeg',quality:65,captureBeyondViewport:false});result={state,width:1000,height:760,image:frame.data}}
   else throw httpError(400,'登录操作不允许')
  }
  process.send?.({id:m.id,result})
 }catch(e){process.send?.({id:m.id,error:e.status?e.message:'浏览器或会话核验失败，未标记登录成功',status:e.status || 409})}finally{busy=false}
})
ready.catch(()=>{state='failed';emit('session.login.failed');setTimeout(close,1000)})
