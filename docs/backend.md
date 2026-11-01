# Attendance backend

Cloudflare Workers + D1 + R2. The production Worker, including its APIs, is protected by Cloudflare Access (campus network bypass or an allowed campus email login). Reader scan APIs additionally authenticate against hashed API keys stored in D1.

## Schema

- members: student_id, display_name, note, sound object key
- api_keys: hashed token, prefix, revoke timestamp, last used
- visits: enter/leave events keyed by student_id

Scan toggles enter/leave from the last visit in the current session, starting at
02:00 JST. An earlier unclosed enter is treated as departed; the first scan after
the cutoff records a new enter. Midnight alone does not end the session. Automatic
departure is derived from the timestamp, without synthetic visit records or Slack
notifications, so the visit history continues to represent actual scans.

The dashboard summary includes `todayEnterMembers` (unique people with an enter
since 00:00 JST) and `presentMembers` (the current session's present list), alongside
the existing counts. They describe today/current presence independently of the
selected historical month. Names fall back to student IDs. The current-month view
reuses its existing history query; a historical-month view needs one additional
date-indexed query for today's entries. Presence is queried only once per dashboard
request and reused for both its count and names.

`generatedAt` and `refreshAt` tell the dashboard when to refresh at the next civil
midnight or 02:00 session boundary. The browser sets one timer from the server's
relative interval; it does not continuously poll the monthly history.

## Attendance reads and caching

`listPresent` uses the existing `visits_occurred_at_idx` date range index and
`visits_student_occurred_idx` to check for newer events with `NOT EXISTS`. It does
not aggregate the entire visit history on every poll. No schema migration is needed.

Only `GET /api/present` opts into Workers Cache. Its shared TTL is at most 60
seconds, capped at the next 02:00 JST session boundary. Browser/device responses
have `max-age=0`; the shared cache uses `s-maxage`. Successful scans, member edits,
and member deletes purge the `attendance-present` tag globally before returning.
The scan response itself is uncached and includes a fresh present list. If purge
fails, the committed mutation still succeeds and the old list expires within the
TTL. Environments without `ctx.cache` stay uncached.

The tablet polls every 30 seconds, uses the scan response instead of fetching
again, and ignores polls that started before a newer scan response. Older installed
APKs still benefit from the server cache and optimized SQL; updating the APK is
required for the client request reduction.

Run the Worker regression checks with:

    npm run types
    npx tsc --noEmit
    npm test

Sounds:

- default enter/leave: sounds/default/{enter|leave}
- member custom enter/leave: sounds/members/{studentId}/{enter|leave}
- scan returns the member custom sound if set, otherwise the default sound for that event

## Local

    cd worker
    npm install
    npx wrangler d1 migrations apply lab-attendance --local
    npx wrangler dev

Open http://127.0.0.1:8787 for the monthly dashboard and /settings/ for members, default sounds, and API keys.

## Remote

Account: Manabe.lab.sit@gmail.com (04392c9375dae7b8e36ab02906af2fde)
D1: lab-attendance / b5e5b028-42f3-4279-b9dd-850f4ffd57ec
R2 bucket name: lab-attendance-sounds

R2 must be enabled once in the Cloudflare dashboard before bucket creation/deploy can succeed.

    npx wrangler d1 migrations apply lab-attendance --remote
    npx wrangler deploy

## Android app

Set gradle properties or env vars, then rebuild:

    LAB_API_BASE_URL=https://lab-attendance.<workers-subdomain>
    LAB_API_KEY=ltn_...
    LAB_DEVICE_ID=tablet-1
