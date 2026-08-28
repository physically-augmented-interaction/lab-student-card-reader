export interface Env {
  DB: D1Database;
  SOUNDS?: R2Bucket;
  ASSETS: Fetcher;
  APP_TIMEZONE: string;
}

type MemberRow = {
  student_id: string;
  display_name: string;
  note: string;
  sound_object_key: string | null;
  sound_content_type: string | null;
  created_at: string;
  updated_at: string;
};

type VisitRow = {
  id: string;
  student_id: string;
  event_type: "enter" | "leave";
  occurred_at: string;
  source: string;
  device_id: string | null;
  idm: string | null;
};

type ApiKeyRow = {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  revoked_at: string | null;
  created_at: string;
  last_used_at: string | null;
};

const encoder = new TextEncoder();

function json(data: unknown, status = 200, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

function badRequest(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function normalizeStudentId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const studentId = value.trim().toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(studentId) ? studentId : null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function tokyoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function tokyoMonthKey(date = new Date()): string {
  const { y, m } = tokyoParts(date);
  return y + "-" + pad(m);
}

function tokyoDayKey(date = new Date()): string {
  const { y, m, d } = tokyoParts(date);
  return y + "-" + pad(m) + "-" + pad(d);
}

function daysInTokyoMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function parseMonth(value: string | null): { year: number; month: number; key: string } {
  const fallback = tokyoMonthKey();
  const raw = value && /^\d{4}-\d{2}$/.test(value) ? value : fallback;
  const [year, month] = raw.split("-").map(Number);
  return { year, month, key: year + "-" + pad(month) };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 24): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function extractBearer(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header && header.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const apiKey = request.headers.get("x-api-key");
  return apiKey ? apiKey.trim() : null;
}

async function requireApiKey(env: Env, request: Request): Promise<ApiKeyRow | Response> {
  const presented = extractBearer(request);
  if (!presented) return badRequest("API key required", 401);
  const hash = await sha256Hex(presented);
  const row = await env.DB.prepare(
    "SELECT id, name, key_hash, key_prefix, revoked_at, created_at, last_used_at FROM api_keys WHERE key_hash = ?",
  )
    .bind(hash)
    .first<ApiKeyRow>();
  if (!row || row.revoked_at) return badRequest("invalid API key", 401);
  await env.DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").bind(nowIso(), row.id).run();
  return row;
}

async function ensureMember(env: Env, studentId: string): Promise<MemberRow> {
  const existing = await env.DB.prepare(
    "SELECT student_id, display_name, note, sound_object_key, sound_content_type, created_at, updated_at FROM members WHERE student_id = ?",
  )
    .bind(studentId)
    .first<MemberRow>();
  if (existing) return existing;
  const createdAt = nowIso();
  await env.DB.prepare(
    "INSERT INTO members (student_id, display_name, note, created_at, updated_at) VALUES (?, '', '', ?, ?)",
  )
    .bind(studentId, createdAt, createdAt)
    .run();
  return {
    student_id: studentId,
    display_name: "",
    note: "",
    sound_object_key: null,
    sound_content_type: null,
    created_at: createdAt,
    updated_at: createdAt,
  };
}

async function lastVisit(env: Env, studentId: string): Promise<VisitRow | null> {
  return env.DB.prepare(
    "SELECT id, student_id, event_type, occurred_at, source, device_id, idm FROM visits WHERE student_id = ? ORDER BY occurred_at DESC LIMIT 1",
  )
    .bind(studentId)
    .first<VisitRow>();
}

function nextEventType(previous: VisitRow | null): "enter" | "leave" {
  return previous && previous.event_type === "enter" ? "leave" : "enter";
}

function memberDto(member: MemberRow) {
  return {
    studentId: member.student_id,
    displayName: member.display_name,
    note: member.note,
    hasSound: Boolean(member.sound_object_key),
    soundContentType: member.sound_content_type,
    createdAt: member.created_at,
    updatedAt: member.updated_at,
  };
}

async function handleScan(env: Env, request: Request): Promise<Response> {
  const auth = await requireApiKey(env, request);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => null)) as {
    studentId?: string;
    idm?: string;
    deviceId?: string;
  } | null;
  const studentId = normalizeStudentId(body ? body.studentId : null);
  if (!studentId) return badRequest("studentId is required");

  const member = await ensureMember(env, studentId);
  const previous = await lastVisit(env, studentId);
  const eventType = nextEventType(previous);
  const occurredAt = nowIso();
  const visitId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO visits (id, student_id, event_type, occurred_at, source, device_id, idm) VALUES (?, ?, ?, ?, 'reader', ?, ?)",
  )
    .bind(visitId, studentId, eventType, occurredAt, body && body.deviceId ? body.deviceId : null, body && body.idm ? body.idm : null)
    .run();

  return json({
    visitId,
    studentId,
    displayName: member.display_name || studentId,
    eventType,
    occurredAt,
    soundUrl: member.sound_object_key ? "/api/members/" + studentId + "/sound" : null,
  });
}

