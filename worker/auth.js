export function isAuthorized(request, env) {
  if (!env.ADMIN_TOKEN) return true;
  return request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}

/** Sensitive evidence is closed by default, including local/demo deployments. */
export function isStrictlyAuthorized(request, env) {
  return Boolean(env.ADMIN_TOKEN)
    && request.headers.get("authorization") === `Bearer ${env.ADMIN_TOKEN}`;
}
