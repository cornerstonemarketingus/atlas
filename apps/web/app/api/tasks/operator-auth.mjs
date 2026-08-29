const BEARER_PREFIX = "Bearer ";

export function authenticatedUserId(request, environment = process.env) {
  const platformUserId = request.headers.get("oai-authenticated-user-id");
  if (platformUserId) return platformUserId;

  const token = environment.ATLAS_OPERATOR_TOKEN;
  if (!token) return null;
  const header = request.headers.get("authorization");
  return header === `${BEARER_PREFIX}${token}` ? "operator" : null;
}