async function listMembers(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT student_id, display_name, note, sound_object_key, sound_content_type, created_at, updated_at FROM members ORDER BY student_id",
  ).all<MemberRow>();
  return json({ members: (result.results || []).map(memberDto) });
}

async function getMember(env: Env, studentId: string): Promise<Response> {
  const member = await env.DB.prepare(
    "SELECT student_id, display_name, note, sound_object_key, sound_content_type, created_at, updated_at FROM members WHERE student_id = ?",
  )
    .bind(studentId)
    .first<MemberRow>();
  if (!member) return badRequest("member not found", 404);
  const last = await lastVisit(env, studentId);
  return json({ member: memberDto(member), lastVisit: last });
}

async function upsertMember(env: Env, studentId: string, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { displayName?: string; note?: string } | null;
  const displayName = body && typeof body.displayName === "string" ? body.displayName.trim() : "";
  const note = body && typeof body.note === "string" ? body.note.trim() : "";
  const existing = await ensureMember(env, studentId);
  const updatedAt = nowIso();
  await env.DB.prepare("UPDATE members SET display_name = ?, note = ?, updated_at = ? WHERE student_id = ?")
    .bind(displayName, note, updatedAt, studentId)
    .run();
  return json({
    member: memberDto({ ...existing, display_name: displayName, note, updated_at: updatedAt }),
  });
}

async function uploadSound(env: Env, studentId: string, request: Request): Promise<Response> {
  if (!env.SOUNDS) return badRequest("R2 is not enabled yet", 503);
  await ensureMember(env, studentId);
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
    return badRequest("audio content-type required");
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return badRequest("empty file");
  if (body.byteLength > 5 * 1024 * 1024) return badRequest("sound must be 5MB or smaller");
  const key = "sounds/" + studentId;
  await env.SOUNDS.put(key, body, { httpMetadata: { contentType } });
  const updatedAt = nowIso();
  await env.DB.prepare(
    "UPDATE members SET sound_object_key = ?, sound_content_type = ?, updated_at = ? WHERE student_id = ?",
  )
    .bind(key, contentType, updatedAt, studentId)
    .run();
  return json({ ok: true, soundUrl: "/api/members/" + studentId + "/sound" });
}

async function getSound(env: Env, studentId: string): Promise<Response> {
  if (!env.SOUNDS) return badRequest("R2 is not enabled yet", 503);
  const member = await env.DB.prepare("SELECT sound_object_key, sound_content_type FROM members WHERE student_id = ?")
    .bind(studentId)
    .first<Pick<MemberRow, "sound_object_key" | "sound_content_type">>();
  if (!member || !member.sound_object_key) return badRequest("sound not found", 404);
  const object = await env.SOUNDS.get(member.sound_object_key);
  if (!object) return badRequest("sound not found", 404);
  const headers = new Headers();
  headers.set("content-type", member.sound_content_type || object.httpMetadata?.contentType || "audio/mpeg");
  headers.set("cache-control", "private, max-age=60");
  return new Response(object.body, { headers });
}

