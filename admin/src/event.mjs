// Optional, bounded runtime hook. It never controls a task or sends a notification.
import fs from 'node:fs'
import path from 'node:path'
import { Journal } from './journal.mjs'
try {
    if (process.env.CONTROL_API_ENABLED === 'true') {
        const j = new Journal(process.env.CONTROL_DATA_DIR || '/usr/src/microsoft-rewards-script/control-data')
        const [kind, runId, result] = process.argv.slice(2)
        let reason = ''
        try { reason = fs.readFileSync(path.join(process.env.STATE_DIR || `${process.env.APP_DIR}/state`, 'STOP'), 'utf8').slice(0, 1000) } catch {}
        let accounts = []
        if (kind === 'task_started') accounts = Object.keys(process.env).filter(k => /^ACCOUNT_[1-9]\d*_EMAIL$/.test(k)).map(k => process.env[k])
        else try { accounts = JSON.parse(fs.readFileSync(path.join(process.env.STATE_DIR || `${process.env.APP_DIR}/state`, 'last-summary.json'))).accounts.map(a => a.email) } catch {}
        j.add(kind, { runId, result, reason, accounts })
        // Standardized event types are derived only from actual wrapper outcomes.
        // No synthetic PC/mobile progress is emitted until search-level instrumentation exists.
        if(kind==='task_started')j.add('task.started',{runId,result:'running',accounts})
        if(kind==='task_finished'){
            const finished={success:'task.completed',failed:'task.failed',risk_paused:'task.paused',stopped:'task.paused'}[result]
            if(finished)j.add(finished,{runId,result,reason,accounts})
        }
        if(kind==='verification_required')j.add('task.auth.required',{runId,result:'waiting_manual_review',reason,accounts})
        j.close()
    }
} catch { /* A journal failure must not change lock, retry, STOP or exit code. */ }
