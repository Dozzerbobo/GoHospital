import {
  HttpError, bad, json, now, str, emailAddr, body, int, flag, oneOf, uniqueSlug, ER_STATUSES,
} from '../../src/util.js';
import {
  hashPassword, verifyPassword, checkPasswordStrength, tempPassword, createSession, sessionCookie, clearCookie,
  destroySession, currentUser, requireUser, rateLimit, clearRateLimit, clientIp,
} from '../../src/auth.js';
import {
  loadHospitals, loadHospital, searchHospitals, parseProfile, profileCols, validCodes, setTagsStmts, parseLive, liveStmts,
} from '../../src/hospitals.js';
import { adminRoutes } from '../../src/admin.js';

const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
  routes.push({ method, re, keys, handler });
};
const ctxUser = (u) => ({ id: u.id, email: u.email, role: u.role, name: u.name, hospital_id: u.hospital_id, must_change_password: !!u.must_change_password });

// ---------------- public ----------------
route('GET', '/specialties', async ({ env }) => {
  const { results } = await env.DB.prepare(
    'SELECT code,label,kind,description FROM specialties WHERE active = 1 ORDER BY sort').all();
  return json({ specialties: results }, 200, { 'cache-control': 'public, max-age=300' });
});

route('GET', '/hospitals', async ({ env, url }) => {
  const r = await searchHospitals(env, url.searchParams);
  return json(r, 200, { 'cache-control': 'public, max-age=15' });
});

route('GET', '/hospitals/:slug', async ({ env, params }) => {
  const h = await loadHospital(env, "WHERE h.slug = ? AND h.status = 'active'", [params.slug]);
  if (!h) bad('Hospital not found.', 404);
  return json({ hospital: h }, 200, { 'cache-control': 'public, max-age=15' });
});

route('GET', '/stats', async ({ env }) => {
  const t = now() - 86400;
  const a = await env.DB.prepare("SELECT COUNT(*) n, SUM(verified) v FROM hospitals WHERE status='active'").first();
  const b = await env.DB.prepare(
    "SELECT COUNT(*) n FROM hospital_status s JOIN hospitals h ON h.id=s.hospital_id WHERE h.status='active' AND s.updated_at > ?").bind(t).first();
  const c = await env.DB.prepare(
    "SELECT COUNT(DISTINCT hs.code) n FROM hospital_specialties hs JOIN hospitals h ON h.id=hs.hospital_id JOIN specialties sp ON sp.code=hs.code WHERE h.status='active' AND sp.kind='specialty'").first();
  return json({ hospitals: a.n, verified: a.v || 0, updated_today: b.n, specialties_covered: c.n }, 200, { 'cache-control': 'public, max-age=60' });
});

route('POST', '/contact', async ({ env, request }) => {
  await rateLimit(env, `contact:${clientIp(request)}`, 5, 3600);
  const b = await body(request);
  if (b.website_url) return json({ ok: true }); // honeypot
  const name = str(b.name, 100, { required: true, name: 'Name' });
  const email = emailAddr(b.email);
  const message = str(b.message, 3000, { required: true, name: 'Message' });
  await env.DB.prepare('INSERT INTO contact_messages (name,email,message,created_at) VALUES (?,?,?,?)').bind(name, email, message, now()).run();
  return json({ ok: true });
});

// ---------------- auth ----------------
route('GET', '/auth/me', async ({ env, request }) => {
  const u = await currentUser(env, request);
  if (!u) return json({ user: null });
  let hospital = null;
  if (u.hospital_id) hospital = await env.DB.prepare('SELECT id,name,slug,status,verified FROM hospitals WHERE id = ?').bind(u.hospital_id).first();
  return json({ user: ctxUser(u), hospital });
});

route('GET', '/auth/setup-needed', async ({ env }) => {
  const r = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").first();
  return json({ needed: r.n === 0 });
});

