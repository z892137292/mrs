import nodemailer from 'nodemailer'
import { redact, httpError, token } from './security.mjs'
export const eventKinds = ['task_started','task_finished','task_failed','circuit_open','risk_paused','verification_required','account_paused','configuration_applied','container_started','service_unavailable','service_recovered','test']
const important = new Set(['risk_paused','verification_required','account_paused','circuit_open','service_unavailable'])
const defaults = { telegram:{enabled:false,chatId:'',token:'',events:eventKinds}, smtp:{enabled:false,host:'',port:587,secure:false,username:'',password:'',from:'',to:'',events:eventKinds} }
export function configPublic(config) {
    return { telegram:{...config.telegram,token:undefined,tokenConfigured:!!config.telegram.token}, smtp:{...config.smtp,password:undefined,passwordConfigured:!!config.smtp.password} }
}
export function validateConfig(input, previous = defaults) {
    const result = structuredClone(defaults)
    for (const channel of ['telegram','smtp']) {
        const v=input[channel] || {}, old=previous[channel] || defaults[channel]
        for (const key of Object.keys(defaults[channel])) result[channel][key]=Object.hasOwn(v,key) ? v[key] : old[key]
        const c=result[channel]
        const secret=channel==='telegram'?'token':'password'
        if (!v[secret]) c[secret]=old[secret] || '' // blank retains, no secret ever returned
        if (typeof c.enabled!=='boolean' || !Array.isArray(c.events) || c.events.some(x=>!eventKinds.includes(x))) throw httpError(400,'通知开关或事件无效')
        for (const [k,x] of Object.entries(c)) if (!['enabled','events','secure','port'].includes(k) && (typeof x!=='string' || x.length>512 || /[\r\n]/.test(x))) throw httpError(400,'通知字段无效')
        if (channel==='telegram' && c.enabled && (!/^\d+:[\w-]{20,}$/.test(c.token) || !/^-?\d+$/.test(c.chatId))) throw httpError(400,'Telegram Token 或 Chat ID 无效')
        if (channel==='smtp' && (typeof c.secure!=='boolean' || !Number.isInteger(c.port) || c.port<1 || c.port>65535)) throw httpError(400,'SMTP 端口无效')
        if (channel==='smtp' && c.enabled && (!/^[\w.-]+$/.test(c.host) || !/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(c.from) || !/^[^<>\s@]+@[^<>\s@]+\.[^<>\s@]+$/.test(c.to))) throw httpError(400,'SMTP 主机或邮箱无效')
    }
    return result
}
export class Notifications {
    constructor(store, {publicUrl, telegramBase='https://api.telegram.org', smtpOptions={}, now=Date.now}={}) {
        this.store=store;this.publicUrl=publicUrl;this.telegramBase=telegramBase;this.smtpOptions=smtpOptions;this.now=now;this.running=false
        if (!store.get('notifications')) store.set('notifications',structuredClone(defaults))
    }
    enqueue(event) {
        const config=this.store.get('notifications')
        const e={id:String(event.id || token()),kind:event.kind,time:event.time || new Date().toISOString(),result:redact(event.result),reason:redact(event.reason),accounts:(event.accounts || []).slice(0,100).map(redact)}
        this.store.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(e.id,e.time,e.kind,JSON.stringify(e))
        this.store.db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY time DESC LIMIT 2000)')
        this.store.db.exec("DELETE FROM deliveries WHERE state IN ('sent','failed','dropped') AND id NOT IN (SELECT id FROM deliveries ORDER BY id DESC LIMIT 2000)")
        for (const channel of ['telegram','smtp']) {
            const c=config[channel]
            if (!c.enabled || (e.kind!=='test' && !c.events.includes(e.kind))) continue
            if (Number(this.store.db.prepare("SELECT count(*) AS n FROM deliveries WHERE state='pending'").get().n)>=500) {
                if (!important.has(e.kind)) continue
                this.store.db.exec("UPDATE deliveries SET state='dropped',error='高优先级通知挤占队列' WHERE id=(SELECT id FROM deliveries WHERE state='pending' AND priority=0 ORDER BY id LIMIT 1)")
                if (Number(this.store.db.prepare("SELECT count(*) AS n FROM deliveries WHERE state='pending'").get().n)>=500) continue
            }
            this.store.db.prepare('INSERT OR IGNORE INTO deliveries(event,channel,v,priority,due) VALUES(?,?,?,?,?)').run(e.id,channel,JSON.stringify(e),important.has(e.kind)?1:0,this.now())
        }
        return e.id
    }
    list() { return this.store.db.prepare('SELECT id,event,channel,attempts,state,error FROM deliveries ORDER BY id DESC LIMIT 100').all() }
    async send(channel,event) {
        const c=this.store.get('notifications')[channel]
        if (!c.enabled) throw new Error('CHANNEL_DISABLED')
        const text=`Microsoft Rewards：${event.kind}\n时间：${event.time}\n账号：${event.accounts.join('、') || '未确定/系统'}\n结果：${event.result || '无摘要'}\n原因：${event.reason || '无额外原因'}\n管理：${this.publicUrl || '未配置'}`.slice(0,3500)
        if (channel==='telegram') {
            const response=await fetch(`${this.telegramBase}/bot${c.token}/sendMessage`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({chat_id:c.chatId,text,disable_web_page_preview:true}),signal:AbortSignal.timeout(10000),redirect:'error'})
            if (!response.ok || !(await response.json()).ok) throw new Error('TELEGRAM_REJECTED')
        } else {
            const transport=nodemailer.createTransport({host:c.host,port:c.port,secure:c.secure,requireTLS:!c.secure,auth:c.username?{user:c.username,pass:c.password}:undefined,connectionTimeout:10000,greetingTimeout:10000,socketTimeout:10000,disableFileAccess:true,disableUrlAccess:true,...this.smtpOptions})
            try { await transport.sendMail({from:c.from,to:c.to,subject:`Microsoft Rewards ${event.kind}`,text,disableFileAccess:true,disableUrlAccess:true}) } finally { transport.close() }
        }
    }
    async tick() {
        if(this.running)return
        this.running=true
        try {
            const rows=this.store.db.prepare("SELECT * FROM deliveries WHERE state='pending' AND due<=? ORDER BY priority DESC,id LIMIT 5").all(this.now())
            for(const r of rows) {
                this.store.db.prepare("UPDATE deliveries SET state='sending',attempts=attempts+1 WHERE id=?").run(r.id)
                try { await this.send(r.channel,JSON.parse(r.v)); this.store.db.prepare("UPDATE deliveries SET state='sent',error=NULL WHERE id=?").run(r.id) }
                catch(e) {
                    // Never persist raw provider messages/URLs/authentication material.
                    const error=e.message==='CHANNEL_DISABLED'?'渠道已禁用':'发送失败（网络、TLS、认证或服务拒绝）'
                    const attempts=r.attempts+1
                    this.store.db.prepare('UPDATE deliveries SET state=?,due=?,error=? WHERE id=?').run(attempts>=3 || e.message==='CHANNEL_DISABLED'?'failed':'pending',this.now()+[15000,60000,0][attempts-1],error,r.id)
                }
            }
        } finally { this.running=false }
    }
}
