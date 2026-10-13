import { redact } from './security.mjs'
const coreClients=new WeakMap()
// Phase 1: durable Core journal -> one Web subscriber -> authenticated browser SSE.
// This stream only publishes persisted evidence. It never manufactures search counts.
export function streamCoreEvents(journal, req, res, {intervalMs=750}={}) {
  if((coreClients.get(journal)||0)>=32)return res.status(429).json({error:'事件订阅达到上限'})
  coreClients.set(journal,(coreClients.get(journal)||0)+1)
  const raw=req.get('last-event-id') || req.query.after || '0'
  let after=/^\d+$/.test(String(raw)) ? Number(raw) : 0
  if(!Number.isSafeInteger(after)) after=0
  res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'})
  res.flushHeaders()
  res.write('retry: 2000\n\n')
  let closed=false
  const bounds=journal.db.prepare('SELECT MIN(id) AS first, MAX(id) AS last FROM events').get()
  if(after && ((bounds.first && after<bounds.first-1) || after>bounds.last)){
    res.write('event: gap\ndata: '+JSON.stringify({reason:'retention_or_core_reset',after,first:bounds.first,last:bounds.last})+'\n\n')
    after=0
  }
  const send=()=>{
    if(closed || res.destroyed)return
    try {
      // Drain in bounded batches; no event may be silently skipped at the 100-row page limit.
      for(let batch=0;batch<10;batch++){
        const events=journal.list(after)
        for(const event of events){
          if(!res.write('id: '+event.id+'\ndata: '+JSON.stringify(event)+'\n\n')){res.end();return}
          after=event.id
        }
        if(events.length<100)break
      }
    }catch{res.end()}
  }
  const timer=setInterval(send,intervalMs)
  const heartbeat=setInterval(()=>{if(!closed && !res.destroyed)res.write(': keepalive\n\n')},15000)
  timer.unref();heartbeat.unref()
  res.on('close',()=>{closed=true;coreClients.set(journal,Math.max(0,(coreClients.get(journal)||1)-1));clearInterval(timer);clearInterval(heartbeat)})
  send()
}

