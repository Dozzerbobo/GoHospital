import { bad, now, str, phone, url, int, coord, flag, oneOf, emailAddr, HOSPITAL_TYPES, OWNERSHIPS, ER_STATUSES } from './util.js';

export const FRESH_SECONDS = 24 * 3600;

export function publicHospital(r, tags, { includeEmail = false } = {}) {
  const t = now();
  const mine = tags.get(r.id) || [];
  const h = {
    id: r.id, slug: r.slug, name: r.name, type: r.type, ownership: r.ownership,
    status: r.status, verified: !!r.verified, verified_at: r.verified_at,
    address: r.address, area: r.area, city: r.city, state: r.state, lat: r.lat, lng: r.lng,
    phone: r.phone, emergency_phone: r.emergency_phone, website: r.website,
    description: r.description, hours: r.hours,
    emergency_24h: !!r.emergency_24h, open_24h: !!r.open_24h, ambulance: !!r.ambulance,
    accepts_insurance: !!r.accepts_insurance, insurance_notes: r.insurance_notes,
    beds_total: r.beds_total, icu_total: r.icu_total,
    specialties: mine.filter((x) => x.kind === 'specialty').map((x) => ({ code: x.code, label: x.label, on_call: !!x.on_call })),
    capabilities: mine.filter((x) => x.kind === 'capability').map((x) => ({ code: x.code, label: x.label })),
    live: r.er_status ? {
      er_status: r.er_status, er_wait_minutes: r.er_wait_minutes, beds_available: r.beds_available,
      icu_available: r.icu_available, ambulance_ready: r.ambulance_ready === null ? null : !!r.ambulance_ready,
      notes: r.live_notes, updated_at: r.live_updated_at, fresh: t - r.live_updated_at < FRESH_SECONDS,
    } : null,
  };
  if (includeEmail) { h.email = r.email; h.needs_review = !!r.needs_review; }
  return h;
}

const SELECT_H = `SELECT h.*, s.er_status, s.er_wait_minutes, s.beds_available, s.icu_available, s.ambulance_ready,
  s.notes AS live_notes, s.updated_at AS live_updated_at
  FROM hospitals h LEFT JOIN hospital_status s ON s.hospital_id = h.id`;

export async function loadTags(env, ids) {
  const map = new Map();
  const { results } = await env.DB.prepare(
    `SELECT hs.hospital_id, hs.on_call, sp.code, sp.label, sp.kind FROM hospital_specialties hs
       JOIN specialties sp ON sp.code = hs.code ORDER BY sp.sort`).all();
  const want = ids ? new Set(ids) : null;
  for (const r of results) {
    if (want && !want.has(r.hospital_id)) continue;
    if (!map.has(r.hospital_id)) map.set(r.hospital_id, []);
    map.get(r.hospital_id).push(r);
  }
  return map;
}
export async function loadHospitals(env, { where = '', params = [], includeEmail = false } = {}) {
  const { results } = await env.DB.prepare(`${SELECT_H} ${where} ORDER BY h.name`).bind(...params).all();
  const tags = await loadTags(env);
  return results.map((r) => publicHospital(r, tags, { includeEmail }));
}
export async function loadHospital(env, where, params, opts) {
  const r = await env.DB.prepare(`${SELECT_H} ${where}`).bind(...params).first();
  if (!r) return null;
  return publicHospital(r, await loadTags(env, [r.id]), opts);
}

const km = (a, b, c, d) => {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLng = (d - b) * rad;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
};