async function dashboard(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const parsed = parseMonth(url.searchParams.get("month"));
  const startLocal = parsed.key + "-01T00:00:00+09:00";
  const nextMonth = parsed.month === 12 ? parsed.year + 1 + "-01" : parsed.year + "-" + pad(parsed.month + 1);
  const endLocal = nextMonth + "-01T00:00:00+09:00";
  const visits = await env.DB.prepare(
    "SELECT v.id, v.student_id, v.event_type, v.occurred_at, v.source, v.device_id, v.idm, COALESCE(m.display_name, '') AS display_name FROM visits v LEFT JOIN members m ON m.student_id = v.student_id WHERE v.occurred_at >= ? AND v.occurred_at < ? ORDER BY v.occurred_at ASC",
  )
    .bind(new Date(startLocal).toISOString(), new Date(endLocal).toISOString())
    .all<VisitRow & { display_name: string }>();

  const rows = visits.results || [];
  const uniqueStudents = new Set(rows.map((row) => row.student_id));
  const enterCount = rows.filter((row) => row.event_type === "enter").length;
  const leaveCount = rows.filter((row) => row.event_type === "leave").length;
  const presentNow = await currentPresentCount(env);
  const lastDay = daysInTokyoMonth(parsed.year, parsed.month);
  const byDay = new Map<string, { date: string; enters: number; leaves: number; uniqueStudents: Set<string> }>();
  const byStudent = new Map<string, { studentId: string; displayName: string; enters: number; leaves: number; lastVisitAt: string }>();

  for (const row of rows) {
    const day = tokyoDayKey(new Date(row.occurred_at));
    if (!byDay.has(day)) byDay.set(day, { date: day, enters: 0, leaves: 0, uniqueStudents: new Set() });
    const dayBucket = byDay.get(day)!;
    if (row.event_type === "enter") dayBucket.enters += 1;
    else dayBucket.leaves += 1;
    dayBucket.uniqueStudents.add(row.student_id);

    if (!byStudent.has(row.student_id)) {
      byStudent.set(row.student_id, {
        studentId: row.student_id,
        displayName: row.display_name || row.student_id,
        enters: 0,
        leaves: 0,
        lastVisitAt: row.occurred_at,
      });
    }
    const studentBucket = byStudent.get(row.student_id)!;
    if (row.event_type === "enter") studentBucket.enters += 1;
    else studentBucket.leaves += 1;
    studentBucket.lastVisitAt = row.occurred_at;
  }

  const daily = [];
  for (let day = 1; day <= lastDay; day += 1) {
    const date = parsed.key + "-" + pad(day);
    const bucket = byDay.get(date);
    daily.push({
      date,
      enters: bucket ? bucket.enters : 0,
      leaves: bucket ? bucket.leaves : 0,
      uniqueStudents: bucket ? bucket.uniqueStudents.size : 0,
    });
  }

  return json({
    month: parsed.key,
    timezone: "Asia/Tokyo",
    summary: {
      uniqueStudents: uniqueStudents.size,
      enterCount,
      leaveCount,
      presentNow,
    },
    daily,
    members: [...byStudent.values()].sort((a, b) => b.enters - a.enters || a.studentId.localeCompare(b.studentId)),
    recent: rows.slice(-20).reverse(),
  });
}

async function currentPresentCount(env: Env): Promise<number> {
  const lastEvents = await env.DB.prepare(
    "SELECT v.student_id, v.event_type FROM visits v JOIN (SELECT student_id, MAX(occurred_at) AS occurred_at FROM visits GROUP BY student_id) latest ON latest.student_id = v.student_id AND latest.occurred_at = v.occurred_at",
  ).all<{ student_id: string; event_type: string }>();
  return (lastEvents.results || []).filter((row) => row.event_type === "enter").length;
}

async function listApiKeys(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT id, name, key_prefix, revoked_at, created_at, last_used_at FROM api_keys ORDER BY created_at DESC",
  ).all<Omit<ApiKeyRow, "key_hash">>();
  return json({ apiKeys: result.results || [] });
}

async function createApiKey(env: Env, request: Request): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { name?: string } | null;
  const name = body && typeof body.name === "string" && body.name.trim() ? body.name.trim() : "reader";
  const secret = "ltn_" + randomToken(24);
  const row = {
    id: crypto.randomUUID(),
    name,
    key_hash: await sha256Hex(secret),
    key_prefix: secret.slice(0, 10),
    created_at: nowIso(),
  };
  await env.DB.prepare("INSERT INTO api_keys (id, name, key_hash, key_prefix, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(row.id, row.name, row.key_hash, row.key_prefix, row.created_at)
    .run();
  return json({
    apiKey: {
      id: row.id,
      name: row.name,
      keyPrefix: row.key_prefix,
      createdAt: row.created_at,
      token: secret,
    },
  });
}

async function revokeApiKey(env: Env, id: string): Promise<Response> {
  const result = await env.DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
    .bind(nowIso(), id)
    .run();
  if (!result.meta.changes) return badRequest("API key not found", 404);
  return json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") return json({ ok: true });
      if (path === "/api/scan" && request.method === "POST") return handleScan(env, request);
      if (path === "/api/members" && request.method === "GET") return listMembers(env);
      if (path === "/api/dashboard" && request.method === "GET") return dashboard(env, request);
      if (path === "/api/api-keys" && request.method === "GET") return listApiKeys(env);
      if (path === "/api/api-keys" && request.method === "POST") return createApiKey(env, request);

      const memberMatch = path.match(/^\/api\/members\/([^/]+)(?:\/(sound))?$/);
      if (memberMatch) {
        const studentId = normalizeStudentId(decodeURIComponent(memberMatch[1]));
        if (!studentId) return badRequest("invalid studentId");
        if (memberMatch[2] === "sound" && request.method === "GET") return getSound(env, studentId);
        if (memberMatch[2] === "sound" && request.method === "PUT") return uploadSound(env, studentId, request);
        if (!memberMatch[2] && request.method === "GET") return getMember(env, studentId);
        if (!memberMatch[2] && request.method === "PUT") return upsertMember(env, studentId, request);
      }

      const keyMatch = path.match(/^\/api\/api-keys\/([^/]+)\/revoke$/);
      if (keyMatch && request.method === "POST") return revokeApiKey(env, keyMatch[1]);
      if (path.startsWith("/api/")) return badRequest("not found", 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal error";
      return json({ error: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
