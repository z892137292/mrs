// Runtime adapter: feed the EXISTING upstream ACCOUNT_N loader, no algorithm patch.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { Accounts, atomicPrivate } from './accounts.mjs'
import { accountId } from './security.mjs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
export function observeLogin(line,accounts,evidence){
    const clean=line.replace(/\x1b\[[0-9;]*m/g,'')
    const match=/^\[[^\]]+\] \[([^\]]+)\] \[(INFO|ERROR)\].*?\[LOGIN\] (.*)$/.exec(clean)
    if(!match)return
    const matching=accounts.filter(a=>a.email.split('@')[0]===match[1]);if(matching.length!==1)return
    const text=match[3],id=matching[0].id || accountId(matching[0].email)
    let status=null
    if(text==='Successfully logged in')status='login_success'
    else if(match[2]==='ERROR' && /ACCOUNT_LOCKED|Account locked|account.*(?:restricted|suspended)/i.test(text))status='restricted'
    else if(match[2]==='ERROR' && /verification|manual review|LOGIN_PASSWORDLESS|TWO_FACTOR|RECOVERY|CONSENT|AUTHENTICATOR/i.test(text))status='manual_verification'
    else if(match[2]==='ERROR' && /^Fatal error:/.test(text))status='login_failed'
    if(status)evidence[id]={status,time:new Date().toISOString(),source:'本次上游 LOGIN 日志；程序识别状态，不代表当前会话仍有效'}
}
if(process.argv[1]===fileURLToPath(import.meta.url))try{
    const runtime=new Accounts().runtime(),dir=process.env.APP_DIR || '/usr/src/microsoft-rewards-script',state=process.env.STATE_DIR || path.join(dir,'state')
    // These images do not mount an app-root .env; refuse ambiguous precedence rather than revive deleted accounts.
    if(runtime.revision && ['.env','dist/.env','src/.env'].some(n=>fs.existsSync(path.join(dir,n))))throw Error('Legacy .env conflicts with managed accounts')
    // Execute the pinned upstream validator/loader before recording "loaded".
    // The bot will consume exactly this immutable environment on this attempt.
    const original=process.env
    try{process.env=runtime.env;const {loadAccounts}=createRequire(import.meta.url)(path.join(dir,'dist/util/Load.js'));const loaded=loadAccounts();if(!loaded.length)throw Error('No loaded accounts')}finally{process.env=original}
    const applied={revision:runtime.revision,startedAt:new Date().toISOString(),accounts:runtime.accounts.map(a=>({id:a.id,modifiedAt:a.modifiedAt})),login:{}}
    atomicPrivate(path.join(state,'account-applied.json'),applied)
    const child=spawn(process.execPath,[path.join(dir,'dist/index.js')],{env:runtime.env,stdio:['ignore','pipe','pipe'],shell:false})
    for(const [stream,out]of [[child.stdout,process.stdout],[child.stderr,process.stderr]]){
        let pending='';stream.on('data',chunk=>{if(!out.write(chunk)){stream.pause();out.once('drain',()=>stream.resume())}pending+=chunk.toString();let i;while((i=pending.indexOf('\n'))>=0){observeLogin(pending.slice(0,i),runtime.accounts,applied.login);pending=pending.slice(i+1)}if(pending.length>8192)pending=''})
    }
    child.on('error',()=>{process.exitCode=1})
    child.on('close',(code)=>{try{atomicPrivate(path.join(state,'account-applied.json'),applied)}catch{console.error('Account evidence could not be saved')}process.exitCode=code ?? 1})
}catch{console.error('Managed account configuration invalid/unavailable; task not started');process.exitCode=1}
