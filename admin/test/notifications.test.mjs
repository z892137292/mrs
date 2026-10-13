import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { SMTPServer } from 'smtp-server'
import { Store } from '../src/store.mjs'
import { Notifications, validateConfig } from '../src/notifications.mjs'
const temp=()=>fs.mkdtempSync(path.join(os.tmpdir(),'mrs-notify-'))
test('Telegram uses real HTTP, deduplication, bounded recovery, priority, no credential output',async()=>{
    const d=temp(),store=new Store(d);let attempts=0,now=Date.now();const messages=[]
    const server=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;messages.push(JSON.parse(body));attempts++;res.writeHead(attempts<3?503:200,{'content-type':'application/json'});res.end(JSON.stringify({ok:attempts>=3}))}).listen(0,'127.0.0.1')
    await new Promise(r=>server.once('listening',r));const n=new Notifications(store,{telegramBase:`http://127.0.0.1:${server.address().port}`,publicUrl:'http://nas.local:8088',now:()=>now})
    store.set('notifications',validateConfig({telegram:{enabled:true,token:'123456:SECRET_abcdefghijklmnopqrstuv',chatId:'123'}}))
    n.enqueue({id:'low',kind:'task_finished',result:'ok'});n.enqueue({id:'risk',kind:'risk_paused',reason:'password=NEVER_EXPOSE',accounts:['alice@example.invalid']});n.enqueue({id:'risk',kind:'risk_paused'})
    assert.equal(n.list().length,2)
    await n.tick();now+=20000;await n.tick();now+=60000;await n.tick()
    assert.equal(n.list().find(x=>x.event==='risk').state,'sent');assert.ok(n.list().every(x=>x.attempts<=3))
    assert.match(messages[0].text,/risk_paused/);assert.ok(!messages[0].text.includes('NEVER_EXPOSE') && !messages[0].text.includes('alice@'))
    assert.ok(!JSON.stringify(n.list()).includes('SECRET_'))
    await new Promise(r=>server.close(r));store.close();fs.rmSync(d,{recursive:true})
})
test('SMTP performs an actual local SMTP delivery; failures end after 3 attempts and survive restart',async()=>{
    const d=temp();let store=new Store(d),now=Date.now(),received=''
    const server=new SMTPServer({authOptional:true,disabledCommands:['AUTH','STARTTLS'],onData(stream,_session,callback){stream.on('data',x=>{received+=x});stream.on('end',()=>callback())}})
    await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.server.address().port
    let n=new Notifications(store,{publicUrl:'http://nas.local:8088',smtpOptions:{requireTLS:false,ignoreTLS:true},now:()=>now})
    store.set('notifications',validateConfig({smtp:{enabled:true,host:'127.0.0.1',port,from:'from@example.invalid',to:'to@example.invalid',events:['test']}}))
    n.enqueue({id:'smtp-ok',kind:'test',result:'actual SMTP fixture'});await n.tick();assert.equal(n.list()[0].state,'sent');assert.match(received,/actual SMTP fixture/)
    await new Promise(r=>server.close(r));n.enqueue({id:'smtp-fail',kind:'test'});await n.tick();store.close()
    store=new Store(d);n=new Notifications(store,{smtpOptions:{requireTLS:false,ignoreTLS:true},now:()=>now});now+=20000;await n.tick();now+=60000;await n.tick();const last=n.list().find(x=>x.event==='smtp-fail');assert.equal(last.attempts,3);assert.equal(last.state,'failed');await n.tick();assert.equal(n.list().find(x=>x.event==='smtp-fail').attempts,3)
    store.close();fs.rmSync(d,{recursive:true})
})
test('pending notification queue is bounded and gives safety notifications priority',()=>{
    const d=temp(),s=new Store(d),n=new Notifications(s)
    s.set('notifications',validateConfig({telegram:{enabled:true,token:'123456:SECRET_abcdefghijklmnopqrstuv',chatId:'123'}}))
    for(let i=0;i<510;i++)n.enqueue({id:`low-${i}`,kind:'task_finished'})
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM deliveries WHERE state='pending'").get().n,500)
    n.enqueue({id:'critical',kind:'verification_required'})
    assert.equal(s.db.prepare("SELECT count(*) AS n FROM deliveries WHERE state='pending'").get().n,500)
    assert.equal(s.db.prepare("SELECT priority FROM deliveries WHERE event='critical'").get().priority,1)
    s.close();fs.rmSync(d,{recursive:true})
})
