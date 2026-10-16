# GoHospital

A real hospital-finder for Nigeria: public search by symptom/specialty with **live emergency status**, **hospital logins and dashboards**, and an **admin panel**. Runs entirely on Cloudflare (Pages + Functions + D1 database) — no servers to manage, free tier is enough to start.

## What's in it

| Who | What they can do |
|---|---|
| **Public** | Search by symptom or specialty, filter (24h emergency, verified, area, equipment), sort by distance, see live ER status / wait / beds / specialists on call, call or get directions. SOS mode (`/find?sos=1`). |
| **Hospital** | Apply at `/for-hospitals`, sign in at `/login`, post live status in seconds, edit profile, specialties & equipment, see update history, change password. |
| **Admin** (`/admin`) | Approve/suspend applications, mark **call-verified**, create/edit hospitals and logins (temp passwords), post a status on a hospital's behalf, **bulk-import from CSV**, read contact messages, manage the specialty/equipment list and symptom keywords. |

Trust rules built in: new hospitals are hidden until an admin approves them; a live status older than 24h is shown as "out of date"; changing a hospital's name or phone removes its call-verified badge until re-checked.

## Deploy (about 15 minutes)

Prerequisites: Node 18+, a Cloudflare account (you already have one with gohospital.online).

```bash
npm install
npx wrangler login

# 1. create the database, then paste the printed database_id into wrangler.toml
npx wrangler d1 create gohospital

# 2. create the tables
npm run db:remote

# 3. deploy — use the SAME project name as your current Pages project so
#    gohospital.online keeps pointing at it (check Workers & Pages for the name)
npx wrangler pages deploy public --project-name gohospital

# 4. private key that protects first-time admin setup
npx wrangler pages secret put SETUP_KEY --project-name gohospital
#    (type a long random string when asked, then deploy once more: step 3)
```

Then open **https://gohospital.online/setup**, enter the setup key, and create your admin account. The page locks itself after the first admin exists.

If step 3 says the project doesn't exist: `npx wrangler pages project create gohospital --production-branch main`, then re-run step 3 and add the domain under *Custom domains*.

### If Cloudflare shows "D1 binding" missing
Workers & Pages → your project → **Settings → Bindings → Add → D1 database** → variable name `DB`, pick `gohospital`. Redeploy.

## Put in your details
- Edit `public/assets/config.js` (contact email, phone, WhatsApp, office) and redeploy. Empty values are hidden.
- Have a lawyer review `public/privacy.html` and `public/terms.html` (templates).

## Getting real data in
1. **Collect** hospital name, area, address, phone, emergency phone, specialties.
2. **Admin → Import CSV** (template download included) or **Hospitals → Add hospital**.
3. Invite hospitals: **Hospitals → Logins** creates an account with a one-time temporary password, or let them apply at `/for-hospitals` and approve them.
4. **Verify by phone**, then **Mark verified**. Only verified hospitals get the badge.

## Operating notes
- **Backups:** `npx wrangler d1 export gohospital --remote --output backup.sql` (do this weekly).
- **Password resets:** Admin → Hospitals → Logins → Reset password (shows a temporary password once). There is no email-based reset yet.
- **Email notifications:** none yet (new applications appear on the admin Overview; check it daily).
- **Local development:** `cp .dev.vars.example .dev.vars`, `npm run db:local`, `npm run dev`, open http://localhost:8788. `npm test` runs 38 API checks against a fresh local database.
- Security: passwords PBKDF2-SHA256, HttpOnly session cookies, CSRF header + origin checks, rate-limited login/registration/contact, strict security headers (`public/_headers`).

## Not built yet (good next steps)
Patient reviews, SMS/WhatsApp alerts when a hospital goes on diversion, email password reset, embedded map, multi-city support, hospital staff roles beyond one-login-per-user.

## Mobile app (PWA + Android APK)
The site is an installable PWA (manifest, service worker, offline page). Users get an "Install app" button on `/app`. For a downloadable Android APK follow `ANDROID.md` (automatic GitHub Actions build + Cloudflare deploy).