export async function searchHospitals(env, qs) {
  const all = await loadHospitals(env, { where: "WHERE h.status = 'active'" });
  const { results: sps } = await env.DB.prepare('SELECT code,label,kind,keywords FROM specialties WHERE active = 1').all();
  const q = (qs.get('q') || '').trim().toLowerCase();
  const spec = (qs.get('specialty') || '').split(',').filter(Boolean);
  const area = (qs.get('area') || '').trim().toLowerCase();
  const emergency = qs.get('emergency') === '1';
  const open24 = qs.get('open24') === '1';
  const verifiedOnly = qs.get('verified') === '1';
  const lat = Number(qs.get('lat')), lng = Number(qs.get('lng'));
  const hasPos = qs.has('lat') && qs.has('lng') && Number.isFinite(lat) && Number.isFinite(lng);

  const matched = new Set(spec);
  let textMatch = false;
  if (q) {
    for (const s of sps) {
      const words = s.keywords.split(',').map((w) => w.trim()).filter(Boolean);
      if (s.label.toLowerCase().includes(q) || q.includes(s.label.toLowerCase()) ||
          words.some((w) => q.includes(w) || (q.length > 2 && w.includes(q)))) matched.add(s.code);
    }
    textMatch = true;
  }
  const rank = { open: 0, busy: 1, diversion: 2, closed: 3 };
  let out = [];
  for (const h of all) {
    const codes = new Set([...h.specialties, ...h.capabilities].map((x) => x.code));
    let score = 0;
    if (matched.size) {
      let hit = 0; for (const c of matched) if (codes.has(c)) { hit++; if (h.specialties.find((s) => s.code === c)?.on_call && h.live?.fresh) score += 5; }
      if (!hit && !(textMatch && `${h.name} ${h.area || ''} ${h.address || ''}`.toLowerCase().includes(q))) continue;
      score += hit * 20;
    } else if (textMatch && q) {
      if (!`${h.name} ${h.area || ''} ${h.address || ''} ${h.type}`.toLowerCase().includes(q)) continue;
      score += 10;
    }
    if (spec.length && !spec.every((c) => codes.has(c))) continue;
    if (area && !(h.area || '').toLowerCase().includes(area)) continue;
    if (emergency && !h.emergency_24h) continue;
    if (open24 && !h.open_24h) continue;
    if (verifiedOnly && !h.verified) continue;
    if (hasPos && h.lat != null && h.lng != null) h.distance_km = Math.round(km(lat, lng, h.lat, h.lng) * 10) / 10;
    h._score = score;
    out.push(h);
  }
  out.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    if (emergency) {
      const ra = a.live?.fresh ? rank[a.live.er_status] : 1.5, rb = b.live?.fresh ? rank[b.live.er_status] : 1.5;
      if (ra !== rb) return ra - rb;
    }
    if (hasPos && (a.distance_km != null || b.distance_km != null)) {
      if (a.distance_km == null) return 1; if (b.distance_km == null) return -1;
      if (a.distance_km !== b.distance_km) return a.distance_km - b.distance_km;
    }
    if (a.verified !== b.verified) return a.verified ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  out.forEach((h) => delete h._score);
  return { matched: [...matched], hospitals: out };
}

// ---------- validation shared by dashboard + admin ----------
export function parseProfile(b) {
  return {
    name: str(b.name, 120, { required: true, name: 'Hospital name' }),
    type: oneOf(b.type || 'general', HOSPITAL_TYPES, 'Hospital type'),
    ownership: oneOf(b.ownership || 'private', OWNERSHIPS, 'Ownership'),
    address: str(b.address, 240, { required: true, name: 'Address' }),
    area: str(b.area, 80, { required: true, name: 'Area / neighbourhood' }),
    city: str(b.city || 'Port Harcourt', 80, { name: 'City' }) || 'Port Harcourt',
    state: str(b.state || 'Rivers', 80, { name: 'State' }) || 'Rivers',
    lat: coord(b.lat, -90, 90, 'Latitude'),
    lng: coord(b.lng, -180, 180, 'Longitude'),
    phone: phone(b.phone, { required: true, name: 'Main phone' }),
    emergency_phone: phone(b.emergency_phone, { name: 'Emergency phone' }),
    email: emailAddr(b.email, { required: false, name: 'Public email' }),
    website: url(b.website),
    description: str(b.description, 1200, { name: 'Description' }),
    hours: str(b.hours, 200, { name: 'Opening hours' }),
    emergency_24h: flag(b.emergency_24h), open_24h: flag(b.open_24h), ambulance: flag(b.ambulance),
    accepts_insurance: flag(b.accepts_insurance),
    insurance_notes: str(b.insurance_notes, 300, { name: 'Insurance notes' }),
    beds_total: int(b.beds_total, { max: 10000, name: 'Total beds' }),
    icu_total: int(b.icu_total, { max: 2000, name: 'Total ICU beds' }),
  };
}
const PROFILE_COLS = ['name','type','ownership','address','area','city','state','lat','lng','phone','emergency_phone','email','website','description','hours','emergency_24h','open_24h','ambulance','accepts_insurance','insurance_notes','beds_total','icu_total'];
export const profileCols = PROFILE_COLS;

