type Level = "error" | "warn" | "info" | "debug";

const LEVELS: Record<Level, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const levelFromEnv = (process.env.MCP_LOG_LEVEL as Level) || "info";
const THRESHOLD = LEVELS[levelFromEnv] ?? LEVELS.info;

function isoNow() {
  return new Date().toISOString();
}

export function redact<T>(value: T): T {
  const seen = new WeakSet();
  const walk = (v: any): any => {
    if (v === null || v === undefined) return v;
    if (typeof v === "string") return v;
    if (typeof v !== "object") return v;
    if (seen.has(v)) return "[Circular]";
    seen.add(v);
    if (Array.isArray(v)) return v.map(walk);
    const out: any = {};
    for (const [k, val] of Object.entries(v)) {
      if (/key|token|secret|password|authorization/i.test(k)) {
        out[k] = "[REDACTED]";
      } else if (k === "history" && Array.isArray(val)) {
        out[k] = `len=${val.length}`;
      } else {
        out[k] = walk(val);
      }
    }
    return out;
  };
  return walk(value);
}

export function log(level: Level, msg: string, meta?: unknown) {
  if ((LEVELS[level] ?? 99) > THRESHOLD) return;
  const time = isoNow();
  if (meta !== undefined) {
    const safe = redact(meta);
    console.error(`[${time}] ${level.toUpperCase()} ${msg} ::`, JSON.stringify(safe));
  } else {
    console.error(`[${time}] ${level.toUpperCase()} ${msg}`);
  }
}

export const logger = {
  error: (m: string, meta?: unknown) => log("error", m, meta),
  warn: (m: string, meta?: unknown) => log("warn", m, meta),
  info: (m: string, meta?: unknown) => log("info", m, meta),
  debug: (m: string, meta?: unknown) => log("debug", m, meta),
};

