import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { token,equal,httpError } from './security.mjs'
export class Interactive {
 constructor(env,journal){this.env=env;this.journal=journal;this.worker=null;this.pending=new Map();this.binding=null;this.serial=0}
 async start(accountId,owner){
  if(this.worker){if(this.binding?.accountId===accountId && equal(this.binding.owner,owner))return this.call(accountId,owner,'state');throw httpError(409,'已有登录交互占用原任务锁')}
  this.binding={accountId,owner};const child=spawn('/usr/bin/setsid',['/usr/bin/flock','-n','-F','-E','75',path.join(this.env.STATE_DIR || path.join(this.env.APP_DIR,'state'),'run.lock'),process.execPath,fileURLToPath(new URL('./login-worker.mjs',import.meta.url))],{env:{...this.env,INTERACTIVE_ACCOUNT_ID:accountId,REWARDS_AUTH_BROWSER:'1'},cwd:this.env.APP_DIR,stdio:['ignore','ignore','ignore','ipc'],shell:false});this.worker=child
  child.on('message',m=>{if(m.event){this.journal.add(m.event,{accountId,stage:'login',result:m.state});return}const p=this.pending.get(m.id);if(p){this.pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(httpError(m.status || 409,m.error)):p.resolve(m.result)}})
  const fail=()=>{try{if(child.pid)process.kill(-child.pid,'SIGKILL')}catch{};if(this.worker!==child)return;this.worker=null;this.binding=null;for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(httpError(409,'登录浏览器已关闭或任务锁占用'))}this.pending.clear()}
  child.once('exit',fail);child.once('error',fail)
  try{return await this.call(accountId,owner,'state')}catch(e){child.kill('SIGTERM');throw e}
 }
 async call(accountId,owner,action,input){if(!this.worker || this.binding?.accountId!==accountId || !equal(this.binding.owner,owner))throw httpError(403,'登录交互归属不匹配或已经结束');const id=++this.serial;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(httpError(504,'浏览器操作超时'))},20000);this.pending.set(id,{resolve,reject,timer});this.worker.send({id,action,input},e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(httpError(409,'浏览器连接中断'))}})})}
 async close(){if(!this.worker)return;const child=this.worker;await this.call(this.binding.accountId,this.binding.owner,'close').catch(()=>{});if(child.exitCode!==null)return;await new Promise(resolve=>{const timer=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL')}catch{}resolve()},5000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.kill('SIGTERM')})}
}