export class LiveEventHub {
  constructor(store,{baseUrl,token,fetchImpl=fetch,now=()=>Date.now()}){
    this.store=store;this.baseUrl=baseUrl;this.token=token;this.fetchImpl=fetchImpl;this.now=now
    this.subscribers=new Set();this.stopped=true;this.controller=null;this.current=null
    this.store.db.exec('CREATE TABLE IF NOT EXISTS live_events (id INTEGER PRIMARY KEY,time TEXT,kind TEXT,payload TEXT)')
  }
  cursor(){return Number(this.store.get('coreLiveCursor')||0)}
  recent(after=0,limit=100){
    return this.store.db.prepare('SELECT payload FROM live_events WHERE id>? ORDER BY id ASC LIMIT ?')
      .all(after,Math.min(500,Math.max(1,limit))).map(r=>JSON.parse(r.payload))
  }
  latest(limit=100){
    return this.store.db.prepare('SELECT payload FROM live_events ORDER BY id DESC LIMIT ?')
      .all(Math.min(500,Math.max(1,limit))).reverse().map(r=>JSON.parse(r.payload))
  }
  accept(value){
    if(!value || !Number.isSafeInteger(value.id) || value.id<=0 || typeof value.kind!=='string'
       || typeof value.time!=='string' || value.kind.length>100)return false
    // Only well-formed, redacted journal fields are persisted; never forward arbitrary upstream payloads.
    const item={id:value.id,time:value.time,kind:value.kind,
      result:redact(String(value.result||'').slice(0,400)),reason:redact(String(value.reason||'').slice(0,400)),
      runId:redact(String(value.runId||'').slice(0,100)),accountId:/^[a-f0-9-]{16,64}$/.test(value.accountId || '')?value.accountId:null,stage:['pc_search','mobile_search','other','login'].includes(value.stage)?value.stage:null,observedPoints:Number.isFinite(value.observedPoints)?value.observedPoints:null,remainingPoints:Number.isFinite(value.remainingPoints)?value.remainingPoints:null}
    if(item.id<=this.cursor())return false
    this.store.db.exec('BEGIN IMMEDIATE')
    try{this.store.db.prepare('INSERT OR IGNORE INTO live_events(id,time,kind,payload) VALUES(?,?,?,?)')
      .run(item.id,item.time,item.kind,JSON.stringify(item))
    this.store.set('coreLiveCursor',item.id)
    this.store.db.exec('COMMIT')}catch(e){this.store.db.exec('ROLLBACK');throw e}
    this.store.db.exec('DELETE FROM live_events WHERE id NOT IN (SELECT id FROM live_events ORDER BY id DESC LIMIT 2000)')
    const data='id: '+item.id+'\ndata: '+JSON.stringify(item)+'\n\n'
    for(const subscriber of this.subscribers){
      try{if(!subscriber.write(data)){this.subscribers.delete(subscriber);subscriber.end()}}
      catch{this.subscribers.delete(subscriber);subscriber.destroy()}
    }
    return true
  }
  async subscribe(req,res){
    if(this.subscribers.size>=32)return res.status(429).json({error:'实时连接数量已达上限'})
    const rawCursor=req.get('last-event-id') || req.query.after
    let after=Number(rawCursor || 0)
    if(!Number.isSafeInteger(after)||after<0)after=0
    res.status(200).set({'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-store, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no'})
    res.flushHeaders()
    res.write('retry: 3000\n\n')
    // Backfill from durable Web data before joining live broadcasts.
    const bounds=this.store.db.prepare('SELECT MIN(id) AS first,MAX(id) AS last FROM live_events').get()
    if(after && (after<bounds.first-1 || after>bounds.last)){res.write('event: gap\ndata: {"reason":"history_gap","snapshotRequired":true}\n\n');after=0}
    if(rawCursor){for(let batch=0;batch<20;batch++){const items=this.recent(after,500);for(const item of items){if(res.destroyed)return;if(!res.write('id: '+item.id+'\ndata: '+JSON.stringify(item)+'\n\n')){await new Promise(resolve=>{const done=()=>{res.off('drain',done);res.off('close',done);resolve()};res.once('drain',done);res.once('close',done)});if(res.destroyed)return}after=item.id}if(items.length<500)break}}
    else for(const item of this.latest(100))res.write('id: '+item.id+'\ndata: '+JSON.stringify(item)+'\n\n')
    this.subscribers.add(res)
    const heartbeat=setInterval(()=>{req.sessionStore?.get(req.sessionID,(error,value)=>{if(error || !value?.admin)res.end()});if(!res.destroyed)res.write(': keepalive\n\n')},5000)
    heartbeat.unref()
    res.on('close',()=>{clearInterval(heartbeat);this.subscribers.delete(res)})
  }
  start(){
    if(!this.stopped)return
    this.stopped=false
    this.current=this.listen()
  }
  async listen(){
    let delay=1000
    while(!this.stopped){
      this.controller=new AbortController()
      let lastChunk=this.now()
      const watchdog=setInterval(()=>{if(this.now()-lastChunk>45000)this.controller?.abort()},5000)
      watchdog.unref()
      try {
        const url=new URL('/events/stream',this.baseUrl)
        url.searchParams.set('after',String(this.cursor()))
        const response=await this.fetchImpl(url,{headers:{authorization:'Bearer '+this.token},
          signal:this.controller.signal,redirect:'error'})
        if(!response.ok||!response.body)throw Error('Core event stream unavailable')
        delay=1000
        let buffer=''
        const decoder=new TextDecoder()
        for await(const chunk of response.body){
          if(this.stopped)break
          lastChunk=this.now()
          buffer+=decoder.decode(chunk,{stream:true})
          if(buffer.length>131072)throw Error('Oversized event stream buffer')
          let end
          while((end=buffer.indexOf('\n\n'))>=0){
            const block=buffer.slice(0,end).replaceAll('\r','');buffer=buffer.slice(end+2)
            const data=block.split('\n').filter(s=>s.startsWith('data: ')).map(s=>s.slice(6)).join('\n')
            if(block.startsWith('event: gap')){this.store.db.exec('BEGIN IMMEDIATE');try{this.store.db.exec('DELETE FROM live_events');this.store.set('coreLiveCursor',0);this.store.set('coreLiveGap',{time:new Date().toISOString(),reason:'retention_or_core_reset'});this.store.db.exec('COMMIT')}catch(e){this.store.db.exec('ROLLBACK');throw e}for(const client of this.subscribers){try{if(!client.write('event: gap\ndata: {"reason":"core_history_gap","snapshotRequired":true}\n\n'))client.end()}catch{client.destroy()}}}
            else if(data)this.accept(JSON.parse(data))
          }
        }
      }catch{/* Core may restart: resume from last durable event id. */}finally{clearInterval(watchdog)}
      if(this.stopped)break
      await new Promise(resolve=>{const timer=setTimeout(resolve,delay);timer.unref?.();this.waiter=resolve})
      delay=Math.min(delay*2,10000)
    }
  }
  async stop(){
    this.stopped=true
    this.controller?.abort()
    this.waiter?.()
    await this.current?.catch(()=>{})
    for(const r of this.subscribers)r.end()
    this.subscribers.clear()
  }
}
