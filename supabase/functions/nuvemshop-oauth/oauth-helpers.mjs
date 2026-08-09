export const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const OAUTH_CODE_MAX_LENGTH = 2048;
export const OAUTH_RESULT_COOKIE_NAME = "__Secure-pds_nuvemshop_oauth_result";
export const OAUTH_CALLBACK_PATH = "/functions/v1/nuvemshop-oauth";

export function buildOAuthResultCookie(value, maxAge) {
  return `${OAUTH_RESULT_COOKIE_NAME}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=${OAUTH_CALLBACK_PATH}; HttpOnly; Secure; SameSite=Lax`;
}

export function readOAuthCallbackParameters(searchParams) {
  const codeValues = searchParams.getAll("code");
  const stateValues = searchParams.getAll("state");
  if (codeValues.length !== 1 || stateValues.length !== 1) return null;

  const code = codeValues[0].trim();
  const state = stateValues[0].trim();
  if (!code || code.length > OAUTH_CODE_MAX_LENGTH || !OAUTH_STATE_PATTERN.test(state)) {
    return null;
  }
  try {
    const base64 = state.replaceAll("-", "+").replaceAll("_", "/") + "=";
    if (atob(base64).length !== 32) return null;
  } catch {
    return null;
  }
  return { code, state };
}

export function buildCleanOAuthResultUrl(supabaseUrl) {
  if (typeof supabaseUrl !== "string" || !supabaseUrl.trim()) {
    throw new Error("invalid_supabase_url");
  }
  const baseUrl = new URL(supabaseUrl.trim());
  if (
    baseUrl.protocol !== "https:"
    || baseUrl.username !== ""
    || baseUrl.password !== ""
    || baseUrl.search !== ""
    || baseUrl.hash !== ""
    || baseUrl.pathname !== "/"
  ) {
    throw new Error("invalid_supabase_url");
  }
  baseUrl.pathname = OAUTH_CALLBACK_PATH;
  baseUrl.searchParams.set("final", "1");
  return baseUrl.toString();
}

export function readFixedResultCookie(cookieHeader, cookieName, allowedResults) {
  const occurrences = String(cookieHeader || "")
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.slice(0, entry.indexOf("=")) === cookieName);
  if (occurrences.length !== 1) {
    return { result: null, shouldClear: occurrences.length > 0 };
  }

  const encodedValue = occurrences[0].slice(occurrences[0].indexOf("=") + 1);
  let value;
  try {
    value = decodeURIComponent(encodedValue);
  } catch {
    return { result: null, shouldClear: true };
  }
  return {
    result: allowedResults.has(value) ? value : null,
    shouldClear: true,
  };
}
