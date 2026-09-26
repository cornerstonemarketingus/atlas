import { sql } from "drizzle-orm";

export function rateLimitSubjectForAccount(account) {
  return `account:${account.userId}`;
}

export function rateLimitSubjectForIp(request) {
  const forwarded = request.headers.get("cf-connecting-ip");
  const ip = typeof forwarded === "string" && forwarded.trim() ? forwarded.trim() : "unknown";
  return `ip:${ip}`;
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
  const rows = await db.insert(table).values({ subject, route, bucketStart, requestCount: 1, updatedAt }).onConflictDoUpdate({
    target: [table.subject, table.route, table.bucketStart],
    set: { requestCount: sql`${table.requestCount} + 1`, updatedAt },
  }).returning({ requestCount: table.requestCount });
  const requestCount = rows[0]?.requestCount ?? limit + 1;
  return {
    allowed: requestCount <= limit,
    remaining: Math.max(0, limit - requestCount),
    retryAfter: Math.max(1, bucketStart + windowSeconds - currentSecond),
  };
}

export async function enforceRateLimit({ db, table, request, subject, route, limit, windowSeconds, failClosed = false, now = Date.now() }) {
  try {
    const outcome = await consumeRateLimit(typeof db === "function" ? db() : db, table, { subject, route, limit, windowSeconds, now });
    return outcome.allowed ? null : rateLimitedResponse(outcome.retryAfter);
  } catch {
    return failClosed ? rateLimitedResponse(windowSeconds) : null;
  }
}
