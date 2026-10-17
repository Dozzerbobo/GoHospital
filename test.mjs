// Integration test against a running local server:  npm run dev   (then)  npm test
// Needs a FRESH local database and SETUP_KEY=testkey123 in .dev.vars
const BASE = process.env.BASE || 'http://localhost:8788';
let pass = 0, fail = 0;
const jar = {};
async function call(who, method, path, body) {
  const headers = { 'content-type': 'application/json', 'x-gh': '1' };
  if (jar[who]) headers.cookie = jar[who];
  const res = await fetch(BASE + '/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const sc = res.headers.get('set-cookie');
  if (sc) jar[who] = sc.split(';')[0];
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data };
}
const ok = (name, cond, extra) => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(extra)}`); };

const profile = (o = {}) => ({ name: 'Test General Hospital', type: 'general', ownership: 'private', address: '1 Test Road', area: 'GRA Phase 2', phone: '+234 803 000 0000', emergency_24h: true, open_24h: true, ambulance: true, lat: 4.82, lng: 7.03, ...o });

let r = await call('anon', 'GET', '/auth/setup-needed'); ok('setup needed on fresh db', r.data?.needed === true, r);
r = await call('anon', 'POST', '/auth/setup', { setup_key: 'wrong', email: 'a@b.co', password: 'longenoughpass1' }); ok('setup rejects wrong key', r.status === 403, r);
r = await call('anon', 'POST', '/auth/setup', { setup_key: 'testkey123', email: 'admin@test.co', password: 'longenoughpass1', name: 'Admin' }); ok('setup creates admin', r.status === 200, r);
r = await call('anon', 'POST', '/auth/setup', { setup_key: 'testkey123', email: 'x@test.co', password: 'longenoughpass1' }); ok('setup locked afterwards', r.status === 403, r);

r = await fetch(BASE + '/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' } }); ok('CSRF header required', r.status === 403);
r = await call('admin', 'POST', '/auth/login', { email: 'admin@test.co', password: 'nope' }); ok('bad password rejected', r.status === 401, r);
r = await call('admin', 'POST', '/auth/login', { email: 'admin@test.co', password: 'longenoughpass1' }); ok('admin login', r.status === 200 && r.data.user.role === 'admin', r);
r = await call('anon', 'GET', '/admin/overview'); ok('admin API blocked when signed out', r.status === 401, r);

// hospital applies
r = await call('anon', 'POST', '/register', { ...profile(), contact_name: 'Dr Test', account_email: 'hosp@test.co', password: 'hospitalpass123', specialties: ['cardiology', 'icu'] }); ok('hospital registers', r.status === 200, r);
r = await call('anon', 'POST', '/register', { ...profile(), contact_name: 'Dr Test', account_email: 'hosp@test.co', password: 'hospitalpass123' }); ok('duplicate email rejected', r.status === 409, r);
r = await call('anon', 'GET', '/hospitals'); ok('pending hospital NOT public', r.data.hospitals.length === 0, r.data);

r = await call('hosp', 'POST', '/auth/login', { email: 'hosp@test.co', password: 'hospitalpass123' }); ok('hospital login', r.status === 200 && r.data.user.role === 'hospital', r);
r = await call('hosp', 'GET', '/admin/overview'); ok('hospital cannot use admin API', r.status === 403, r);
r = await call('hosp', 'PUT', '/dashboard/status', { er_status: 'open', er_wait_minutes: 20, beds_available: 5, icu_available: 1, ambulance_ready: true, notes: 'All good', on_call: ['cardiology'] }); ok('hospital posts live status', r.status === 200, r);
r = await call('hosp', 'PUT', '/dashboard/status', { er_status: 'bogus' }); ok('invalid status rejected', r.status === 400, r);
r = await call('hosp', 'PUT', '/dashboard/status', { er_status: 'open', beds_available: -3 }); ok('negative beds rejected', r.status === 400, r);

r = await call('admin', 'GET', '/admin/hospitals?status=pending'); const hid = r.data.hospitals[0]?.id; ok('admin sees pending application', !!hid, r.data);
r = await call('admin', 'PATCH', `/admin/hospitals/${hid}`, { status: 'active', verified: true }); ok('admin approves + verifies', r.status === 200, r);
r = await call('anon', 'GET', '/hospitals'); ok('approved hospital is public', r.data.hospitals.length === 1 && r.data.hospitals[0].verified === true, r.data);
const slug = r.data.hospitals[0]?.slug;
ok('live status visible + fresh', r.data.hospitals[0]?.live?.fresh === true && r.data.hospitals[0].live.er_status === 'open');
ok('on-call flag exposed', r.data.hospitals[0]?.specialties.find((s) => s.code === 'cardiology')?.on_call === true);
r = await call('anon', 'GET', '/hospitals?q=chest%20pain'); ok('symptom search maps chest pain -> heart', r.data.hospitals.length === 1 && r.data.matched.includes('cardiology'), r.data);
r = await call('anon', 'GET', '/hospitals?q=pregnant'); ok('search excludes non-matching specialty', r.data.hospitals.length === 0, r.data);
r = await call('anon', 'GET', '/hospitals?emergency=1&lat=4.8&lng=7.0'); ok('emergency + distance', r.data.hospitals[0]?.distance_km >= 0, r.data);
r = await call('anon', 'GET', `/hospitals/${slug}`); ok('detail page data', r.status === 200 && !('email' in r.data.hospital), r);

r = await call('hosp', 'PUT', '/dashboard/profile', profile({ phone: '+234 803 111 2222' })); ok('changing phone resets verification', r.data?.verification_reset === true, r);
r = await call('anon', 'GET', `/hospitals/${slug}`); ok('badge removed after phone change', r.data.hospital.verified === false, r.data);
r = await call('admin', 'PATCH', `/admin/hospitals/${hid}`, { status: 'suspended' });
r = await call('hosp', 'PUT', '/dashboard/status', { er_status: 'busy' }); ok('suspended hospital cannot post status', r.status === 403, r);
r = await call('anon', 'GET', '/hospitals'); ok('suspended hidden from public', r.data.hospitals.length === 0);

r = await call('admin', 'POST', '/admin/hospitals', { ...profile({ name: 'Admin Added Clinic', area: 'Rumuola' }), specialties: ['maternal'], login_email: 'clinic@test.co' }); ok('admin creates hospital + login', r.status === 200 && r.data.login?.temp_password, r);
const temp = r.data.login?.temp_password;
r = await call('clinic', 'POST', '/auth/login', { email: 'clinic@test.co', password: temp }); ok('temp password works', r.status === 200 && r.data.user.must_change_password === true, r);
r = await call('clinic', 'POST', '/auth/password', { current_password: temp, new_password: 'short' }); ok('weak password rejected', r.status === 400, r);
r = await call('clinic', 'POST', '/auth/password', { current_password: temp, new_password: 'a-much-better-pass9' }); ok('password change', r.status === 200, r);

r = await call('admin', 'POST', '/admin/import', { rows: [
  { name: 'Import One', area: 'Diobu', address: 'Somewhere', phone: '0803 111 1111', specialties: 'Heart;Eye care;Nonsense' },
  { name: 'Import One', area: 'Diobu', address: 'Somewhere', phone: '0803 111 1111' },
  { name: '', area: 'x' },
] }); ok('CSV import: 1 created, 1 skipped dup, errors reported', r.data.created === 1 && r.data.skipped === 1 && r.data.errors.length >= 2, r.data);

r = await call('anon', 'POST', '/contact', { name: 'A', email: 'a@b.co', message: 'hi' }); ok('contact form stores message', r.status === 200, r);
r = await call('admin', 'GET', '/admin/messages'); ok('admin reads message', r.data.messages.length === 1, r.data);
r = await call('admin', 'POST', '/auth/logout'); r = await call('admin', 'GET', '/admin/overview'); ok('logout kills session', r.status === 401, r);
r = await call('anon', 'POST', '/auth/login', { email: "x' OR 1=1 --@a.co", password: 'x' }); ok('SQL-injection-style input handled', r.status === 400 || r.status === 401, r);

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
