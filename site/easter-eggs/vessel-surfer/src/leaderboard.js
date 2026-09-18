import { CHALLENGE, pointsFor, readScores, saveScore } from "./race.js";

export const NAME_KEY = "vessel-surfer.name.v1";
export const NAME_LIMIT = 16;

// Names are shown to everyone: keep them short, printable and trimmed.
export function cleanName(value) {
  const text = String(value ?? "")
    .replace(/[\p{C}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NAME_LIMIT);
  return text || "Anonymous";
}

export function formatTime(seconds) {
  const tenths = Math.floor(seconds * 10);
  return `${Math.floor(tenths / 600)}:${((tenths % 600) / 10).toFixed(1).padStart(4, "0")}`;
}

// A shared leaderboard on the Neurodesk worker, with this browser's own best
// runs as the fallback whenever the network is unavailable.
export function createLeaderboard({
  url,
  storage,
  fetch = globalThis.fetch,
  challenge = CHALLENGE,
} = {}) {
  const base = url ? url.replace(/\/$/, "") : "";
  const request = async (path, init) => {
    if (!base) throw new Error("No leaderboard server is configured.");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(base + path, {
        ...init,
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw new Error(detail.error || `Leaderboard error ${response.status}`);
      }
      return response.json();
    } finally {
      clearTimeout(timer);
    }
  };
  const local = () => {
    try {
      return readScores(storage).map((row) => ({
        ...row,
        name: row.name || "You",
      }));
    } catch {
      return [];
    }
  };
  return {
    challenge,
    get name() {
      try {
        return storage?.getItem(NAME_KEY) || "";
      } catch {
        return "";
      }
    },
    set name(value) {
      try {
        storage?.setItem(NAME_KEY, cleanName(value));
      } catch {
        /* Storage can be disabled. */
      }
    },
    async top(limit = 10) {
      try {
        const data = await request(
          `/scores?challenge=${encodeURIComponent(challenge)}&limit=${limit}`,
        );
        return { scope: "global", rows: data.scores, total: data.total };
      } catch (error) {
        return { scope: "local", rows: local(), error: error.message };
      }
    },
    async submit(result, name) {
      const entry = {
        challenge,
        name: cleanName(name),
        seconds: result.seconds,
        bumps: result.bumps,
      };
      if (pointsFor(entry.seconds, entry.bumps) !== result.points)
        throw new Error("This run cannot be scored.");
      this.name = entry.name;
      try {
        const data = await request("/scores", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(entry),
        });
        return { scope: "global", rank: data.rank, rows: data.scores };
      } catch (error) {
        saveScore(storage, { ...result, name: entry.name });
        return { scope: "local", rows: local(), error: error.message };
      }
    },
  };
}
