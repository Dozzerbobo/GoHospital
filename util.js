export class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
export const bad = (message, status = 400, extra) => { throw new HttpError(status, message, extra); };
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
export const now = () => Math.floor(Date.now() / 1000);

export function str(v, max = 200, { required = false, name = 'This field' } = {}) {
  if (v === undefined || v === null) v = '';
  v = String(v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (!v) { if (required) bad(`${name} is required.`); return null; }
  if (v.length > max) bad(`${name} is too long (max ${max} characters).`);
  return v;
}
export function emailAddr(v, { required = true, name = 'Email' } = {}) {
  const s = str(v, 254, { required, name });
  if (s === null) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s)) bad(`${name} doesn't look right.`);
  return s.toLowerCase();
}
export function phone(v, { required = false, name = 'Phone' } = {}) {
  const s = str(v, 40, { required, name });
  if (s === null) return null;
  if (!/^[+0-9 ()\-./]{6,40}$/.test(s)) bad(`${name} should contain only digits, spaces, + and -.`);
  return s;
}
export function url(v, { name = 'Website' } = {}) {
  let s = str(v, 300, { name });
  if (s === null) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try { const u = new URL(s); if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) throw 0; return u.toString(); }
  catch { bad(`${name} isn't a valid web address.`); }
}
export function int(v, { min = 0, max = 1000000, name = 'Number' } = {}) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) bad(`${name} must be a whole number between ${min} and ${max}.`);
  return n;
}
export function coord(v, min, max, name) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) bad(`${name} is not a valid coordinate.`);
  return n;
}
export const flag = (v) => (v === true || v === 1 || v === '1' || v === 'true' || v === 'on' || v === 'yes' ? 1 : 0);
export const oneOf = (v, list, name) => { if (!list.includes(v)) bad(`${name} is invalid.`); return v; };
export function slugify(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'hospital';
}
export async function uniqueSlug(env, base, ignoreId = 0) {
  let slug = slugify(base), i = 1;
  for (;;) {
    const row = await env.DB.prepare('SELECT id FROM hospitals WHERE slug = ? AND id != ?').bind(slug, ignoreId).first();
    if (!row) return slug;
    i += 1; slug = `${slugify(base)}-${i}`;
  }
}
export async function body(request) {
  const ct = request.headers.get('content-type') || '';
  if (!ct.includes('application/json')) bad('Expected JSON.', 415);
  try { const b = await request.json(); if (b === null || typeof b !== 'object') throw 0; return b; }
  catch { bad('Request body is not valid JSON.'); }
}
export const HOSPITAL_TYPES = ['teaching', 'general', 'specialist', 'clinic', 'maternity', 'primary'];
export const OWNERSHIPS = ['public', 'private', 'mission', 'ngo'];
export const ER_STATUSES = ['open', 'busy', 'diversion', 'closed'];
