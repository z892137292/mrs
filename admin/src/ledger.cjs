const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite')
class Ledger {
 constructor(directory){fs.mkdirSync(directory,{recursive:true,mode:0o700});this.db=new DatabaseSync(path.join(directory,'events.sqlite'));fs.chmodSync(path.join(directory,'events.sqlite'),0o600);this.db.exec(`PRAGMA busy_timeout=1000;PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT,kind TEXT,v TEXT);
 CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,state TEXT,signature TEXT,revision INTEGER,pid INTEGER,created TEXT,updated TEXT,accounts TEXT);
 CREATE TABLE IF NOT EXISTS run_evidence(run TEXT,account TEXT,stage TEXT,state TEXT,observed REAL,remaining REAL,updated TEXT,PRIMARY KEY(run,account,stage));
 CREATE TABLE IF NOT EXISTS run_reviews(run TEXT PRIMARY KEY,snapshot_updated TEXT,reviewed_at TEXT);`)}
 create(id,signature,revision,pid,accounts){if(!/^[\w-]{1,100}$/.test(id))throw Error('Invalid run id');const now=new Date().toISOString();this.db.prepare('INSERT OR IGNORE INTO runs VALUES(?,?,?,?,?,?,?,?)').run(id,'running',signature,revision,pid,now,now,JSON.stringify(accounts));this.db.exec("DELETE FROM runs WHERE state!='running' AND id NOT IN (SELECT id FROM runs ORDER BY created DESC LIMIT 2000);DELETE FROM run_evidence WHERE run NOT IN (SELECT id FROM runs);DELETE FROM run_reviews WHERE run NOT IN (SELECT id FROM runs)");}
 event(run,accountId,kind,stage=null,observedPoints=null,remainingPoints=null){
  if(!run || !accountId)return
  const now=new Date().toISOString(),states={'account.started':'running','account.completed':'completed','account.failed':'suspect','task.step.started':'running','task.step.completed':'completed','task.step.interrupted':'suspect','task.step.progress':'running','task.step.returned':'suspect'}
  if(!states[kind])return
  this.db.exec('BEGIN IMMEDIATE')
  try{const old=this.db.prepare('SELECT state,observed,remaining FROM run_evidence WHERE run=? AND account=? AND stage=?').get(run,accountId,stage || 'account')
   if(kind==='task.step.returned'){observedPoints=old?.observed ?? null;remainingPoints=old?.remaining ?? null}
   const state=kind==='task.step.returned' && old?.state==='completed'?'completed':old?.state==='suspect' && kind!=='account.completed'?'suspect':states[kind]
   this.db.prepare('INSERT OR REPLACE INTO run_evidence VALUES(?,?,?,?,?,?,?)').run(run,accountId,stage || 'account',state,observedPoints,remainingPoints,now)
   this.db.prepare('INSERT INTO events(time,kind,v) VALUES(?,?,?)').run(now,kind,JSON.stringify({runId:run,accountId,stage,result:state,observedPoints,remainingPoints,reason:'执行器持久化证据；积分来自服务端计数，不代表搜索次数'}))
   this.db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 2000)');this.db.exec('COMMIT')
  }catch(e){this.db.exec('ROLLBACK');throw e}
 }
 finish(id,result){this.db.prepare("UPDATE run_evidence SET state='suspect' WHERE run=? AND state='running'").run(id);const run=this.get(id),uncertain=run && (run.evidence.some(x=>x.state==='suspect') || run.accounts.some(account=>!run.evidence.some(x=>x.account===account&&x.stage==='account'&&x.state==='completed')));const state=result==='success'&&uncertain?'suspect':{success:'completed',failed:'failed',risk_paused:'risk_paused',stopped:'aborted',paused:'paused'}[result] || 'suspect';this.db.prepare('UPDATE runs SET state=?,updated=? WHERE id=?').run(state,new Date().toISOString(),id)}
 interrupt(id){this.db.prepare("UPDATE run_evidence SET state='suspect' WHERE run=? AND state='running'").run(id);this.db.prepare("UPDATE runs SET state='suspect',updated=? WHERE id=? AND state='running'").run(new Date().toISOString(),id)}
 unreviewed(){return this.db.prepare("SELECT r.id,r.updated FROM runs r WHERE r.state!='running' AND (r.state='suspect' OR EXISTS(SELECT 1 FROM run_evidence e WHERE e.run=r.id AND e.state='suspect')) AND NOT EXISTS(SELECT 1 FROM run_reviews v WHERE v.run=r.id AND v.snapshot_updated=r.updated)").all()}
 acknowledge(){this.db.exec('BEGIN IMMEDIATE');try{for(const r of this.unreviewed())this.db.prepare('INSERT OR REPLACE INTO run_reviews VALUES(?,?,?)').run(r.id,r.updated,new Date().toISOString());this.db.exec('COMMIT')}catch(e){this.db.exec('ROLLBACK');throw e}}
 prepare(id){for(const r of this.db.prepare("SELECT id FROM runs WHERE state='running'").all())if(r.id!==id)this.interrupt(r.id);const previous=id&&this.get(id);return !this.unreviewed().length&&!previous?.evidence.some(e=>['pc_search','mobile_search'].includes(e.stage)&&['running','suspect'].includes(e.state))}
 list(){return this.db.prepare('SELECT id,state,revision,created,updated FROM runs ORDER BY created DESC LIMIT 200').all()}
 get(id){const row=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);if(!row)return null;return {...row,accounts:JSON.parse(row.accounts),evidence:this.db.prepare('SELECT account,stage,state,observed,remaining,updated FROM run_evidence WHERE run=?').all(id)}}
 public(id){const r=this.get(id);if(!r)return null;const {signature,pid,...v}=r;return {...v,reviewedAt:this.db.prepare('SELECT reviewed_at FROM run_reviews WHERE run=? AND snapshot_updated=?').get(id,r.updated)?.reviewed_at || null,resumeGranularity:'仅未开始账号；不自动续跑不确定的阶段/单次搜索',suspect:r.evidence.some(x=>x.state==='running'||x.state==='suspect')}}
 close(){this.db.close()}
}
function signature(env,accounts,config){return crypto.createHmac('sha256',env.CONTROL_API_TOKEN || '').update(JSON.stringify({accounts,config,version:env.MRS_VERSION})).digest('hex')}
let instance
function pause(reason){const state=process.env.STATE_DIR || path.join(process.env.APP_DIR,'state');try{fs.writeFileSync(path.join(state,'STOP'),'manual review: execution evidence suspect; '+reason,{flag:'wx',mode:0o600})}catch(e){if(e.code!=='EEXIST')throw e}}
function emit(bot,kind,stage=null,observed=null,remaining=null){
 if(process.env.CONTROL_API_ENABLED!=='true' || !process.env.MRS_RUN_ID)return
 const email=bot.currentAccountEmail || process.env.MRS_CURRENT_ACCOUNT
 const map=JSON.parse(process.env.MRS_ACCOUNT_IDS || '{}'),id=map[String(email).trim().toLowerCase()];if(!id)return
 instance ||= new Ledger(process.env.CONTROL_DATA_DIR || path.join(process.env.APP_DIR,'control-data'))
 try{instance.event(process.env.MRS_RUN_ID,id,kind,stage,observed,remaining)
  const run=instance.get(process.env.MRS_RUN_ID),unsafe=kind==='task.step.returned'?run.evidence.some(e=>e.account===id&&e.stage===stage&&e.state==='suspect'):kind==='account.failed'&&run.evidence.some(e=>e.account===id&&['pc_search','mobile_search'].includes(e.stage)&&['running','suspect'].includes(e.state))
  if(unsafe){instance.interrupt(run.id);try{pause('stage has no confirmed completion')}finally{process.exit(78)}}
 }catch{try{pause('evidence persistence failed')}finally{process.exit(78)}}
}
module.exports={Ledger,signature,emit,pause}
if(require.main===module){const ledger=new Ledger(process.env.CONTROL_DATA_DIR || path.join(process.env.APP_DIR,'control-data'));try{if(process.argv[2]==='acknowledge')ledger.acknowledge();else if(process.argv[2]==='reconcile'){if(!ledger.prepare(null))pause('interrupted execution needs review')}else if(process.argv[2]==='check'){if(ledger.unreviewed().length)process.exitCode=78}else process.exitCode=2}finally{ledger.close()}}
