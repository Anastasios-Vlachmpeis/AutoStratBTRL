function constantTimeEqual(left, right) {
  const a = String(left ?? ""), b = String(right ?? "");
  let difference = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) difference |= (a.charCodeAt(index) || 0) ^ (b.charCodeAt(index) || 0);
  return difference === 0;
}

function environment(env) {
  return String(env.ENVIRONMENT ?? "local").trim().toLowerCase();
}

export function adminTokenConfiguration(env = {}) {
  const values = [{ id: String(env.ADMIN_TOKEN_KEY_ID ?? "current"), value: env.ADMIN_TOKEN },
    { id: String(env.ADMIN_TOKEN_PREVIOUS_KEY_ID ?? "previous"), value: env.ADMIN_TOKEN_PREVIOUS }]
    .filter((item) => item.value);
  const requiresStrong = ["staging", "production-paper"].includes(environment(env));
  return { environment: environment(env), configured: values.length > 0,
    valid: values.length > 0 && (!requiresStrong || values.every((item) => String(item.value).length >= 32)),
    key_ids: values.map((item) => item.id), values };
}

export function isAuthorized(request, env) {
  const config = adminTokenConfiguration(env);
  if (!config.configured) return !["staging", "production-paper"].includes(config.environment);
  if (!config.valid) return false;
  const supplied = request.headers.get("authorization") ?? "";
  return config.values.some((item) => constantTimeEqual(supplied, `Bearer ${item.value}`));
}

/** Sensitive evidence is closed by default, including local/demo deployments. */
export function isStrictlyAuthorized(request, env) {
  const config = adminTokenConfiguration(env);
  if (!config.valid) return false;
  const supplied = request.headers.get("authorization") ?? "";
  return config.values.some((item) => constantTimeEqual(supplied, `Bearer ${item.value}`));
}
