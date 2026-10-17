import { bad, now } from './util.js';

const enc = new TextEncoder();
const ITER = 100000; // Workers PBKDF2 maximum
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

async function derive(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${toB64(salt)}$${toB64(await derive(password, salt, ITER))}`;
}
export async function verifyPassword(password, stored) {
  const [alg, iter, salt, hash] = String(stored).split('$');
  if (alg !== 'pbkdf2') return false;
  const got = new Uint8Array(await derive(password, fromB64(salt), Number(iter)));
  const want = fromB64(hash);
  if (got.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
export function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 10) bad('Password must be at least 10 characters.');
  if (pw.length > 200) bad('Password is too long.');
  if (/^(.)\1+$/.test(pw) || /^(password|12345678|qwertyuiop)/i.test(pw)) bad('Choose a stronger password.');
}
export function tempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(14));
  return [...r].map((x) => chars[x % chars.length]).join('');
}
const sha256 = async (s) => toHex(await crypto.subtle.digest('SHA-256', enc.encode(s)));

const COOKIE = 'gh_session';
const SESSION_DAYS = 14;

export async function createSession(env, userId) {
  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const t = now();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(t),
    env.DB.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)')
      .bind(await sha256(token), userId, t, t + SESSION_DAYS * 86400),
  ]);
  return token;
}
export const sessionCookie = (token) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
export const clearCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

function readCookie(request) {
  const m = /(?:^|;\s*)gh_session=([a-f0-9]{64})/.exec(request.headers.get('cookie') || '');
  return m ? m[1] : null;
}
export async function destroySession(env, request) {
  const token = readCookie(request);
  if (token) await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(await sha256(token)).run();
}
export async function currentUser(env, request) {
  const token = readCookie(request);
  if (!token) return null;
  const u = await env.DB.prepare(
    `SELECT u.id,u.email,u.role,u.hospital_id,u.name,u.must_change_password
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.disabled = 0`
  ).bind(await sha256(token), now()).first();
  return u || null;
}
export async function requireUser(env, request, role) {
  const u = await currentUser(env, request);
  if (!u) bad('Please sign in.', 401);
  if (role && u.role !== role) bad('You do not have access to this.', 403);
  if (role === 'hospital' && !u.hospital_id) bad('No hospital is linked to this account.', 403);
  return u;
}
export async function rateLimit(env, key, limit, windowSec) {
  const t = now();
  const row = await env.DB.prepare('SELECT count,reset_at FROM rate_limits WHERE key = ?').bind(key).first();
  if (!row || row.reset_at <= t) {
    await env.DB.prepare('INSERT OR REPLACE INTO rate_limits (key,count,reset_at) VALUES (?,?,?)').bind(key, 1, t + windowSec).run();
    return;
  }
  if (row.count >= limit) bad('Too many attempts. Please wait a few minutes and try again.', 429);
  await env.DB.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
}
export async function clearRateLimit(env, key) {
  await env.DB.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
}
export const clientIp = (request) => request.headers.get('cf-connecting-ip') || 'unknown';
