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
const emit=(event)=>{if(event==='session.verified')emitted.delete('session.auth.reyó}í¢G§²ÚîÆ­yÔ°ÍÕÍÁ•Ðœ¤(€…ÍÍ•ÉÐ¹•ÅÕ…°¡°¹•Ð ÉÕ¸µÑÝ¼œ¤¹•Ù¥‘•¹”¹™¥¹¡àôùà¹ÍÑ…”ôôôµ½‰¥±•}Í•…É œ¤¹½‰Í•ÉÙ•°äÀ¤(€…ÍÍ•ÉÐ¹•ÅÕ…°¡°¹•Ð ÉÕ¸µÑÝ¼œ¤¹•Ù¥‘•¹”¹™¥¹¡àôùà¹ÍÑ…”ôôôµ½‰¥±•}Í•…É œ¤¹É•µ…¥¹¥¹œ°À¤(€°¹±½Í” ¤í°õ¹•Ü1•‘•È¡‘¥È¤í…ÍÍ•ÉÐ¹•ÅÕ…°¡°¹•Ð ÉÕ¸µ½¹”œ¤¹•Ù¥‘•¹”¹™¥¹¡àôùà¹ÍÑ…”ôôôÁ}Í•…É œ¤¹ÍÑ…Ñ”°ÍÕÍÁ•Ðœ¤(€½¹ÍÐ„õÍ¥¹…ÑÕÉ”¡í=9QI=1}A%}Q=-8èÁÉ¥Ù…Ñ”œ±5IM}YIM%=8èÉŒô±míÁ…ÍÍÝ½Éè=9õt±íô¤±ˆõÍ¥¹…ÑÕÉ”¡í=9QI=1}A%}Q=-8èÁÉ¥Ù…Ñ”œ±5IM}YIM%=8èÉŒô±míÁ…ÍÍÝ½ÉèQ]<õt±íô¤í…ÍÍ•ÉÐ¹¹½ÑÅÕ…°¡„±ˆ¤í…ÍÍ•ÉÐ¹½¬ …„¹¥¹±Õ‘•Ì =9œ¤¤(€…ÍÍ•ÉÐ¹•ÅÕ…°¡°¹ÁÉ•Á…É” ¹•Üµ…™Ñ•ÈµÕ¹•ÉÑ…¥¸œ¤±™…±Í”¤(€°¹…­¹½Ý±•‘” ¤í…ÍÍ•ÉÐ¹•ÅÕ…°¡°¹ÁÉ•Á…É” ¹•Üµ…™Ñ•Èµ¡Õµ…¸µÉ•Ù¥•Üœ¤±ÑÉÕ”¤í…ÍÍ•ÉÐ¹½¬¡°¹ÁÕ‰±¥Œ ÉÕ¸µ½¹”œ¤¹É•Ù¥•Ý•‘Ð¤(€°¹É•…Ñ” ¥¹Ñ•ÉÉÕÁÑ•µÉ•ÑÉäœ°Í¥¹…ÑÕÉ”œ°Ì°ÄÀÐ±l………………………………………„t¤í°¹•Ù•¹Ð ¥¹Ñ•ÉÉÕÁÑ•µÉ•ÑÉäœ°………………………………………„œ°Ñ…Í¬¹ÍÑ•À¹ÍÑ…ÉÑ•œ°Á}Í•…É œ¤í…ÍÍ•ÉÐ¹•ÅÕ…°¡°¹ÁÉ•Á…É” ¥¹Ñ•ÉÉÕÁÑ•µÉ•ÑÉäœ¤±™…±Í”¤(€…ÍÍ•ÉÐ¹•ÅÕ…°¡°¹ÁÉ•Á…É” ¹•áÐµ…™Ñ•ÈµÉ…Í œ¤±™…±Í”¤í°¹…­¹½Ý±•‘” ¤í…ÍÍ•ÉÐ¹•ÅÕ…°¡°¹ÁÉ•Á…É” ¹•áÐµ…™Ñ•ÈµÉ•Ù¥•Üœ¤±ÑÉÕ”¤(€°¹‘ˆ¹ÁÉ•Á…É” UAQÉÕ¹ÌMPÕÁ‘…Ñ•ôü]!I¥ôüœ¤¹ÉÕ¸ ¹•ÜµÍ¹…ÁÍ¡½Ðœ°ÉÕ¸µ½¹”œ¤í…ÍÍ•ÉÐ¹½¬¡°¹Õ¹É•Ù¥•Ý• ¤¹Í½µ”¡ÈôùÈ¹¥ôôôÉÕ¸µ½¹”œ¤¤(õ™¥¹…±±åí°¹±½Í” ¤í™Ì¹ÉµMå¹Œ¡‘¥È±íÉ•ÕÉÍ¥Ù”éÑÉÕ”±™½É”éÑÉÕ•ô¥ô)ô¤(