import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Journal } from '../src/journal.mjs'
import { Store } from '../src/store.mjs'
import { LiveEventHub } from '../src/live-events.mjs'
import { createAgent } from '../src/agent.mjs'
import { token } from '../src/security.mjs'

async function eventually(fn){
  for(let attempt=0;attempt<80;attempt++){
    const value=await fn()
    if(value)return value
    await new Promise(r=>setTimeout(r,100))
  }
  throw Error('No event delivered within 8 seconds')
}
test('core SSE is authenticated, uses real journal evidence and supports Last-Event-ID replay',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mrs-live-core-'))
  const env={...process.env,CONTROL_API_TOKEN:token(),APP_DIR:root,
    CONTROL_DATA_DIR:path.join(root,'control'),STATE_DIR:path.join(root,'state'),
    LOG_DIR:path.join(root,'logs'),CRON_SCHEDULE:'0 9 * * *',TZ:'Asia/Shanghai'}
  fs.mkdirSync(env.STATE_DIR,{recursive:true});fs.mkdirSync(env.LOG_DIR,{recursive:true})
  const agent=createAgent(env),server=agent.app.listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const url='http://127.0.0.1:'+server.address().port+'/events/stream'
  const ctrl=new AbortController()
  try {
    const denial=await fetch(url,{signal:AbortSignal.timeout(2000)})
    assert.equal(denial.status,401)
    const first=agent.journal.list(0).at(-1)?.id||0
    assert.ok(agent.journal.add('task.started',{runId:'run-1',result:'running'}))
    const response=await fetch(url+'?after='+first,{headers:{authorization:'Bearer '+env.CONTROL_API_TOKEN},signal:ctrl.signal})
    assert.equal(response.status,200)
    assert.match(response.headers.get('content-type'),/text\/event-stream/)
    const reader=response.body.getReader()
    let body=''
    await eventually(async()=>{
      const part=await reader.read()
      if(part.done)throw Error('Stream closed too early')
      body+=new TextDecoder().decode(part.value)
      return body.includes('task.started')
    })
    assert.match(body,/id: \d+/)
    assert.ok(!body.includes('NEVER_EXPOSE'))
    ctrl.abort()
    const newer=agent.journal.list(first).at(-1)?.id
    assert.ok(newer>first)
    // Once the client reconnects from the last ID, only later persisted events are replayed.
    agent.journal.add('task.completed',{runId:'run-1',result:'success'})
    const replayAbort=new AbortController()
    try{
      const replay=await fetch(url,{headers:{authorization:'Bearer '+env.CONTROL_API_TOKEN,'Last-Event-ID':String(newer)},signal:replayAbort.signal})
      const reader=replay.body.getReader()
      let chunk=''
      await eventually(async()=>{
        const part=await reader.read()
        if(part.done)throw Error('Replay stream ended')
        chunk+=new TextDecoder().decode(part.value)
        return chunk.includes('task.completed')
      })
      assert.ok(!chunk.includes('task.started'))
    }finally{replayAbort.abort()}
  }finally{
    ctrl.abort()
    await new Promise(r=>server.close(r))
    agent.close()
    fs.rmSync(root,{recursive:true,force:true})
  }
})
test('single Web hub consumes Core SSE, persists events across restart and never invents search progress',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mrs-live-web-'))
  const env={...process.env,CONTROL_API_TOKEN:token(),APP_DIR:root,
    CONTROL_DATA_DIR:path.join(root,'control'),STATE_DIR:path.join(root,'state'),
    LOG_DIR:path.join(root,'logs'),CRON_SCHEDULE:'0 9 * * *',TZ:'Asia/Shanghai'}
  fs.mkdirSync(env.STATE_DIR,{recursive:true});fs.mkdirSync(env.LOG_DIR,{recursive:true})
  const agent=createAgent(env),server=agent.app.listen(0,'127.0.0.1')
  await new Promise(r=>server.once('listening',r))
  const baseUrl='http://127.0.0.1:'+server.address().port
  const webDir=path.join(root,'web');let store=new Store(webDir)
  const hub=new LiveEventHub(store,{baseUrl,token:env.CONTROL_API_TOKEN})
  try{
    hub.start()
    agent.journal.add('task_started',{runId:'actual-run',result:'running'})
    agent.journal.add('task_finished',{runId:'actual-run',result:'risk_paused'})
    await eventually(()=>hub.recent().length>=2)
    assert.deepEqual(hub.recent().map(x=>x.kind),['container_started','task_started','task_finished'].slice(-hub.recent().length))
    assert.ok(!JSON.stringify(hub.recent()).includes('task.step.progress'))
    const cursor=hub.cursor()
    await hub.stop();store.close()
    store=new Store(webDir)
    const restarted=new LiveEventHub(store,{baseUrl,token:env.CONTROL_API_TOKEN})
    assert.equal(restarted.cursor(),cursor)
    assert.equal(restarted.recent().at(-1).runId,'actual-run')
    agent.journal.add('task_completed',{runId:'second-run',result:'success'})
    restarted.start()
    await eventually(()=>restarted.recent().some(e=>e.kind==='task_completed'))
    const ids=restarted.recent().map(e=>e.id)
    assert.equal(new Set(ids).size,ids.length)
    await restarted.stop()
  }finally{
    await hub.stop()
    store.close()
    await new Promise(r=>server.close(r))
    agent.close()
    fs.rmSync(root,{recursive:true,force:true})
  }
})
