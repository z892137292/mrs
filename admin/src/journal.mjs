import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { redact } from './security.mjs'
export class Journal {
    constructor(directory) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700)
        this.db = new DatabaseSync(path.join(directory, 'events.sqlite'))
        fs.chmodSync(path.join(directory, 'events.sqlite'), 0o600)
        this.db.exec(`PRAGMA busy_timeout=300; PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,time TEXT,kind TEXT,v TEXT);`)
    }
    add(kind, data = {}) {
        const v = { result: redact(data.result), reason: redact(data.reason), runId: redact(data.runId), accounts: (data.accounts || []).slice(0, 100).map(redact) }
        this.db.prepare('INSERT INTO events(time,kind,v) VALUES(?,?,?)').run(new Date().toISOString(), kind, JSON.stringify(v))
        this.db.exec('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 2000)')
    }
    list(after = 0) { return this.db.prepare('SELECT * FROM events WHERE id>? ORDER BY id LIMIT 100').all(after).map(x => ({ ...x, ...JSON.parse(x.v), v: undefined })) }
    recent() { return this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 2000').all().map(x => ({ ...x, ...JSON.parse(x.v), v: undefined })) }
    close() { this.db.close() }
}
