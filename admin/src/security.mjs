import crypto from 'node:crypto'
import { promisify } from 'node:util'
const scrypt = promisify(crypto.scrypt)
export const token = () => crypto.randomBytes(32).toString('hex')
export function equal(a, b) {
    const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''))
    return x.length === y.length && crypto.timingSafeEqual(x, y)
}
export function redact(value) {
    return String(value ?? '').slice(0, 262144)
        .replace(/(?:Cookie|Set-Cookie|Authorization)\s*:\s*[^\r\n]*/gi, '凭证头: [已隐藏]')
        .replace(/((?:https?|socks[45]):\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[已隐藏]@')
        .replace(/(api\.telegram\.org\/bot)[^/\s]+/gi, '$1[已隐藏]')
        .replace(/("?(?:password|passwd|cookie|session(?:id)?|totp[_-]?secret|access[_-]?token|refresh[_-]?token|token|secret|api[_-]?key|client[_-]?secret|proxy[_-]?password)"?\s*[:=]\s*)("[^"]*"|[^\s,;&}]+)/gi, '$1[已隐藏]')
        .replace(/([^\s@<>"'()[\]{}:,;/\\])[^\s@<>"'()[\]{}:,;/\\]*@([\w.-]+\.[A-Za-z]{2,})/gu, '$1***@$2')
}
export const accountId = email => crypto.createHash('sha256').update(String(email).toLowerCase()).digest('hex').slice(0, 16)
export const maskEmail = email => String(email).includes('@') ? `${Array.from(String(email))[0] || '*'}***@${String(email).split('@').at(-1)}` : '[邮箱已隐藏]'
export async function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex')
    return { algorithm: 'scrypt-N32768-r8-p3', salt, hash: (await scrypt(password, salt, 64, { N:32768,r:8,p:3,maxmem:64*1024*1024 })).toString('hex') }
}
export async function checkPassword(password, stored) {
    const salt = stored?.salt || '00000000000000000000000000000000'
    return equal((await scrypt(password, salt, 64, { N:32768,r:8,p:3,maxmem:64*1024*1024 })).toString('hex'), stored?.hash || '')
}
export function passwordValid(p) { return typeof p === 'string' && p.length >= 12 && p.length <= 128 }
export function httpError(status, message) { return Object.assign(new Error(message), { status }) }