// First-run only: creates the very first admin. Requires the SETUP_KEY secret.
route('POST', '/auth/setup', async ({ env, request }) => {
  await rateLimit(env, `setup:${clientIp(request)}`, 5, 900);
  const exists = await env.DB.prepare("SELECT COUNT(*) n FROM users WHERE role='admin'").first();
  if (exists.n > 0) bad('Setup is already complete.', 403);
  if (!env.SETUP_KEY) bad('SETUP_KEY is not configured on the server.', 500);
  const b = await body(request);
  if (!b.setup_key || b.setup_key !== env.SETUP_KEY) bad('Setup key is incorrect.', 403);
  const email = emailAddr(b.email);
  checkPasswordStrength(b.password);
  const name = str(b.name, 100, { name: 'Name' });
  await env.DB.prepare('INSERT INTO users (email,password_hash,role,name,created_at) VALUES (?,?,?,?,?)')
    .bind(email, await hashPassword(b.password), 'admin', name, now()).run();
  return json({ ok: true });
});

route('POST', '/auth/login', async ({ env, request }) => {
  const b = await body(request);
  const email = emailAddr(b.email);
  const key = `login:${clientIp(request)}:${email}`;
  await rateLimit(env, key, 8, 900);
  const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
  const ok = u && !u.disabled && (await verifyPassword(String(b.password || ''), u.password_hash));
  if (!ok) { if (!u) await hashPassword('x'); bad('Incorrect email or password.', 401); }
  await clearRateLimit(env, key);
  await env.DB.prepare('UPDATE users SET last_login = ? WHERE id = ?').bind(now(), u.id).run();
  const token = await createSession(env, u.id);
  return json({ user: ctxUser(u) }, 200, { 'set-cookie': sessionCookie(token) });
});

route('POST', '/auth/logout', async ({ env, request }) => {
  await destroySession(env, request);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie() });
});

route('POST', '/auth/password', async ({ env, request }) => {
  const u = await requireUser(env, request);
  const b = await body(request);
  const row = await env.DB.prepare('SELECT password_hash FROM users WHERE id = ?').bind(u.id).first();
  if (!(await verifyPassword(String(b.current_password || ''), row.password_hash))) bad('Current password is incorrect.', 403);
  checkPasswordStrength(b.new_password);
  await env.DB.batch([
    env.DB.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').bind(await hashPassword(b.new_password), u.id),
  ]);
  return json({ ok: true });
});

// Hospital self-registration: creates a PENDING hospital + its login. Not public until an admin approves.
route('POST', '/register', async ({ env, request }) => {
  await rateLimit(env, `register:${clientIp(request)}`, 5, 3600);
  const b = await body(request);
  if (b.website_url) return json({ ok: true });
  const p = parseProfile(b);
  const contactName = str(b.contact_name, 100, { required: true, name: 'Your name' });
  const email = emailAddr(b.account_email, { name: 'Login email' });
  checkPasswordStrength(b.password);
  if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) bad('An account with this email already exists. Try signing in.', 409);
  const t = now();
  const slug = await uniqueSlug(env, `${p.name}-${p.area}`);
  const hash = await hashPassword(b.password);
  const codes = await validCodes(env, Array.isArray(b.specialties) ? b.specialties : []);
  const ins = await env.DB.prepare(
    `INSERT INTO hospitals (slug,status,${profileCols.join(',')},created_at,updated_at)
     VALUES (?,'pending',${profileCols.map(() => '?').join(',')},?,?)`)
    .bind(slug, ...profileCols.map((c) => p[c]), t, t).run();
  const hid = ins.meta.last_row_id;
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (email,password_hash,role,hospital_id,name,created_at) VALUES (?,?,?,?,?,?)').bind(email, hash, 'hospital', hid, contactName, t),
    ...setTagsStmts(env, hid, codes),
  ]);
  return json({ ok: true });
});

