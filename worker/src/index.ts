import { invalidatePresentAfter, presentCacheHeaders } from "./present-cache.ts";
import { LIST_PRESENT_SQL } from "./present-query.ts";

export interface Env {
  DB: D1Database;
  SOUNDS?: R2Bucket;
  ASSETS: Fetcher;
  APP_TIMEZONE: string;
  SLACK_WEBHOOK_URL?: string;
}

type MemberRow = {
  student_id: string;
  display_name: string;
  note: string;
  sound_object_key: string | null;
  sound_content_type: string | null;
  enter_sound_key: string | null;
  enter_sound_type: string | null;
  leave_sound_key: string | null;
  leave_sound_type: string | null;
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
    hour: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(get("year")),
    m: Number(get("month")),
    d: Number(get("day")),
    hour: Number(get("hour")),
    weekday: weekdayMap[get("weekday")] ?? 0,
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function tokyoDateTime(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year + "-" + pad(month) + "-" + pad(day) + "T" + pad(hour) + ":" + pad(minute) + ":00+09:00");
}

function addTokyoDays(year: number, month: number, day: number, delta: number) {
  const next = tokyoDateTime(year, month, day);
  next.setUTCDate(next.getUTCDate() + delta);
  return tokyoParts(next);
}

function formatTokyoDateTime(value: string | Date | null | undefined): string {
  if (!value) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return get("year") + "/" + get("month") + "/" + get("day") + " " + get("hour") + ":" + get("minute");
}

function tokyoSessionCutoff(now = new Date()): Date {
  const parts = tokyoParts(now);
  const cutoff = parts.hour < 2 ? addTokyoDays(parts.y, parts.m, parts.d, -1) : parts;
  return tokyoDateTime(cutoff.y, cutoff.m, cutoff.d, 2, 0);
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
  const nextMonth = month === 12 ? { y: year + 1, m: 1 } : { y: year, m: month + 1 };
  return addTokyoDays(nextMonth.y, nextMonth.m, 1, -1).d;
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
    "SELECT student_id, display_name, note, sound_object_key, sound_content_type, enter_sound_key, enter_sound_type, leave_sound_key, leave_sound_type, created_at, updated_at FROM members WHERE student_id = ?",
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
    enter_sound_key: null,
    enter_sound_type: null,
    leave_sound_key: null,
    leave_sound_type: null,
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

function nextEventType(previous: VisitRow | null, now: Date): "enter" | "leave" {
  const stillPresent = previous?.event_type === "enter"
    && Date.parse(previous.occurred_at) >= tokyoSessionCutoff(now).getTime();
  return stillPresent ? "leave" : "enter";
}

function memberDto(member: MemberRow) {
  return {
    studentId: member.student_id,
    displayName: member.display_name,
    note: member.note,
    hasEnterSound: Boolean(member.enter_sound_key || member.sound_object_key),
    hasLeaveSound: Boolean(member.leave_sound_key),
    createdAt: member.created_at,
    updatedAt: member.updated_at,
  };
}

function memberSound(member: MemberRow, eventType: "enter" | "leave") {
  if (eventType === "leave") {
    return { key: member.leave_sound_key, contentType: member.leave_sound_type, source: member.leave_sound_key ? "member" : "default" as const };
  }
  const key = member.enter_sound_key || member.sound_object_key;
  const contentType = member.enter_sound_type || member.sound_content_type;
  return { key, contentType, source: key ? "member" : "default" as const };
}

async function settingMap(env: Env): Promise<Record<string, string>> {
  const result = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map: Record<string, string> = {};
  for (const row of result.results || []) map[row.key] = row.value;
  return map;
}

async function resolvedSound(env: Env, member: MemberRow, eventType: "enter" | "leave") {
  const own = memberSound(member, eventType);
  if (own.key) {
    return { key: own.key, contentType: own.contentType, source: "member" as const, url: "/api/sounds/" + eventType + "/" + member.student_id };
  }
  const settings = await settingMap(env);
  const prefix = eventType === "enter" ? "default_enter_sound" : "default_leave_sound";
  const key = settings[prefix + "_key"] || "";
  if (!key) return { key: null, contentType: null, source: "none" as const, url: null };
  return {
    key,
    contentType: settings[prefix + "_type"] || "audio/mpeg",
    source: "default" as const,
    url: "/api/sounds/default/" + eventType,
  };
}

async function handleScan(env: Env, request: Request): Promise<Response> {
  const auth = await requireApiKey(env, request);
  if (auth instanceof Response) return auth;
  const body = (await request.json().catch(() => null)) as {
    studentId?: string;
    idm?: string;
    deviceId?: string;
    source?: string;
  } | null;
  const studentId = normalizeStudentId(body ? body.studentId : null);
  if (!studentId) return badRequest("studentId is required");
  const source = body && body.source === "demo" ? "demo" : "reader";

  const member = await ensureMember(env, studentId);
  const previous = await lastVisit(env, studentId);
  const occurredAt = nowIso();
  const eventType = nextEventType(previous, new Date(occurredAt));
  const visitId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO visits (id, student_id, event_type, occurred_at, source, device_id, idm) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(visitId, studentId, eventType, occurredAt, source, body && body.deviceId ? body.deviceId : null, body && body.idm ? body.idm : null)
    .run();

  const sound = await resolvedSound(env, member, eventType);
  const displayName = member.display_name || studentId;
  await notifySlack(env, displayName, eventType);
  const present = await listPresent(env);
  return json({
    visitId,
    studentId,
    displayName,
    eventType,
    occurredAt,
    soundUrl: sound.url,
    soundSource: sound.source,
    present,
  });
}

async function notifySlack(env: Env, displayName: string, eventType: "enter" | "leave"): Promise<void> {
  const webhookUrl = env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;
  const action = eventType === "enter" ? "入室" : "退室";
  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: displayName + "が" + action,
        username: "room-log-bot",
        icon_emoji: ":parrot_rainbow:",
      }),
    });
    if (!response.ok) {
      console.error("slack notify failed", response.status, await response.text());
    }
  } catch (error) {
    console.error("slack notify failed", error);
  }
}

