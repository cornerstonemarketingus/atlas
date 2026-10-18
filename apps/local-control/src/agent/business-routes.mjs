/** The local owner can write; authenticated paired devices can inspect. */
export function createBusinessRoutes({ businessService }) {
  return { async handle(request, response, identity) {
    const url = new URL(request.url, "http://local.atlas");
    const path = url.pathname;
    if (!path.startsWith("/v1/businesses")) return false;
    const send = (status, data) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(data)); return true; };
    if (request.method === "POST" && identity.role !== "admin") return send(403, { message: "Only the local owner can manage businesses." });
    try {
      if (request.method === "GET" && path === "/v1/businesses") return send(200, { businesses: businessService.list() });
      if (request.method === "GET" && path === "/v1/businesses/due") return send(200, { responsibilities: businessService.due() });
      const match = /^\/v1\/businesses(?:\/([a-z0-9-]{1,64})(?:\/(plan|launch|responsibilities)(?:\/([a-z0-9-]{1,64})\/review)?)?)?$/u.exec(path);
      if (!match) return send(404, { message: "Unknown business route." });
      const [, id, action, responsibilityId] = match;
      if (request.method === "GET" && id && !action) { const business = businessService.get(id); return send(business ? 200 : 404, business ? { business } : { message: "Business not found." }); }
      if (request.method === "GET" && action === "plan") return send(200, { plan: businessService.plan(id, url.searchParams.get("template") ?? "construction-launch") });
      if (request.method !== "POST") return send(405, { message: "Method not allowed." });
      let bytes = 0; const chunks = [];
      for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) return send(413, { message: "Request body is too large." }); chunks.push(chunk); }
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new Error("Request body must be a JSON object."); }
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Request body must be a JSON object.");
      if (!id) return send(201, { business: businessService.create(body) });
      if (action === "launch") return send(201, { mission: businessService.launch(id, body) });
      if (action === "responsibilities" && !responsibilityId) return send(201, { responsibility: businessService.assign(id, body) });
      if (action === "responsibilities" && responsibilityId) return send(200, { responsibility: businessService.review(id, responsibilityId, body) });
      return send(404, { message: "Unknown business route." });
    } catch (error) { return send(error.statusCode ?? 400, { message: error.message }); }
  } };
}
