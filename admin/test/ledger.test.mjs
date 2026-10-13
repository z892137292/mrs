import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const {Ledger,signature}=createRequire(import.meta.url)('../src/ledger.cjs')
test('durable ledger separates account completion, quota proof, suspect and interrupted runs; never trusts completed_at',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mrs-ledger-'));let l=new Ledger(dir)
 try{
  l.create('run-one','signature',3,100,['aaaaaaaaaaaaaaaa','bbbbbbbbbbbbbbbb'])
  l.event('run-one','aaaaaaaaaaaaaaaa','account.started')
  l.event('run-one','aaaaaaaaaaaaaaaa','task.step.started','pc_search')
  l.event('run-one','aaaaaaaaaaaaaaaa','task.step.progress','pc_search',30,120)
  l.event('run-one','aaaaaaaaaaaaaaaa','task.step.returned','pc_search')
  l.event('run-one','aaaaaaaaaaaaaaaa','account.completed')
  l.finish('run-one','success');assert.equal(l.get('run-one').state,'suspect');assert.equal(l.public('run-one').suspect,true)
  assert.ok(!JSON.stringify(l.public('run-one')).includes('signature'))
  l.create('run-two','signature',3,101,['bbbbbbbbbbbbbbbb'])
  l.event('run-two','bbbbbbbbbbbbbbbb','account.started');l.event('run-two','bbbbbbbbbbbbbbbb','task.step.started','mobile_search')
  l.event('run-two','bbbbbbbbbbbbbbbb','task.step.completed','mobile_search',90,0);l.event('run-two','bbbbbbbbbbbbbbbb','task.step.returned','mobile_search');l.event('run-two','bbbbbbbbbbbbbbbb','account.completed');l.finish('run-two','success');assert.equal(l.get('run-two').state,'completed')
  l.create('run-three','signature',3,102,['aaaaaaaaaaaaaaaa']);l.event('run-three','aaaaaaaaaaaaaaaa','account.started');l.interrupt('run-three');assert.equal(l.get('run-three').state,'suspect')
  l.create('run-no-proof','signature',3,103,['aaaaaaaaaaaaaaaa']);l.finish('run-no-proof','success');assert.equal(l.get('run-no-proof').state,'suspect')
  assert.equal(l.get('run-two').evidence.find(x=>x.stage==='mobile_search').observed,90)
  assert.equal(l.get('run-two').evidence.find(x=>x.stage==='mobile_search').remaining,0)
  l.close();l=new Ledger(dir);assert.equal(l.get('run-one').evidence.find(x=>x.stage==='pc_search').state,'suspect')
  const a=signature({CONTROL_API_TOKEN:'private',MRS_VERSION:'rc'},[{password:'ONE'}],{}),b=signature({CONTROL_API_TOKEN:'private',MRS_VERSION:'rc'},[{password:'TWO'}],{});assert.notEqual(a,b);assert.ok(!a.includes('ONE'))
  assert.equal(l.prepare('new-after-uncertain'),false)
  l.acknowledge();assert.equal(l.prepare('new-after-human-review'),true);assert.ok(l.public('run-one').reviewedAt)
  l.create('interrupted-retry','signature',3,104,['aaaaaaaaaaaaaaaa']);l.event('interrupted-retry','aaaaaaaaaaaaaaaa','task.step.started','pc_search');assert.equal(l.prepare('interrupted-retry'),false)
  assert.equal(l.prepare('next-after-crash'),false);l.acknowledge();assert.equal(l.prepare('next-after-review'),true)
  l.db.prepare('UPDATE runs SET updated=? WHERE id=?').run('new-snapshot','run-one');assert.ok(l.unreviewed().some(r=>r.id==='run-one'))
 }finally{l.close();fs.rmSync(dir,{recursive:true,force:true})}
})
