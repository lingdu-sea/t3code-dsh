/**
 * Only low-risk process launch variables are inherited by the DSH child.
 * Provider instance bindings are merged separately by the trusted registry.
 *
 * Environment filtering is defense in depth, NOT a filesystem sandbox or
 * multi-tenant security boundary. For strong isolation use different OS
 * identities/containers and enforce project permissions in T3.
 */
const LAUNCH_KEYS = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "TMP", "TEMP", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE",
  "TZ",
]);

export function inheritedDshLaunchEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value !== "string") continue;
    if (LAUNCH_KEYS.has(name.toUpperCase())) filtered[name] = value;
  }
  return filtered;
}