export async function validCodes(env, list) {
  if (!Array.isArray(list)) bad('Specialties must be a list.');
  const uniq = [...new Set(list.map(String))];
  if (uniq.length > 60) bad('Too many selections.');
  if (!uniq.length) return [];
  const { results } = await env.DB.prepare(
    `SELECT code FROM specialties WHERE active = 1 AND code IN (${uniq.map(() => '?').join(',')})`).bind(...uniq).all();
  const ok = new Set(results.map((r) => r.code));
  const missing = uniq.filter((c) => !ok.has(c));
  if (missing.length) bad(`Unknown specialty: ${missing[0]}`);
  return uniq;
}
export function setTagsStmts(env, hospitalId, codes, onCall = []) {
  const oc = new Set(onCall);
  return [
    env.DB.prepare('DELETE FROM hospital_specialties WHERE hospital_id = ?').bind(hospitalId),
    ...codes.map((c) => env.DB.prepare('INSERT INTO hospital_specialties (hospital_id,code,on_call) VALUES (?,?,?)').bind(hospitalId, c, oc.has(c) ? 1 : 0)),
  ];
}
export function parseLive(b) {
  const status = oneOf(b.er_status, ER_STATUSES, 'Emergency status');
  return {
    er_status: status,
    er_wait_minutes: int(b.er_wait_minutes, { max: 1440, name: 'ER wait' }),
    beds_available: int(b.beds_available, { max: 10000, name: 'Beds available' }),
    icu_available: int(b.icu_available, { max: 2000, name: 'ICU beds available' }),
    ambulance_ready: b.ambulance_ready === null || b.ambulance_ready === undefined || b.ambulance_ready === '' ? null : flag(b.ambulance_ready),
    notes: str(b.notes, 280, { name: 'Notes' }),
  };
}
export function liveStmts(env, hospitalId, userId, v) {
  const t = now();
  return [
    env.DB.prepare(`INSERT INTO hospital_status (hospital_id,er_status,er_wait_minutes,beds_available,icu_available,ambulance_ready,notes,updated_at,updated_by)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(hospital_id) DO UPDATE SET er_status=excluded.er_status, er_wait_minutes=excluded.er_wait_minutes,
        beds_available=excluded.beds_available, icu_available=excluded.icu_available, ambulance_ready=excluded.ambulance_ready,
        notes=excluded.notes, updated_at=excluded.updated_at, updated_by=excluded.updated_by`)
      .bind(hospitalId, v.er_status, v.er_wait_minutes, v.beds_available, v.icu_available, v.ambulance_ready, v.notes, t, userId),
    env.DB.prepare(`INSERT INTO status_log (hospital_id,user_id,er_status,er_wait_minutes,beds_available,icu_available,ambulance_ready,notes,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).bind(hospitalId, userId, v.er_status, v.er_wait_minutes, v.beds_available, v.icu_available, v.ambulance_ready, v.notes, t),
  ];
}
