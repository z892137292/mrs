// Optional, bounded runtime hook. It never controls a task or sends a notification.
import fs from 'node:fs'
import path from 'node:path'
import { Journal } from './journal.mjs'
import { Accounts } from './accounts.mjs'
import { createRequire } from 'node:module'
const {Ledger,pause}=createRequire(import.meta.url)('./ledger.cjs')
try {
    if (process.env.CONTROL_API_ENABLED === 'true') {
        const j = new Journal(process.env.CONTROL_DATA_DIR || '/usr/src/microsoft-rewards-script/control-data')
        const [kind, runId, result] = process.argv.slice(2)
        let reason = ''
        try { reason = fs.readFileSync(path.join(process.env.STATE_DIR || `${process.env.APP_DIR}/state`, 'STOP'), 'utf8').slice(0, 1000) } catch {}
        let accounts = []
        if (kind === 'task_started'){const filter=(process.env.RUN_ACCOUNT_FILTER || '').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean);accounts=new Accounts().read().accounts.filter(a=>a.enabled&&(!filter.length||filter.includes(a.email.toLowerCase()))).map(a=>a.id)}
        else try { accounts = JSON.parse(fs.readFileSync(path.join(process.env.STATE_DIR || `${process.env.APP_DIR}/state`, 'last-summary.json'))).accounts.map(a => a.email) } catch {}
        j.add(kind, { runId, result, reason, accounts })
        // Standardized event types are derived only from actual wrapper outcomes.
        // No synthetic PC/mobile progress is emitted until search-level instrumentation exists.
        if(kind==='task_started')j.add('task.started',{runId,result:'running',accounts})
        if(kind==='task_finished'){
            const ledger=new Ledger(process.env.CONTROL_DATA_DIR || '/usr/src/microsoft-rewards-script/control-data');ledger.finish(runId,result);const uncertain=ledger.get(runId)?.state==='suspect';if(ledger.unreviewed().length)pause('finished run has uncertain execution');ledger.close()
            const finished=uncertain?'task.paused':{success:'task.completed',failed:'task.failed',risk_paused:'task.paused',suspect:'task.paused',stopped:'task.paused'}[result]
            if(finished)j.add(finished,{runId,result:uncertain?'suspect':result,reason,accounts})
        }
        if(kind==='verification_required')j.add('task.auth.required',{runId,result:'waiting_manual_review',reason,accounts})
        j.close()
    }
} catch { /* A journal failure must not change lock, retry, STOP or exit code. */ }
