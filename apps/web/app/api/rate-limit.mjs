import { sql } from "drizzle-orm";

export function rateLimitSubjectForAccount(account) {
  return `account:${account.userId}`;
}

export function rateLimitSubjectForDevice(device) {
  return `device:${device.id}`;
}

function requesterIp(request) {
  const cloudflare = request.headers.get("cf-connecting-ip");
  if (typeof cloudflare === "string" && cloudflare.trim()) return cloudflare.trim();
  const forwarded = request.headers.get("x-forwarded-for");
  if (typeof forwarded === "string" && forwarded.trim()) {
    const [first] = forwarded.split(",");
    if (typeof first === "string" && first.trim()) return first.trim();
  }
  const real = request.headers.get("x-real-ip");
  if (typeof real === "string" && real.trim()) return real.trim();
  return null;
}

export function rateLimitSubjectForIp(request) {
  const ip = requesterIp(request);
  return ip ? `ip:${ip}` : null;
}

export function rateLimitedResponse(retryAfterSeconds) {
  return Response.json({ error: "rate_limited" }, {
    status: 429,
    headers: { "retry-after": String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  });
}

export async function consumeRateLimit(db, table, { subject, route, limit, windowSeconds, now = Date.now() }) {
  const currentSecond = Math.floor(now / 1000);
  const bucketStart = currentSecond - (currentSecond % windowSeconds);
  const updatedAt = new Date(now).toISOString();
  const maxStoredCount = limit + 1;
  const rows = await db.insert(table).values({ subject, route, bucketStart, requestCount: 1, updatedAt }).onConflictDoUpdate({
    target: [table.subject, table.route, table.bucketStart],
    set: {
      requestCount: sql`CASE WHEN ${table.requestCount} < ${maxStoredCount} THEN ${table.requestCount} + 1 ELSE ${table.requestCount} END`,
      updatedAt,
    },
  }).returning({ requestCount: table.requestCount });
  const requestCount = rows[0]?.requestCount ?? limit + 1;
  return {
    allowed: requestCount <= limit,
    remaining: Math.max(0, limit - requestCount),
    retryAfter: Math.max(1, bucketStart + windowSeconds - currentSecond),
  };
}

export async function enforceRateLimit({ db, table, request, subject, route, limit, windowSeconds, failClosed = false, now = Date.now() }) {
  if (!subject) return null;
  try {
    const outcome = await consumeRateLimit(typeof db === "function" ? db() : db, table, { subject, route, limit, windowSeconds, now });
    return outcome.allowed ? null : rateLimitedResponse(outcome.retryAfter);
  } catch (error) {
    console.warn("Rate limit check failed.", { route, subject, failClosed, error: error instanceof Error ? error.message : String(error) });
    return failClosed ? rateLimitedResponse(windowSeconds) : null;
  }
}
