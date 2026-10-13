import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Accounts } from '../src/accounts.mjs'
import { observeLogin } from '../src/account-launch.mjs'
test('account atomic failure keeps old version, disabled/deleted slots never reappear, secrets preserve/clear',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'mrs-accounts-')),env={CONTROL_DATA_DIR:dir,ACCOUNT_1_EMAIL:'old@example.invalid',ACCOUNT_1_PASSWORD:'OLDSECRET'},a=new Accounts(env)
    try{
        a.update({action:'save',revision:0,values:{email:'new@example.invalid',password:'NEWSECRET'}})
        const id=a.read().accounts[1].id;a.update({action:'save',revision:1,id,values:{password:'',enabled:false}})
        assert.equal(a.runtime().env.ACCOUNT_1_PASSWORD,'OLDSECRET');assert.equal(a.runtime().env.ACCOUNT_2_EMAIL,undefined)
        const old=a.read().accounts[0].id;a.update({action:'delete',revision:2,id:old})
        assert.throws(()=>a.runtime(),/没有启用账号/)
        const before=fs.readFileSync(a.file);assert.throws(()=>a.update({action:'save',revision:3,id,values:{email:'invalid'}}));assert.deepEqual(fs.readFileSync(a.file),before)
        a.update({action:'save',revision:3,id,values:{enabled:true,clearSecrets:['password']}});assert.equal(a.runtime().env.ACCOUNT_1_EMAIL,'new@example.invalid');assert.equal(a.runtime().env.ACCOUNT_1_PASSWORD,'')
        assert.equal(new Accounts(env).read().revision,4)
        fs.unlinkSync(a.file);fs.symlinkSync(path.join(dir,'missing'),a.file);assert.throws(()=>a.read())
    }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
test('login evidence needs actual LOGIN message and unambiguous account; task/config success is insufficient',()=>{
    const accounts=[{email:'alice@example.invalid',id:'one'}],evidence={}
    observeLogin('[time] [alice] [INFO] Desktop [TASK] Successfully logged in',accounts,evidence);assert.deepEqual(evidence,{})
    observeLogin('[time] [alice] [INFO] Desktop [LOGIN] Successfully logged in',accounts,evidence);assert.equal(evidence.one.status,'login_success')
    observeLogin('[time] [alice] [ERROR] Desktop [LOGIN] Fatal error: Login failed',accounts,evidence);assert.equal(evidence.one.status,'login_failed')
    observeLogin('[time] [alice] [ERROR] Desktop [LOGIN] Fatal error: ACCOUNT_LOCKED',accounts,evidence);assert.equal(evidence.one.status,'restricted')
    observeLogin('[time] [alice] [ERROR] Desktop [LOGIN] Fatal error: verification manual review',accounts,evidence);assert.equal(evidence.one.status,'manual_verification')
    const ambiguous={};observeLogin('[time] [alice] [INFO] Desktop [LOGIN] Successfully logged in',[...accounts,{email:'alice@other.invalid',id:'two'}],ambiguous);assert.deepEqual(ambiguous,{})
})