// ---------------- hospital dashboard ----------------
route('GET', '/dashboard', async ({ env, request }) => {
  const u = await requireUser(env, request, 'hospital');
  const h = await loadHospital(env, 'WHERE h.id = ?', [u.hospital_id], { includeEmail: true });
  const { results: log } = await env.DB.prepare(
    `SELECT er_status,er_wait_minutes,beds_available,icu_available,ambulance_ready,notes,created_at
       FROM status_log WHERE hospital_id = ? ORDER BY created_at DESC, id DESC LIMIT 30`).bind(u.hospital_id).all();
  return json({ hospital: h, log, user: ctxUser(u) });
});

route('PUT', '/dashboard/profile', async ({ env, request }) => {
  const u = await requireUser(env, request, 'hospital');
  const p = parseProfile(await body(request));
  const cur = await env.DB.prepare('SELECT name,phone,emergency_phone,verified FROM hospitals WHERE id = ?').bind(u.hospital_id).first();
  const sensitive = cur.name !== p.name || cur.phone !== p.phone || (cur.emergency_phone || null) !== (p.emergency_phone || null);
  const reset = cur.verified && sensitive; // changing identity/contact details removes the call-verified badge until re-checked
  await env.DB.prepare(
    `UPDATE hospitals SET ${profileCols.map((c) => `${c} = ?`).join(', ')}, updated_at = ?${reset ? ', verified = 0, verified_at = NULL, needs_review = 1' : ''} WHERE id = ?`)
    .bind(...profileCols.map((c) => p[c]), now(), u.hospital_id).run();
  return json({ ok: true, verification_reset: !!reset });
});

route('PUT', '/dashboard/specialties', async ({ env, request }) => {
  const u = await requireUser(env, request, 'hospital');
  const b = await body(request);
  const codes = await validCodes(env, b.codes || []);
  const cur = await env.DB.prepare('SELECT code FROM hospital_specialties WHERE hospital_id = ? AND on_call = 1').bind(u.hospital_id).all();
  const keep = cur.results.map((r) => r.code).filter((c) => codes.includes(c));
  await env.DB.batch([...setTagsStmts(env, u.hospital_id, codes, keep),
    env.DB.prepare('UPDATE hospitals SET updated_at = ? WHERE id = ?').bind(now(), u.hospital_id)]);
  return json({ ok: true });
});

route('PUT', '/dashboard/status', async ({ env, request }) => {
  const u = await requireUser(env, request, 'hospital');
  const b = await body(request);
  const v = parseLive(b);
  const h = await env.DB.prepare('SELECT status FROM hospitals WHERE id = ?').bind(u.hospital_id).first();
  if (h.status === 'suspended') bad('This hospital is suspended. Contact GoHospital support.', 403);
  const oncall = Array.isArray(b.on_call) ? b.on_call.map(String) : [];
  const stmts = [...liveStmts(env, u.hospital_id, u.id, v),
    env.DB.prepare('UPDATE hospital_specialties SET on_call = 0 WHERE hospital_id = ?').bind(u.hospital_id)];
  if (oncall.length) stmts.push(env.DB.prepare(
    `UPDATE hospital_specialties SET on_call = 1 WHERE hospital_id = ? AND code IN (${oncall.map(() => '?').join(',')})`).bind(u.hospital_id, ...oncall));
  await env.DB.batch(stmts);
  return json({ ok: true, updated_at: now() });
});

adminRoutes(route);

// ---------------- dispatcher ----------------
export async function onRequest({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '') || '/';
  try {
    if (!env.DB) throw new HttpError(500, 'Database is not connected. Bind a D1 database named DB in Cloudflare Pages settings.');
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      if (request.headers.get('x-gh') !== '1') bad('Bad request.', 403);
      const origin = request.headers.get('origin');
      if (origin && new URL(origin).host !== url.host) bad('Cross-site requests are not allowed.', 403);
    }
    for (const r of routes) {
      if (r.method !== request.method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params = {}; r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return await r.handler({ env, request, url, params });
    }
    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...(e.extra || {}) }, e.status);
    console.error(e && e.stack ? e.stack : e);
    return json({ error: 'Something went wrong on our side. Please try again.' }, 500);
  }
}
