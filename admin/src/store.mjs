import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import session from 'express-session'
import { redact, token } from './security.mjs'
export class Store {
    constructor(directory) {
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); fs.chmodSync(directory, 0o700)
        this.db = new DatabaseSync(path.join(directory, 'admin.sqlite'))
        fs.chmodSync(path.join(directory, 'admin.sqlite'), 0o600)
        this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL;
          CREATE TABLE IF NOT EXISTS settings(k TEXT PRIMARY KEY, v TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY, v TEXT NOT NULL, expires INTEGER NOT NULL);
          CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, actor TEXT, action TEXT, result TEXT);
          CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT, event TEXT, channel TEXT, v TEXT, priority INTEGER, attempts INTEGER DEFAULT 0, due INTEGER, state TEXT DEFAULT 'pending', error TEXT);
          CREATE UNIQUE INDEX IF NOT EXISTS delivery_once ON deliveries(event,channel);
          CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY, time TEXT, kind TEXT, v TEXT);`)
        this.db.exec('CREATE TABLE IF NOT EXISTS login_limits(id TEXT PRIMARY KEY, count INTEGER, until INTEGER)')
        this.set('sessionSecret', this.get('sessionSecret') || token())
        this.cleanup()
    }
    get(k) { const r = this.db.prepare('SELECT v FROM settings WHERE k=?').get(k); return r ? JSON.parse(r.v) : undefined }
    set(k, v) { this.db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, JSON.stringify(v)) }
    audit(actor, action, result) {
        this.db.prepare('INSERT INTO audit(time,actor,action,result) VALUES(?,?,?,?)').run(new Date().toISOString(), redact(actor), action, redact(result))
        this.db.exec('DELETE FROM audit WHERE id NOT IN (SELECT id FROM audit ORDER BY id DESC LIMIT 5000)')
    }
    cleanup() {
        this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now())
        this.db.exec("UPDATE deliveries SET state='pending' WHERE state='sending'; DELETE FROM deliveries WHERE state IN ('sent','failed','dropped') AND id NOT IN (SELECT id FROM deliveries ORDER BY id DESC LIMIT 2000)")
    }
    close() { this.db.close() }
}
export class SqliteSessionStore extends session.Store {
    constructor(store) { super(); this.store = store }
    get(id, cb) { try { const r = this.store.db.prepare('SELECT v FROM sessions WHERE id=? AND expires>?').get(id, Date.now()); cb(null, r ? JSON.parse(r.v) : null) } catch(e) { cb(e) } }
    set(id, value, cb) { try { this.store.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?)').run(id, JSON.stringify(value), Date.now() + 8 * 3600000); this.store.db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now()); this.store.db.exec('DELETE FROM sessions WHERE id NOT IN (SELECT id FROM sessions ORDER BY expires DESC LIMIT 5000)'); cb?.() } catch(e) { cb?.(e) } }
    destroy(id, cb) { try { this.store.db.prepare('DELETE FROM sessions WHERE id=?').run(id); cb?.() } catch(e) { cb?.(e) } }
}
