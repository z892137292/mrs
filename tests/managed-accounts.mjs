// Real upstream loader/adapter integration; offline synthetic accounts, no browser login.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Accounts, privateRead } from '../admin/src/accounts.mjs'
const upstream=process.env.APP_DIR || process.env.UPSTREAM_TEST_DIR
assert.ok(upstream,'Provide actual compiled upstream directory')
const root=fileURLToPath(new URL('../',import.meta.url)),dir=fs.mkdtempSync(path.join(os.tmpdir(),'mrs-managed-'))
try{
    for(const n of ['dist','state','sessions'])fs.mkdirSync(path.join(dir,n))
    fs.mkdirSync(path.join(dir,'dist/util'));fs.symlinkSync(path.join(upstream,'dist/util/Load.js'),path.join(dir,'dist/util/Load.js'))
    fs.writeFileSync(path.join(dir,'sessions','preserve'),'SYNTHETIC_SESSION')
    const env={...process.env,APP_DIR:dir,STATE_DIR:path.join(dir,'state'),CONTROL_DATA_DIR:path.join(dir,'control'),ACCOUNT_1_EMAIL:'old@example.invalid',ACCOUNT_1_PASSWORD:'OLDPASS',ACCOUNT_9_EMAIL:'deleted@example.invalid',ACCOUNT_9_PASSWORD:'OLDNINE',REWARDS_BOT:'1'}
    // This consumer invokes actual patched upstream loadAccounts(), not a mock loader.
    fs.writeFileSync(path.join(dir,'dist/index.js'),`const {loadAccounts}=require(${JSON.stringify(path.join(upstream,'dist/util/Load.js'))});const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(dir,'used.json'))},JSON.stringify(loadAccounts()));console.log('[time] [new] [INFO] Desktop [LOGIN] Successfully logged in');`)
    const a=new Accounts(env);let result=a.update({action:'save',revision:0,values:{email:'new@example.invalid',password:'NEWPASS',totpSecret:'JBSWY3DPEHPK3PXP',proxyUrl:'http://proxy.invalid',proxyPort:8080,proxyUsername:'USER',proxyPassword:'PROXYPASS'}})
    const id=result.accounts.find(x=>x.label.startsWith('n***')).id
    for(const old of a.read().accounts.filter(x=>x.id!==id))a.update({action:'delete',revision:a.read().revision,id:old.id})
    execFileSync(process.execPath,[root+'admin/src/account-launch.mjs'],{env,stdio:'pipe'})
    let used=JSON.parse(fs.readFileSync(path.join(dir,'used.json')));assert.equal(used.length,1);assert.equal(used[0].email,'new@example.invalid');assert.equal(used[0].password,'NEWPASS');assert.equal(used[0].proxy.password,'PROXYPASS');assert.equal(used[0].totpSecret,'JBSWY3DPEHPK3PXP')
    let applied=privateRead(path.join(dir,'state/account-applied.json'));assert.equal(applied.revision,3);assert.equal(applied.login[id].status,'login_success')
    a.update({action:'save',revision:3,id,values:{password:'CHANGEDPASS'}})
    execFileSync(process.execPath,[root+'admin/src/account-launch.mjs'],{env,stdio:'pipe'});used=JSON.parse(fs.readFileSync(path.join(dir,'used.json')));assert.equal(used[0].password,'CHANGEDPASS')
    assert.equal(fs.readFileSync(path.join(dir,'sessions/preserve'),'utf8'),'SYNTHETIC_SESSION')
    const before=fs.readFileSync(a.file);assert.throws(()=>a.update({action:'save',revision:4,id,values:{proxyPort:99999}}));assert.deepEqual(fs.readFileSync(a.file),before)
    a.update({action:'save',revision:4,id,values:{enabled:false}});assert.throws(()=>execFileSync(process.execPath,[root+'admin/src/account-launch.mjs'],{env,stdio:'pipe'}))
    // Actual stopped private-directory tar backup and new-directory restore.
    const archive=path.join(dir,'private.tar');execFileSync('tar',['-C',dir,'-cf',archive,'control','state','sessions']);fs.chmodSync(archive,0o600)
    const restored=path.join(dir,'restored');fs.mkdirSync(restored);execFileSync('tar',['-C',restored,'-xf',archive]);const restoredStore=new Accounts({...env,CONTROL_DATA_DIR:path.join(restored,'control')});assert.equal(restoredStore.read().revision,5);assert.equal(restoredStore.read().accounts[0].password,'CHANGEDPASS');assert.equal(fs.readFileSync(path.join(restored,'sessions/preserve'),'utf8'),'SYNTHETIC_SESSION')
    console.log('PASS: actual upstream loadAccounts consumed new/changed secrets; disabled/deleted env slots absent; version receipt, private persistence, session preservation, bad-config rollback and real tar restore')
}finally{fs.rmSync(dir,{recursive:true,force:true})}