async function listMembers(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT student_id, display_name, note, sound_object_key, sound_content_type, enter_sound_key, enter_sound_type, leave_sound_key, leave_sound_type, created_at, updated_at FROM members ORDER BY student_id",
  ).all<MemberRow>();
  return json({ members: (result.results || []).map(memberDto) });
}

async function getMember(env: Env, studentId: string): Promise<Response> {
  const member = await env.DB.prepare(
    "SELECT student_id, display_name, note, sound_object_key, sound_content_type, enter_sound_key, enter_sound_type, leave_sound_key, leave_sound_type, created_at, updated_at FROM members WHERE student_id = ?",
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

async function deleteMember(env: Env, studentId: string): Promise<Response> {
  const existing = await env.DB.prepare("SELECT student_id FROM members WHERE student_id = ?")
    .bind(studentId)
    .first<{ student_id: string }>();
  if (!existing) return badRequest("member not found", 404);
  await env.DB.prepare("DELETE FROM members WHERE student_id = ?").bind(studentId).run();
  const sounds = env.SOUNDS;
  if (sounds) {
    await sounds.delete([
      "sounds/members/" + studentId + "/enter",
      "sounds/members/" + studentId + "/leave",
    ]);
  }
  return json({ ok: true, studentId });
}

async function requireSounds(env: Env): Promise<R2Bucket | Response> {
  if (!env.SOUNDS) return badRequest("R2 is not enabled yet", 503);
  return env.SOUNDS;
}

function parseEventType(value: string | null): "enter" | "leave" | null {
  return value === "enter" || value === "leave" ? value : null;
}

async function putAudio(env: Env, key: string, request: Request): Promise<{ contentType: string } | Response> {
  const sounds = await requireSounds(env);
  if (sounds instanceof Response) return sounds;
  const contentType = request.headers.get("content-type") || "application/octet-stream";
  if (!contentType.startsWith("audio/") && contentType !== "application/octet-stream") {
    return badRequest("audio content-type required");
  }
  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return badRequest("empty file");
  if (body.byteLength > 5 * 1024 * 1024) return badRequest("sound must be 5MB or smaller");
  await sounds.put(key, body, { httpMetadata: { contentType } });
  return { contentType };
}

async function uploadMemberSound(env: Env, studentId: string, eventType: "enter" | "leave", request: Request): Promise<Response> {
  await ensureMember(env, studentId);
  const key = "sounds/members/" + studentId + "/" + eventType;
  const stored = await putAudio(env, key, request);
  if (stored instanceof Response) return stored;
  const updatedAt = nowIso();
  if (eventType === "enter") {
    await env.DB.prepare("UPDATE members SET enter_sound_key = ?, enter_sound_type = ?, sound_object_key = ?, sound_content_type = ?, updated_at = ? WHERE student_id = ?")
      .bind(key, stored.contentType, key, stored.contentType, updatedAt, studentId)
      .run();
  } else {
    await env.DB.prepare("UPDATE members SET leave_sound_key = ?, leave_sound_type = ?, updated_at = ? WHERE student_id = ?")
      .bind(key, stored.contentType, updatedAt, studentId)
      .run();
  }
  return json({ ok: true, eventType, soundUrl: "/api/sounds/" + eventType + "/" + studentId });
}

async function uploadDefaultSound(env: Env, eventType: "enter" | "leave", request: Request): Promise<Response> {
  const key = "sounds/default/" + eventType;
  const stored = await putAudio(env, key, request);
  if (stored instanceof Response) return stored;
  const prefix = eventType === "enter" ? "default_enter_sound" : "default_leave_sound";
  const updatedAt = nowIso();
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(prefix + "_key", key, updatedAt)
    .run();
  await env.DB.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .bind(prefix + "_type", stored.contentType, updatedAt)
    .run();
  return json({ ok: true, eventType, soundUrl: "/api/sounds/default/" + eventType });
}

async function getObjectSound(env: Env, key: string | null, contentType: string | null): Promise<Response> {
  const sounds = await requireSounds(env);
  if (sounds instanceof Response) return sounds;
  if (!key) return badRequest("sound not found", 404);
  const object = await sounds.get(key);
  if (!object) return badRequest("sound not found", 404);
  const headers = new Headers();
  headers.set("content-type", contentType || object.httpMetadata?.contentType || "audio/mpeg");
  headers.set("cache-control", "private, max-age=60");
  return new Response(object.body, { headers });
}

async function getMemberSound(env: Env, studentId: string, eventType: "enter" | "leave"): Promise<Response> {
  const member = await env.DB.prepare("SELECT " + "student_id, display_name, note, sound_object_key, sound_content_type, enter_sound_key, enter_sound_type, leave_sound_key, leave_sound_type, created_at, updated_at" + " FROM members WHERE student_id = ?")
    .bind(studentId)
    .first<MemberRow>();
  if (!member) return badRequest("member not found", 404);
  const sound = memberSound(member, eventType);
  if (sound.key) return getObjectSound(env, sound.key, sound.contentType);
  const settings = await settingMap(env);
  const prefix = eventType === "enter" ? "default_enter_sound" : "default_leave_sound";
  return getObjectSound(env, settings[prefix + "_key"] || null, settings[prefix + "_type"] || null);
}

async function getDefaultSound(env: Env, eventType: "enter" | "leave"): Promise<Response> {
  const settings = await settingMap(env);
  const prefix = eventType === "enter" ? "default_enter_sound" : "default_leave_sound";
  return getObjectSound(env, settings[prefix + "_key"] || null, settings[prefix + "_type"] || null);
}

async function getSettings(env: Env): Promise<Response> {
  const settings = await settingMap(env);
  return json({
    defaults: {
      enter: { hasSound: Boolean(settings.default_enter_sound_key), soundUrl: settings.default_enter_sound_key ? "/api/sounds/default/enter" : null },
      leave: { hasSound: Boolean(settings.default_leave_sound_key), soundUrl: settings.default_leave_sound_key ? "/api/sounds/default/leave" : null },
    },
  });
}

async function dashboard(env: Env, request: Request): Promise<Response> {
  const now = new Date();
  const url = new URL(request.url);
  const parsed = parseMonth(url.searchParams.get("month"));
  const start = tokyoDateTime(parsed.year, parsed.month, 1);
  const next = parsed.month === 12 ? { y: parsed.year + 1, m: 1 } : { y: parsed.year, m: parsed.month + 1 };
  const end = tokyoDateTime(next.y, next.m, 1);
  const visits = await env.DB.prepare(
    "SELECT v.id, v.student_id, v.event_type, v.occurred_at, v.source, v.device_id, v.idm, COALESCE(m.display_name, '') AS display_name FROM visits v LEFT JOIN members m ON m.student_id = v.student_id WHERE v.occurred_at >= ? AND v.occurred_at < ? ORDER BY v.occurred_at ASC",
  )
    .bind(start.toISOString(), end.toISOString())
    .all<VisitRow & { display_name: string }>();

  const rows = visits.results || [];
  const uniqueStudents = new Set(rows.map((row) => row.student_id));
  const enterCount = rows.filter((row) => row.event_type === "enter").length;
  const leaveCount = rows.filter((row) => row.event_type === "leave").length;
  const cutoff = tokyoSessionCutoff(now);
  const presentMembers = await listPresent(env, cutoff);
  const lastDay = daysInTokyoMonth(parsed.year, parsed.month);

  const todayKey = tokyoDayKey(now);
  const todayParts = tokyoParts(now);
  const tomorrow = addTokyoDays(todayParts.y, todayParts.m, todayParts.d, 1);
  const tomorrowStart = tokyoDateTime(tomorrow.y, tomorrow.m, tomorrow.d);
  const todayEntries = new Map<string, { studentId: string; displayName: string }>();
  const byDay = new Map<string, { date: string; enters: number; leaves: number; uniqueStudents: Set<string>; members: Map<string, { studentId: string; displayName: string; enters: number; leaves: number; lastVisitAt: string }> }>();
  const byStudent = new Map<string, { studentId: string; displayName: string; enters: number; leaves: number; lastVisitAt: string; days: Set<string> }>();

  for (const row of rows) {
    const day = tokyoDayKey(new Date(row.occurred_at));
    if (!byDay.has(day)) {
      byDay.set(day, { date: day, enters: 0, leaves: 0, uniqueStudents: new Set(), members: new Map() });
    }
    const dayBucket = byDay.get(day)!;
    if (row.event_type === "enter") dayBucket.enters += 1;
    else dayBucket.leaves += 1;

    if (row.event_type === "enter") dayBucket.uniqueStudents.add(row.student_id);
    if (day === todayKey && row.event_type === "enter") {
      todayEntries.set(row.student_id, {
        studentId: row.student_id,
        displayName: row.display_name || row.student_id,
      });
    }

    if (!dayBucket.members.has(row.student_id)) {
      dayBucket.members.set(row.student_id, {
        studentId: row.student_id,
        displayName: row.display_name || row.student_id,
        enters: 0,
        leaves: 0,
        lastVisitAt: row.occurred_at,
      });
    }
    const dayMember = dayBucket.members.get(row.student_id)!;
    if (row.event_type === "enter") dayMember.enters += 1;
    else dayMember.leaves += 1;
    dayMember.lastVisitAt = row.occurred_at;

    if (!byStudent.has(row.student_id)) {
      byStudent.set(row.student_id, {
        studentId: row.student_id,
        displayName: row.display_name || row.student_id,
        enters: 0,
        leaves: 0,
        lastVisitAt: row.occurred_at,
        days: new Set(),
      });
    }
    const studentBucket = byStudent.get(row.student_id)!;
    if (row.event_type === "enter") studentBucket.enters += 1;
    else studentBucket.leaves += 1;
    studentBucket.lastVisitAt = row.occurred_at;
    studentBucket.days.add(day);
  }

  // The two summary cards describe today/current presence, even when viewing a past month.
  // Only that uncommon case needs an additional, date-indexed query.
  if (parsed.key !== todayKey.slice(0, 7)) {
    const todayVisits = await env.DB.prepare(
      "SELECT DISTINCT v.student_id, COALESCE(m.display_name, '') AS display_name FROM visits v LEFT JOIN members m ON m.student_id = v.student_id WHERE v.occurred_at >= ? AND v.occurred_at < ? AND v.event_type = 'enter'",
    )
      .bind(tokyoDateTime(todayParts.y, todayParts.m, todayParts.d).toISOString(), tomorrowStart.toISOString())
      .all<{ student_id: string; display_name: string }>();
    for (const row of todayVisits.results || []) {
      todayEntries.set(row.student_id, { studentId: row.student_id, displayName: row.display_name || row.student_id });
    }
  }
  const todayEnterMembers = [...todayEntries.values()]
    .sort((a, b) => a.displayName.localeCompare(b.displayName, "ja") || a.studentId.localeCompare(b.studentId));

  const daily = [];
  for (let day = 1; day <= lastDay; day += 1) {
    const date = parsed.key + "-" + pad(day);
    const bucket = byDay.get(date);
    daily.push({
      date,
      enters: bucket ? bucket.enters : 0,
      leaves: bucket ? bucket.leaves : 0,
      uniqueStudents: bucket ? bucket.uniqueStudents.size : 0,
      members: bucket
        ? [...bucket.members.values()]
            .sort((a, b) => b.enters - a.enters || a.studentId.localeCompare(b.studentId))
            .map((row) => ({ ...row, lastVisitAtLabel: formatTokyoDateTime(row.lastVisitAt) }))
        : [],
    });
  }

  return json({
    month: parsed.key,
    timezone: "Asia/Tokyo",
    generatedAt: now.toISOString(),
    refreshAt: new Date(Math.min(tomorrowStart.getTime(), cutoff.getTime() + 24 * 60 * 60 * 1000)).toISOString(),
    summary: {
      uniqueStudents: uniqueStudents.size,
      todayEnterUnique: todayEnterMembers.length,
      todayEnterMembers,
      todayKey,
      enterCount,
      leaveCount,
      presentNow: presentMembers.length,
      presentMembers,
    },
    daily,
    members: [...byStudent.values()]
      .sort((a, b) => b.days.size - a.days.size || b.enters - a.enters || a.studentId.localeCompare(b.studentId))
      .map((row) => ({
        studentId: row.studentId,
        displayName: row.displayName,
        enters: row.enters,
        leaves: row.leaves,
        uniqueDays: row.days.size,
        days: [...row.days].sort(),
        lastVisitAt: row.lastVisitAt,
        lastVisitAtLabel: formatTokyoDateTime(row.lastVisitAt),
      })),
    recent: rows.slice(-20).reverse().map((row) => ({ ...row, occurredAtLabel: formatTokyoDateTime(row.occurred_at) })),
  });
}

function withTokyoTimes<T extends { lastVisitAt?: string; occurredAt?: string; createdAt?: string; last_used_at?: string | null; created_at?: string }>(row: T): T & { lastVisitAtLabel?: string; occurredAtLabel?: string; createdAtLabel?: string; lastUsedAtLabel?: string } {
  return {
    ...row,
    lastVisitAtLabel: formatTokyoDateTime(row.lastVisitAt || row.created_at || null),
    occurredAtLabel: formatTokyoDateTime(row.occurredAt || null),
    createdAtLabel: formatTokyoDateTime(row.createdAt || row.created_at || null),
    lastUsedAtLabel: formatTokyoDateTime(row.last_used_at || null),
  };
}

async function listPresent(env: Env, cutoff = tokyoSessionCutoff()): Promise<Array<{ studentId: string; displayName: string; enteredAt: string; enteredAtLabel: string }>> {
  const lastEvents = await env.DB.prepare(LIST_PRESENT_SQL)
    .bind(cutoff.toISOString())
    .all<{ student_id: string; event_type: string; occurred_at: string; display_name: string }>();
  return (lastEvents.results || [])
    .filter((row) => row.event_type === "enter")
    .map((row) => ({
      studentId: row.student_id,
      displayName: row.display_name || row.student_id,
      enteredAt: row.occurred_at,
      enteredAtLabel: formatTokyoDateTime(row.occurred_at),
    }));
}

async function listApiKeys(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    "SELECT id, name, key_prefix, revoked_at, created_at, last_used_at FROM api_keys ORDER BY created_at DESC",
  ).all<Omit<ApiKeyRow, "key_hash">>();
  return json({
    apiKeys: (result.results || []).map((row) => ({
      ...row,
      createdAtLabel: formatTokyoDateTime(row.created_at),
      lastUsedAtLabel: formatTokyoDateTime(row.last_used_at),
    })),
  });
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

async function apiKeyQr(env: Env, id: string, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || "";
  if (!token.startsWith("ltn_")) return badRequest("token required");
  const row = await env.DB.prepare("SELECT id, name, key_prefix FROM api_keys WHERE id = ? AND revoked_at IS NULL")
    .bind(id)
    .first<{ id: string; name: string; key_prefix: string }>();
  if (!row) return badRequest("API key not found", 404);
  if (!token.startsWith(row.key_prefix)) return badRequest("token does not match key", 400);
  const payload = JSON.stringify({
    v: 1,
    apiBaseUrl: url.origin,
    apiKey: token,
    deviceId: row.name || "tablet-1",
  });
  const qrUrl = "https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=" + encodeURIComponent(payload);
  const image = await fetch(qrUrl);
  if (!image.ok) return badRequest("failed to create QR", 502);
  return new Response(image.body, {
    headers: {
      "content-type": image.headers.get("content-type") || "image/png",
      "cache-control": "no-store",
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
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/api/health") return json({ ok: true });
      if (path === "/api/scan" && request.method === "POST") {
        return await invalidatePresentAfter(await handleScan(env, request), ctx.cache);
      }
      if (path === "/api/members" && request.method === "GET") return listMembers(env);
      if (path === "/api/dashboard" && request.method === "GET") return dashboard(env, request);
      if (path === "/api/present" && request.method === "GET") {
        const cutoff = tokyoSessionCutoff();
        const present = await listPresent(env, cutoff);
        // Without purge support (for example, local development), stay uncached.
        const headers = ctx.cache ? presentCacheHeaders(cutoff, new Date()) : {};
        return json({ present, cutoffAt: cutoff.toISOString(), cutoffAtLabel: formatTokyoDateTime(cutoff) }, 200, headers);
      }
      if (path === "/api/api-keys" && request.method === "GET") return listApiKeys(env);
      if (path === "/api/api-keys" && request.method === "POST") return createApiKey(env, request);

      if (path === "/api/settings" && request.method === "GET") return getSettings(env);

      const defaultSoundMatch = path.match(/^\/api\/sounds\/default\/(enter|leave)$/);
      if (defaultSoundMatch) {
        const eventType = parseEventType(defaultSoundMatch[1]);
        if (!eventType) return badRequest("invalid event type");
        if (request.method === "GET") return getDefaultSound(env, eventType);
        if (request.method === "PUT") return uploadDefaultSound(env, eventType, request);
      }

      const memberSoundMatch = path.match(/^\/api\/sounds\/(enter|leave)\/([^/]+)$/);
      if (memberSoundMatch) {
        const eventType = parseEventType(memberSoundMatch[1]);
        const studentId = normalizeStudentId(decodeURIComponent(memberSoundMatch[2]));
        if (!eventType || !studentId) return badRequest("invalid sound path");
        if (request.method === "GET") return getMemberSound(env, studentId, eventType);
        if (request.method === "PUT") return uploadMemberSound(env, studentId, eventType, request);
      }

      const memberMatch = path.match(/^\/api\/members\/([^/]+)$/);
      if (memberMatch) {
        const studentId = normalizeStudentId(decodeURIComponent(memberMatch[1]));
        if (!studentId) return badRequest("invalid studentId");
        if (request.method === "GET") return getMember(env, studentId);
        if (request.method === "PUT") {
          return await invalidatePresentAfter(await upsertMember(env, studentId, request), ctx.cache);
        }
        if (request.method === "DELETE") {
          return await invalidatePresentAfter(await deleteMember(env, studentId), ctx.cache);
        }
      }

      const keyMatch = path.match(/^\/api\/api-keys\/([^/]+)\/revoke$/);
      if (keyMatch && request.method === "POST") return revokeApiKey(env, keyMatch[1]);
      const qrMatch = path.match(/^\/api\/api-keys\/([^/]+)\/qr$/);
      if (qrMatch && request.method === "GET") return apiKeyQr(env, qrMatch[1], request);
      if (path.startsWith("/api/")) return badRequest("not found", 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      const message = error instanceof Error ? error.message : "internal error";
      return json({ error: message }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
