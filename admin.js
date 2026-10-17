import { bad, json, now, str, emailAddr, body, flag, int, oneOf, uniqueSlug, slugify } from './util.js';
import { requireUser, hashPassword, tempPassword, checkPasswordStrength } from './auth.js';
import { loadHospitals, loadHospital, parseProfile, profileCols, validCodes, setTagsStmts, parseLive, liveStmts } from './hospitals.js';

export function adminRoutes(route) {
  const admin = (env, request) => requireUser(env, request, 'admin');

  route('GET', '/admin/overview', async ({ env, request }) => {
    await admin(env, request);
    const q = (sql) => env.DB.prepare(sql).first();
    const h = await q("SELECT SUM(status='pending') pending, SUM(status='active') active, SUM(status='suspended') suspended, SUM(verified) verified, COUNT(*) total FROM hospitals");
    const stale = await env.DB.prepare(
      `SELECT COUNT(*) n FROM hospitals h LEFT JOIN hospital_status s ON s.hospital_id=h.id
        WHERE h.status='active' AND (s.updated_at IS NULL OR s.updated_at < ?)`).bind(now() - 86400).first();
    const m = await q('SELECT COUNT(*) n FROM contact_messages WHERE handled = 0');
    const u = await q("SELECT COUNT(*) n FROM users WHERE role='hospital'");
    return json({ hospitals: h, stale_status: stale.n, unread_messages: m.n, hospital_users: u.n });
  });

  route('GET', '/admin/hospitals', async ({ env, request, url }) => {
    await admin(env, request);
    const status = url.searchParams.get('status');
    const where = ['pending', 'active', 'suspended'].includes(status) ? 'WHERE h.status = ?' : '';
    const hospitals = await loadHospitals(env, { where, params: where ? [status] : [], includeEmail: true });
    const { results: users } = await env.DB.prepare(
      "SELECT id,email,hospital_id,name,disabled,last_login FROM users WHERE role='hospital'").all();
    const byH = {}; users.forEach((x) => (byH[x.hospital_id] = byH[x.hospital_id] || []).push(x));
    hospitals.forEach((h) => (h.users = byH[h.id] || []));
    return json({ hospitals });
  });

  route('GET', '/admin/hospitals/:id', async ({ env, request, params }) => {
    await admin(env, request);
    const h = await loadHospital(env, 'WHERE h.id = ?', [Number(params.id)], { includeEmail: true });
    if (!h) bad('Hospital not found.', 404);
    return json({ hospital: h });
  });

  // Create a hospital directly (already approved). Optionally create its login and return a one-time temporary password.
  route('POST', '/admin/hospitals', async ({ env, request }) => {
    const me = await admin(env, request);
    const b = await body(request);
    const p = parseProfile(b);
    const codes = await validCodes(env, b.specialties || []);
    const t = now();
    const slug = await uniqueSlug(env, `${p.name}-${p.area}`);
    const status = oneOf(b.status || 'active', ['pending', 'active', 'suspended'], 'Status');
    const ins = await env.DB.prepare(
      `INSERT INTO hospitals (slug,status,verified,verified_at,${profileCols.join(',')},created_at,updated_at)
       VALUES (?,?,?,?,${profileCols.map(() => '?').join(',')},?,?)`)
      .bind(slug, status, flag(b.verified), flag(b.verified) ? t : null, ...profileCols.map((c) => p[c]), t, t).run();
    const hid = ins.meta.last_row_id;
    await env.DB.batch(setTagsStmts(env, hid, codes));
    let login = null;
    if (b.login_email) {
      const email = emailAddr(b.login_email, { name: 'Login email' });
      if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) bad('That login email is already in use.', 409);
      const temp = tempPassword();
      await env.DB.prepare('INSERT INTO users (email,password_hash,role,hospital_id,name,must_change_password,created_at) VALUES (?,?,?,?,?,1,?)')
        .bind(email, await hashPassword(temp), 'hospital', hid, str(b.login_name, 100, { name: 'Contact name' }), t).run();
      login = { email, temp_password: temp };
    }
    return json({ ok: true, id: hid, slug, login });
  });

  route('PUT', '/admin/hospitals/:id', async ({ env, request, params }) => {
    await admin(env, request);
    const id = Number(params.id);
    const b = await body(request);
    const p = parseProfile(b);
    const codes = await validCodes(env, b.specialties || []);
    const exists = await env.DB.prepare('SELECT id FROM hospitals WHERE id = ?').bind(id).first();
    if (!exists) bad('Hospital not found.', 404);
    const oc = await env.DB.prepare('SELECT code FROM hospital_specialties WHERE hospital_id = ? AND on_call = 1').bind(id).all();
    await env.DB.batch([
      env.DB.prepare(`UPDATE hospitals SET ${profileCols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`)
        .bind(...profileCols.map((c) => p[c]), now(), id),
      ...setTagsStmts(env, id, codes, oc.results.map((r) => r.code).filter((c) => codes.includes(c))),
    ]);
    return json({ ok: true });
  });

  // Approve / verify / suspend
  route('PATCH', '/admin/hospitals/:id', async ({ env, request, params }) => {
    await admin(env, request);
    const id = Number(params.id);
    const b = await body(request);
    const sets = [], vals = [];
    if (b.status !== undefined) { sets.push('status = ?'); vals.push(oneOf(b.status, ['pending', 'active', 'suspended'], 'Status')); }
    if (b.verified !== undefined) {
      const v = flag(b.verified);
      sets.push('verified = ?', 'verified_at = ?', 'needs_review = 0'); vals.push(v, v ? now() : null);
    }
    if (!sets.length) bad('Nothing to update.');
    const r = await env.DB.prepare(`UPDATE hospitals SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`).bind(...vals, now(), id).run();
    if (!r.meta.changes) bad('Hospital not found.', 404);
    return json({ ok: true });
  });

  route('DELETE', '/admin/hospitals/:id', async ({ env, request, params }) => {
    await admin(env, request);
    const id = Number(params.id);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM users WHERE hospital_id = ?').bind(id),
      env.DB.prepare('DELETE FROM hospitals WHERE id = ?').bind(id),
    ]);
    return json({ ok: true });
  });

  // Admin can post a status on behalf of a hospital (e.g. after a phone call)
  route('PUT', '/admin/hospitals/:id/status', async ({ env, request, params }) => {
    const me = await admin(env, request);
    const id = Number(params.id);
    const v = parseLive(await body(request));
    if (!(await env.DB.prepare('SELECT 1 FROM hospitals WHERE id = ?').bind(id).first())) bad('Hospital not found.', 404);
    await env.DB.batch(liveStmts(env, id, me.id, v));
    return json({ ok: true });
  });

  route('POST', '/admin/hospitals/:id/login', async ({ env, request, params }) => {
    await admin(env, request);
    const id = Number(params.id);
    const b = await body(request);
    const email = emailAddr(b.email, { name: 'Login email' });
    if (!(await env.DB.prepare('SELECT 1 FROM hospitals WHERE id = ?').bind(id).first())) bad('Hospital not found.', 404);
    if (await env.DB.prepare('SELECT 1 FROM users WHERE email = ?').bind(email).first()) bad('That email is already in use.', 409);
    const temp = tempPassword();
    await env.DB.prepare('INSERT INTO users (email,password_hash,role,hospital_id,name,must_change_password,created_at) VALUES (?,?,?,?,?,1,?)')
      .bind(email, await hashPassword(temp), 'hospital', id, str(b.name, 100, { name: 'Name' }), now()).run();
    return json({ ok: true, email, temp_password: temp });
  });

  route('POST', '/admin/users/:id/reset', async ({ env, request, params }) => {
    await admin(env, request);
    const temp = tempPassword();
    const r = await env.DB.prepare("UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ? AND role = 'hospital'")
      .bind(await hashPassword(temp), Number(params.id)).run();
    if (!r.meta.changes) bad('User not found.', 404);
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(Number(params.id)).run();
    return json({ ok: true, temp_password: temp });
  });

  route('PATCH', '/admin/users/:id', async ({ env, request, params }) => {
    await admin(env, request);
    const b = await body(request);
    const id = Number(params.id);
    const r = await env.DB.prepare("UPDATE users SET disabled = ? WHERE id = ? AND role = 'hospital'").bind(flag(b.disabled), id).run();
    if (!r.meta.changes) bad('User not found.', 404);
    if (flag(b.disabled)) await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id).run();
    return json({ ok: true });
  });

  // Bulk import: rows already parsed from CSV by the browser
  route('POST', '/admin/import', async ({ env, request }) => {
    await admin(env, request);
    const b = await body(request);
    const rows = Array.isArray(b.rows) ? b.rows : bad('No rows to import.');
    if (rows.length > 500) bad('Import at most 500 rows at a time.');
    const { results: sps } = await env.DB.prepare('SELECT code,label FROM specialties').all();
    const lookup = new Map();
    sps.forEach((s) => { lookup.set(s.code.toLowerCase(), s.code); lookup.set(s.label.toLowerCase(), s.code); });
    let created = 0, skipped = 0; const errors = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i] || {};
      try {
        const p = parseProfile({ ...r, type: (r.type || 'general').toLowerCase(), ownership: (r.ownership || 'private').toLowerCase() });
        const slug = slugify(`${p.name}-${p.area}`);
        if (await env.DB.prepare('SELECT 1 FROM hospitals WHERE slug = ? OR (lower(name) = lower(?) AND lower(area) = lower(?))').bind(slug, p.name, p.area).first()) { skipped++; continue; }
        const names = String(r.specialties || '').split(/[;|]/).map((x) => x.trim().toLowerCase()).filter(Boolean);
        const codes = [...new Set(names.map((n) => lookup.get(n)).filter(Boolean))];
        const unknown = names.filter((n) => !lookup.get(n));
        const t = now();
        const ins = await env.DB.prepare(
          `INSERT INTO hospitals (slug,status,verified,${profileCols.join(',')},created_at,updated_at)
           VALUES (?,'active',0,${profileCols.map(() => '?').join(',')},?,?)`)
          .bind(await uniqueSlug(env, `${p.name}-${p.area}`), ...profileCols.map((c) => p[c]), t, t).run();
        await env.DB.batch(setTagsStmts(env, ins.meta.last_row_id, codes));
        created++;
        if (unknown.length) errors.push({ row: i + 2, error: `Imported, but unknown specialties ignored: ${unknown.join(', ')}` });
      } catch (e) { errors.push({ row: i + 2, error: e.message || 'Invalid row' }); }
    }
    return json({ created, skipped, errors });
  });

  route('GET', '/admin/messages', async ({ env, request }) => {
    await admin(env, request);
    const { results } = await env.DB.prepare('SELECT * FROM contact_messages ORDER BY created_at DESC LIMIT 200').all();
    return json({ messages: results });
  });
  route('PATCH', '/admin/messages/:id', async ({ env, request, params }) => {
    await admin(env, request);
    const b = await body(request);
    await env.DB.prepare('UPDATE contact_messages SET handled = ? WHERE id = ?').bind(flag(b.handled), Number(params.id)).run();
    return json({ ok: true });
  });

  // Specialty / capability catalogue
  route('GET', '/admin/specialties', async ({ env, request }) => {
    await admin(env, request);
    const { results } = await env.DB.prepare('SELECT * FROM specialties ORDER BY kind DESC, sort').all();
    return json({ specialties: results });
  });
  route('POST', '/admin/specialties', async ({ env, request }) => {
    await admin(env, request);
    const b = await body(request);
    const label = str(b.label, 80, { required: true, name: 'Label' });
    const code = slugify(b.code || label).replace(/-/g, '_');
    const kind = oneOf(b.kind, ['specialty', 'capability'], 'Kind');
    if (await env.DB.prepare('SELECT 1 FROM specialties WHERE code = ?').bind(code).first()) bad('That code already exists.', 409);
    await env.DB.prepare('INSERT INTO specialties (code,label,kind,keywords,description,sort) VALUES (?,?,?,?,?,?)')
      .bind(code, label, kind, (str(b.keywords, 500, { name: 'Keywords' }) || '').toLowerCase(), str(b.description, 200, { name: 'Description' }), int(b.sort, { max: 9999 }) ?? 500).run();
    return json({ ok: true, code });
  });
  route('PUT', '/admin/specialties/:code', async ({ env, request, params }) => {
    await admin(env, request);
    const b = await body(request);
    const r = await env.DB.prepare('UPDATE specialties SET label = ?, keywords = ?, description = ?, active = ?, sort = ? WHERE code = ?')
      .bind(str(b.label, 80, { required: true, name: 'Label' }), (str(b.keywords, 500, { name: 'Keywords' }) || '').toLowerCase(),
        str(b.description, 200, { name: 'Description' }), flag(b.active), int(b.sort, { max: 9999 }) ?? 500, params.code).run();
    if (!r.meta.changes) bad('Not found.', 404);
    return json({ ok: true });
  });
}
