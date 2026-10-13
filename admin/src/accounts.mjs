// Private Rewards-side account store. Web never mounts this directory.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { accountId, maskEmail, httpError } from './security.mjs'
const fields={email:'EMAIL',password:'PASSWORD',totpSecret:'TOTP_SECRET',recoveryEmail:'RECOVERY_EMAIL',geoLocale:'GEO_LOCALE',langCode:'LANG_CODE',proxyUrl:'PROXY_URL',proxyPort:'PROXY_PORT',proxyUsername:'PROXY_USERNAME',proxyPassword:'PROXY_PASSWORD',proxyHttp:'PROXY_HTTP',saveFingerprintMobile:'SAVE_FINGERPRINT_MOBILE',saveFingerprintDesktop:'SAVE_FINGERPRINT_DESKTOP'}
const secrets=new Set(['password','totpSecret','proxyUsername','proxyPassword','recoveryEmail'])
function publicProxy(value){if(!value)return '';try{const u=new URL(value.includes('://')?value:'http://'+value);u.username='';u.password='';u.search='';u.hash='';return u.origin==='null'?`${u.protocol}//${u.host}`:u.origin}catch{return '[代理地址需重新配置]'}}
const emailValid=v=>typeof v==='string' && v.length<=254 && /^[^\s@,\[\]]+@[^\s@,\[\]]+\.[^\s@,\[\]]+$/.test(v)
export function privateRead(file){
    const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW)
    try{const s=fs.fstatSync(fd);if(!s.isFile() || s.size>1048576)throw Error('Invalid private file');return JSON.parse(fs.readFileSync(fd,'utf8'))}finally{fs.closeSync(fd)}
}
export function atomicPrivate(file,value){
    const directory=path.dirname(file);fs.mkdirSync(directory,{recursive:true,mode:0o700})
    if(fs.lstatSync(directory).isSymbolicLink())throw Error('Unsafe directory')
    fs.chmodSync(directory,0o700)
    const temp=file+'.'+crypto.randomBytes(8).toString('hex')+'.tmp'
    let fd
    try{fd=fs.openSync(temp,'wx',0o600);fs.writeFileSync(fd,JSON.stringify(value));fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;fs.renameSync(temp,file);const d=fs.openSync(directory,'r');try{fs.fsyncSync(d)}finally{fs.closeSync(d)}}finally{if(fd!==undefined)fs.closeSync(fd);if(fs.existsSync(temp))fs.unlinkSync(temp)}
}
function validate(a){
    if(!emailValid(a.email))throw httpError(400,'邮箱格式无效')
    for(const key of Object.keys(fields))if(!['proxyPort','proxyHttp','saveFingerprintMobile','saveFingerprintDesktop'].includes(key) && (typeof a[key]!=='string' || a[key].length>512 || /[\r\n\0]/.test(a[key])))throw httpError(400,'账号字段格式无效')
    if(typeof a.enabled!=='boolean' || ![a.proxyHttp,a.saveFingerprintMobile,a.saveFingerprintDesktop].every(x=>typeof x==='boolean'))throw httpError(400,'开关格式无效')
    if(a.totpSecret && !/^[A-Z2-7]+=*$/i.test(a.totpSecret))throw httpError(400,'TOTP格式无效')
    if(a.recoveryEmail && !emailValid(a.recoveryEmail))throw httpError(400,'恢复邮箱格式无效')
    try{new Intl.Locale(a.langCode)}catch{throw httpError(400,'语言代码无效')}
    if(a.geoLocale!=='auto' && !/^[A-Z]{2}$/.test(a.geoLocale))throw httpError(400,'地区代码无效')
    if(!Number.isInteger(a.proxyPort) || a.proxyPort<0 || a.proxyPort>65535)throw httpError(400,'代理端口无效')
    if(a.proxyUrl){let u;try{u=new URL(a.proxyUrl.includes('://')?a.proxyUrl:'http://'+a.proxyUrl)}catch{throw httpError(400,'代理地址无效')}
        if(!['http:','https:','socks4:','socks5:'].includes(u.protocol) || !u.hostname || u.username || u.password || u.search || u.hash || !['','/'].includes(u.pathname) || a.proxyPort<1)throw httpError(400,'代理地址/端口无效；凭证须单独填写')
        if(!!a.proxyUsername!==!!a.proxyPassword || (u.protocol.startsWith('socks') && a.proxyUsername))throw httpError(400,'代理凭证必须成对且SOCKS不支持认证')
    }else if(a.proxyPort || a.proxyHttp || a.proxyUsername || a.proxyPassword)throw httpError(400,'请配置代理地址')
    return a
}
export class Accounts {
    constructor(env=process.env){this.env=env;this.file=path.join(env.CONTROL_DATA_DIR || path.join(env.APP_DIR || '/usr/src/microsoft-rewards-script','control-data'),'accounts.json')}
    legacy(){return Object.keys(this.env).filter(k=>/^ACCOUNT_[1-9]\d*_EMAIL$/.test(k)).sort((a,b)=>Number(a.split('_')[1])-Number(b.split('_')[1])).map(k=>{
        const prefix=k.slice(0,-5),a={id:accountId(this.env[k]),enabled:true,modifiedAt:null}
        for(const [field,suffix]of Object.entries(fields)){const v=this.env[prefix+suffix];a[field]=['proxyHttp','saveFingerprintMobile','saveFingerprintDesktop'].includes(field)?/^(true|1|yes|on)$/i.test(v||''):field==='proxyPort'?Number(v||0):v || (field==='geoLocale'?'auto':field==='langCode'?'en':'')}
        return a
    })}
    read(){let exists=true;try{fs.lstatSync(this.file)}catch(e){if(e.code==='ENOENT')exists=false;else throw e}if(!exists)return {revision:0,accounts:this.legacy()};const d=privateRead(this.file);if(!Number.isSafeInteger(d.revision)||!Array.isArray(d.accounts)||d.accounts.length>100)throw Error('Invalid account store');for(const a of d.accounts)validate(a);return d}
    public(){const d=this.read();return {revision:d.revision,source:d.revision?'受保护持久化配置':'容器启动环境变量',accounts:d.accounts.map(a=>({id:a.id,label:maskEmail(a.email),enabled:a.enabled,modifiedAt:a.modifiedAt,geoLocale:a.geoLocale,langCode:a.langCode,proxyUrl:publicProxy(a.proxyUrl),proxyPort:a.proxyPort,proxyHttp:a.proxyHttp,saveFingerprintMobile:a.saveFingerprintMobile,saveFingerprintDesktop:a.saveFingerprintDesktop,...Object.fromEntries([...secrets].map(k=>[k+'Configured',!!a[k]]))}))}}
    update(input){
        const d=this.read();if(input.revision!==d.revision)throw httpError(409,'配置版本已变化，请刷新重试')
        const at=d.accounts.findIndex(a=>a.id===input.id)
        if(input.action==='delete'){if(at<0)throw httpError(404,'账号不存在');d.accounts.splice(at,1)}
        else if(input.action==='save'){
            if(input.id && at<0)throw httpError(404,'账号不存在')
            const old=at<0?{id:crypto.randomUUID(),email:'',password:'',totpSecret:'',recoveryEmail:'',geoLocale:'auto',langCode:'en',proxyUrl:'',proxyPort:0,proxyUsername:'',proxyPassword:'',proxyHttp:false,saveFingerprintMobile:false,saveFingerprintDesktop:false,enabled:true}:d.accounts[at]
            const v=input.values;if(!v || typeof v!=='object' || Array.isArray(v) || Object.keys(v).some(k=>!Object.hasOwn(fields,k) && k!=='enabled' && k!=='clearSecrets'))throw httpError(400,'账号字段不允许')
            const a={...old}
            for(const key of [...Object.keys(fields),'enabled'])if(Object.hasOwn(v,key) && !(secrets.has(key) && v[key]===''))a[key]=v[key]
            if(v.clearSecrets!==undefined && (!Array.isArray(v.clearSecrets) || v.clearSecrets.some(k=>!secrets.has(k))))throw httpError(400,'清除凭证参数无效')
            for(const k of v.clearSecrets || [])a[k]=''
            const requestedEmail=a.email.trim()
            a.email=at>=0&&requestedEmail.toLowerCase()===old.email.trim().toLowerCase()?old.email:requestedEmail.toLowerCase()
            a.geoLocale=a.geoLocale.toLowerCase()==='auto'?'auto':a.geoLocale.toUpperCase();validate(a)
            if(d.accounts.some(x=>x.id!==a.id && x.email.toLowerCase()===a.email))throw httpError(409,'邮箱已存在')
            a.modifiedAt=new Date().toISOString();if(at<0)d.accounts.push(a);else d.accounts[at]=a
        }else throw httpError(400,'账号操作不允许')
        if(d.accounts.length>100)throw httpError(400,'账号数量超限')
        for(const a of d.accounts)validate(a)
        const validator=path.join(this.env.APP_DIR || '/usr/src/microsoft-rewards-script','dist/util/Validator.js')
        if(fs.existsSync(validator)){
            try{createRequire(import.meta.url)(validator).validateAccounts(d.accounts.map(a=>({email:a.email,password:a.password,totpSecret:a.totpSecret,recoveryEmail:a.recoveryEmail,geoLocale:a.geoLocale,langCode:a.langCode,proxy:{proxyHttp:a.proxyHttp,url:a.proxyUrl,port:a.proxyPort,username:a.proxyUsername,password:a.proxyPassword},saveFingerprint:{mobile:a.saveFingerprintMobile,desktop:a.saveFingerprintDesktop}})))}catch{throw httpError(400,'上游账号参数校验失败；原配置未更改')}
        }
        d.revision++;atomicPrivate(this.file,d);return this.public()
    }
    runtime(){const d=this.read();if(!d.revision)return {env:{...this.env},revision:0,accounts:d.accounts};const env={...this.env};for(const k of Object.keys(env))if(/^ACCOUNT_[1-9]\d*_/.test(k))delete env[k]
        const active=d.accounts.filter(a=>a.enabled);if(!active.length)throw httpError(409,'没有启用账号，任务拒绝启动')
        active.forEach((a,i)=>{for(const [field,suffix]of Object.entries(fields))env[`ACCOUNT_${i+1}_${suffix}`]=String(a[field])})
        // Prevent a legacy .env inside the image/data root from reintroducing deleted slots.
        return {env,revision:d.revision,accounts:active}
    }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
    try{const input=JSON.parse(fs.readFileSync(0,'utf8'));const result=new Accounts().update(input);process.stdout.write(JSON.stringify(result))}catch(e){process.stdout.write(JSON.stringify({error:e.status?e.message:'账号配置保存失败，原配置未更改',status:e.status || 500}));process.exitCode=1}
}
