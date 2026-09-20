import { CHALLENGE, CHALLENGES as TRACK_IDS, pointsFor, trackFor } from "../../vessel-surfer/src/race.js";

export const NAME_LIMIT = 16;
export const MAX_LIMIT = 100;
export const SUBMISSIONS_PER_HOUR = 30;
// The shortest believable run per track (the fastest cruising speed is about
// 2.5 mm/s) comes from the track table in the game's race.js.
export const MAX_SECONDS = 3600;
export const CHALLENGES = new Set(TRACK_IDS);

export function cleanName(value) {
  const text = String(value ?? "")
    .replace(/[\p{C}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_LIMIT);
  return text || "Anonymous";
}

export class ValidationError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function validateEntry(body) {
  if (!body || typeof body !== "object")
    throw new ValidationError("Send a JSON object.");
  const { challenge, seconds, bumps } = body;
  if (!CHALLENGES.has(challenge))
    throw new ValidationError("Unknown challenge.");
  if (
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < trackFor(challenge).minSeconds ||
    seconds > MAX_SECONDS
  )
    throw new ValidationError("Run time is out of range.");
  if (!Number.isInteger(bumps) || bumps < 0 || bumps > 999)
    throw new ValidationError("Bump count is out of range.");
  const points = pointsFor(seconds, bumps, challenge);
  if (points <= 0) throw new ValidationError("This run scores no points.");
  return {
    challenge,
    name: cleanName(body.name),
    seconds: Math.round(seconds * 1000) / 1000,
    bumps,
    points,
  };
}

export function memoryStore(rows = []) {
  const order = (a, b) => b.points - a.points || a.seconds - b.seconds || a.id - b.id;
  return {
    rows,
    async top(challenge, limit) {
      return rows
        .filter((row) => row.challenge === challenge)
        .sort(order)
        .slice(0, limit)
        .map(({ name, points, seconds, bumps, date }) => ({ name, points, seconds, bumps, date }));
    },
    async count(challenge) {
      return rows.filter((row) => row.challenge === challenge).length;
    },
    async rank(challenge, points, seconds) {
      return (
        1 +
        rows.filter(
          (row) =>
            row.challenge === challenge &&
            (row.points > points || (row.points === points && row.seconds < seconds)),
        ).length
      );
    },
    async recent(ipHash, since) {
      return rows.filter((row) => row.ipHash === ipHash && row.date >= since).length;
    },
    async insert(row) {
      rows.push({ ...row, id: rows.length + 1 });
    },
  };
}

export function d1Store(db) {
  return {
    async top(challenge, limit) {
      const { results } = await db
        .prepare(
          "SELECT name, points, seconds, bumps, created_at AS date FROM scores WHERE challenge = ?1 ORDER BY points DESC, seconds ASC, id ASC LIMIT ?2",
        )
        .bind(challenge, limit)
        .all();
      return results;
    },
    async count(challenge) {
      const row = await db
        .prepare("SELECT COUNT(*) AS total FROM scores WHERE challenge = ?1")
        .bind(challenge)
        .first();
      return row?.total ?? 0;
    },
    async rank(challenge, points, seconds) {
      const row = await db
        .prepare(
          "SELECT COUNT(*) AS better FROM scores WHERE challenge = ?1 AND (points > ?2 OR (points = ?2 AND seconds < ?3))",
        )
        .bind(challenge, points, seconds)
        .first();
      return 1 + (row?.better ?? 0);
    },
    async recent(ipHash, since) {
      const row = await db
        .prepare("SELECT COUNT(*) AS total FROM scores WHERE ip_hash = ?1 AND created_at >= ?2")
        .bind(ipHash, since)
        .first();
      return row?.total ?? 0;
    },
    async insert(row) {
      await db
        .prepare(
          "INSERT INTO scores (challenge, name, seconds, bumps, points, ip_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )
        .bind(row.challenge, row.name, row.seconds, row.bumps, row.points, row.ipHash, row.date)
        .run();
    },
  };
}

export function allowOrigin(origin, allowed) {
  if (!origin) return false;
  if (allowed.includes(origin)) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

function json(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export async function handle(request, { store, allowedOrigins = [], now = () => new Date(), ipHash = "" }) {
  const origin = request.headers.get("origin");
  const cors = allowOrigin(origin, allowedOrigins)
    ? {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "GET, POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        vary: "origin",
      }
    : { vary: "origin" };
  const url = new URL(request.url);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (url.pathname !== "/scores") return json({ error: "Not found." }, 404, cors);
  if (request.method === "GET") {
    const challenge = url.searchParams.get("challenge") || CHALLENGE;
    if (!CHALLENGES.has(challenge)) return json({ error: "Unknown challenge." }, 400, cors);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || 10));
    const [scores, total] = await Promise.all([store.top(challenge, limit), store.count(challenge)]);
    return json({ challenge, scores, total }, 200, { ...cors, "cache-control": "no-store" });
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, cors);
  if (origin && !allowOrigin(origin, allowedOrigins)) return json({ error: "Origin not allowed." }, 403, cors);
  const text = await request.text();
  if (text.length > 2048) return json({ error: "Request too large." }, 413, cors);
  let entry;
  try {
    entry = validateEntry(JSON.parse(text));
  } catch (error) {
    return json({ error: error.status ? error.message : "Send valid JSON." }, error.status || 400, cors);
  }
  const date = now();
  const since = new Date(date.getTime() - 3600 * 1000).toISOString();
  if ((await store.recent(ipHash, since)) >= SUBMISSIONS_PER_HOUR)
    return json({ error: "Too many runs saved in the last hour. Try again later." }, 429, cors);
  await store.insert({ ...entry, ipHash, date: date.toISOString() });
  const [rank, scores] = await Promise.all([
    store.rank(entry.challenge, entry.points, entry.seconds),
    store.top(entry.challenge, 10),
  ]);
  return json({ rank, entry, scores }, 201, cors);
}

async function hashAddress(request, salt) {
  const address = request.headers.get("cf-connecting-ip") || "";
  const bytes = new TextEncoder().encode(`${salt}|${address}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default {
  async fetch(request, env) {
    return handle(request, {
      store: d1Store(env.DB),
      allowedOrigins: (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
      ipHash: await hashAddress(request, env.IP_SALT || "vessel-surfer"),
    });
  },
};
