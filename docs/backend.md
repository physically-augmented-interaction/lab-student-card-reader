# Attendance backend

Cloudflare Workers + D1 + R2. Web UI is intended to sit behind Cloudflare Access later. Reader APIs are authenticated with multiple hashed API keys stored in D1.

## Schema

- members: student_id, display_name, note, sound object key
- api_keys: hashed token, prefix, revoke timestamp, last used
- visits: enter/leave events keyed by student_id

Scan toggles enter/leave from the last visit. Sounds are stored in R2 as sounds/{studentId}.

## Local

    cd worker
    npm install
    npx wrangler d1 migrations apply lab-attendance --local
    npx wrangler dev

Open http://127.0.0.1:8787 to manage names, sounds, monthly dashboard, and API keys.

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
