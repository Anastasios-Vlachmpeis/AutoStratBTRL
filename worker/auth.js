export function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return true;
  return request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}
