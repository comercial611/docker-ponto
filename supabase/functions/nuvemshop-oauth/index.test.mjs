import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildCleanOAuthResultUrl,
  buildOAuthResultCookie,
  OAUTH_CODE_MAX_LENGTH,
  readFixedResultCookie,
  readOAuthCallbackParameters,
} from "./oauth-helpers.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(testDirectory, "../../..");
const migration = readFileSync(resolve(projectRoot, "supabase/32-oauth-state-nuvemshop.sql"), "utf8");
const startSource = readFileSync(resolve(projectRoot, "supabase/functions/nuvemshop-oauth-iniciar/index.ts"), "utf8");
const callbackSource = readFileSync(resolve(projectRoot, "supabase/functions/nuvemshop-oauth/index.ts"), "utf8");
const helperSource = readFileSync(resolve(projectRoot, "supabase/functions/nuvemshop-oauth/oauth-helpers.mjs"), "utf8");
const adminSource = readFileSync(resolve(projectRoot, "js/admin.js"), "utf8");
const readme = readFileSync(resolve(projectRoot, "supabase/README.md"), "utf8");

function generateState() {
  return randomBytes(32).toString("base64url");
}

function hashState(state) {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

function canStartOAuth(authenticated, profile) {
  return authenticated === true && profile === "admin";
}

function isValidAuthorizationUrl(value) {
  const url = new URL(value);
  const states = url.searchParams.getAll("state");
  const keys = Array.from(url.searchParams.keys());
  return url.protocol === "https:"
    && url.hostname === "www.nuvemshop.com.br"
    && url.port === ""
    && url.username === ""
    && url.password === ""
    && url.pathname === "/apps/36716/authorize"
    && url.hash === ""
    && states.length === 1
    && keys.length === 1
    && keys[0] === "state"
    && /^[A-Za-z0-9_-]{43}$/.test(states[0]);
}

const allowedFailureCodes = new Set([
  "troca_indisponivel",
  "troca_timeout",
  "troca_recusada",
  "resposta_invalida",
  "protecao_token_falhou",
  "finalizacao_falhou",
  "falha_inesperada",
]);

function createDatabase(now = 1_000_000) {
  return { now, nextOrder: 1, attempts: new Map(), connections: new Map(), externalCalls: 0 };
}

function registerAttempt(database, state, role = "service_role") {
  if (role !== "service_role") throw new Error("forbidden");
  const hash = hashState(state);
  const id = `attempt-${database.attempts.size + 1}`;
  database.attempts.set(hash, {
    id,
    order: database.nextOrder++,
    hash,
    createdAt: database.now,
    expiresAt: database.now + 600_000,
    consumedAt: null,
    completedAt: null,
    failedAt: null,
    storeId: null,
    status: "pendente",
    errorCode: null,
  });
  return id;
}

function reserveAttempt(database, state) {
  const attempt = database.attempts.get(hashState(state));
  if (!attempt || attempt.status !== "pendente") return null;
  if (attempt.expiresAt <= database.now) {
    attempt.status = "falhou";
    attempt.consumedAt = database.now;
    attempt.failedAt = database.now;
    attempt.errorCode = "state_expirado";
    return null;
  }
  attempt.status = "reservada";
  attempt.consumedAt = database.now;
  return attempt.id;
}

function failAttempt(database, attemptId, errorCode) {
  const attempt = [...database.attempts.values()].find((item) => item.id === attemptId);
  if (!attempt || attempt.status !== "reservada" || !allowedFailureCodes.has(errorCode)) return false;
  attempt.status = "falhou";
  attempt.failedAt = database.now;
  attempt.errorCode = errorCode;
  return true;
}

function completeAttempt(database, attemptId, storeId, failBeforeCommit = false) {
  const snapshot = structuredClone({
    attempts: [...database.attempts.entries()],
    connections: [...database.connections.entries()],
  });
  const attempt = [...database.attempts.values()].find((item) => item.id === attemptId);
  if (!attempt || attempt.status !== "reservada" || database.now >= attempt.expiresAt) return false;
  const currentConnection = database.connections.get(storeId);
  if (
    currentConnection?.oauthStartedAt != null
    && (
      attempt.createdAt < currentConnection.oauthStartedAt
      || (
        attempt.createdAt === currentConnection.oauthStartedAt
        && currentConnection.oauthAttemptOrder != null
        && attempt.order <= currentConnection.oauthAttemptOrder
      )
    )
  ) {
    attempt.status = "falhou";
    attempt.failedAt = database.now;
    attempt.errorCode = "tentativa_antiga";
    return false;
  }
  if (failBeforeCommit) {
    database.attempts = new Map(snapshot.attempts);
    database.connections = new Map(snapshot.connections);
    throw new Error("rollback");
  }
  database.connections.set(storeId, {
    storeId,
    oauthAttemptId: attempt.id,
    oauthAttemptOrder: attempt.order,
    oauthStartedAt: attempt.createdAt,
    token: "encrypted-test-token",
  });
  attempt.status = "concluida";
  attempt.completedAt = database.now;
  attempt.storeId = storeId;
  return true;
}

assert.equal((migration.match(/^begin;$/gim) || []).length, 1);
assert.equal((migration.match(/^commit;$/gim) || []).length, 1);
assert.match(migration, /state_hash bytea not null unique/i);
assert.match(migration, /octet_length\(state_hash\) = 32/i);
assert.match(migration, /interval '10 minutes'/i);
assert.match(migration, /falhou_em timestamp with time zone/i);
assert.match(migration, /ordem bigint generated always as identity not null unique/i);
assert.match(migration, /oauth_tentativa_ordem bigint/i);
assert.match(migration, /erro_codigo is null or erro_codigo in/i);
assert.doesNotMatch(migration, /p_erro_codigo\s*!~/i);
assert.match(migration, /for update/i);
assert.match(migration, /pg_advisory_xact_lock[\s\S]*nuvemshop_oauth:/i);
assert.match(migration, /security definer[\s\S]*set search_path = public, pg_temp/i);
assert.match(migration, /revoke all[\s\S]*public, anon, authenticated/i);
assert.match(migration, /grant execute[\s\S]*service_role/i);
assert.doesNotMatch(migration, /state_bruto|state_raw/i);
assert.doesNotMatch(migration, /redigida_em/i);

assert.match(startSource, /crypto\.getRandomValues\(new Uint8Array\(STATE_BYTES\)\)/);
assert.match(startSource, /const STATE_BYTES = 32/);
assert.match(startSource, /crypto\.subtle\.digest\("SHA-256", new TextEncoder\(\)\.encode\(state\)\)/);
assert.match(startSource, /userType !== "admin"/);
assert.match(startSource, /https:\/\/www\.nuvemshop\.com\.br\/apps\/\$\{APP_ID\}\/authorize/);
assert.match(startSource, /searchParams\.set\("state", state\)/);
assert.doesNotMatch(startSource, /store_id/i);
assert.doesNotMatch(startSource, /console\.(?:log|error)\([^\n]*(?:state|hash|token|secret|code|iv)/i);

const reservePosition = callbackSource.indexOf("reservar_tentativa_oauth_nuvemshop");
const fetchPosition = callbackSource.indexOf('fetch("https://www.tiendanube.com/apps/authorize/token"');
assert.ok(reservePosition >= 0 && fetchPosition > reservePosition);
assert.match(helperSource, /getAll\("code"\)/);
assert.match(helperSource, /getAll\("state"\)/);
assert.equal(OAUTH_CODE_MAX_LENGTH, 2048);
assert.match(callbackSource, /new AbortController\(\)/);
assert.match(callbackSource, /signal: controller\.signal/);
assert.match(callbackSource, /clearTimeout\(timeoutId\)/);
assert.match(callbackSource, /status: 303/);
const expectedAdminFinalUrl = "https://comercial611.github.io/docker-ponto/admin.html?nuvemshop_oauth=finalizado";
assert.match(callbackSource, /const ADMIN_OAUTH_FINAL_URL = "https:\/\/comercial611\.github\.io\/docker-ponto\/admin\.html\?nuvemshop_oauth=finalizado";/);
assert.match(callbackSource, /"Location": ADMIN_OAUTH_FINAL_URL/);
assert.match(callbackSource, /if \(isFinalResultRequest\(request\)\) return adminResultRedirect\(\);/);
assert.match(callbackSource, /if \(reserveError \|\| typeof reservedAttemptId !== "string" \|\| !reservedAttemptId\)[\s\S]{0,180}return adminResultRedirect\(\);/);
assert.doesNotMatch(callbackSource, /buildCleanOAuthResultUrl/);
assert.doesNotMatch(callbackSource, /cleanResultRedirect/);
assert.doesNotMatch(callbackSource, /cleanResultUrl/);
assert.doesNotMatch(callbackSource, /RESULT_PAGES/);
assert.doesNotMatch(callbackSource, /"Location":\s*requestUrl/);
const cspMatch = callbackSource.match(/const HTML_CONTENT_SECURITY_POLICY = "([^"]+)";/);
assert.ok(cspMatch);
const csp = cspMatch[1];
assert.match(callbackSource, /"Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY/);
assert.match(csp, /(?:^|; )default-src 'none'(?:;|$)/);
assert.match(csp, /(?:^|; )script-src 'none'(?:;|$)/);
assert.match(csp, /(?:^|; )style-src 'unsafe-inline'(?:;|$)/);
assert.match(csp, /(?:^|; )connect-src 'none'(?:;|$)/);
assert.match(csp, /(?:^|; )object-src 'none'(?:;|$)/);
assert.match(csp, /(?:^|; )frame-ancestors 'none'(?:;|$)/);
assert.match(csp, /(?:^|; )base-uri 'none'(?:;|$)/);
assert.match(csp, /(?:^|; )form-action 'none'(?:;|$)/);
assert.equal(csp.includes("*"), false);
assert.doesNotMatch(csp, /https?:|www\.|\.com|\.co|\.io/);
assert.match(callbackSource, /"Cache-Control": "no-store"/);
assert.match(callbackSource, /"Referrer-Policy": "no-referrer"/);
assert.match(callbackSource, /"X-Content-Type-Options": "nosniff"/);
assert.match(callbackSource, /"X-Frame-Options": "DENY"/);
assert.match(helperSource, /HttpOnly; Secure; SameSite=Lax/);
assert.match(callbackSource, /buildOAuthResultCookie\("", 0\)/);
assert.match(callbackSource, /concluir_tentativa_oauth_nuvemshop/);
assert.doesNotMatch(callbackSource, /\.from\("nuvemshop_conexoes"\)\.upsert/);
assert.doesNotMatch(callbackSource, /console\.(?:log|error)\([^\n]*(?:accessToken|clientSecret|encrypted|attemptId|stateHash|\bcode\b)/);

assert.match(adminSource, /sb\.functions\.invoke\('nuvemshop-oauth-iniciar'/);
assert.match(adminSource, /nuvemshopOAuthStartBusy/);
assert.match(adminSource, /errorElement\.textContent/);
assert.match(adminSource, /authorizationUrl\.username === ''/);
assert.match(adminSource, /authorizationUrl\.password === ''/);
assert.match(adminSource, /authorizationUrl\.hash === ''/);
assert.match(adminSource, /searchParams\.getAll\('state'\)/);
assert.match(adminSource, /queryKeys\.length === 1/);
assert.match(adminSource, /NUVEMSHOP_OAUTH_FINAL_VALUE = 'finalizado'/);
assert.match(adminSource, /errorElement\.classList\.add\('nuvemshop-connect-notice'\)/);
assert.match(adminSource, /errorElement\.classList\.remove\('nuvemshop-connect-notice'\)/);
assert.match(adminSource, /errorElement\.textContent = NUVEMSHOP_OAUTH_FINAL_MESSAGE/);
assert.match(adminSource, /history\.replaceState\(history\.state, document\.title/);
assert.match(adminSource, /queryKeys\.length !== 1/);
assert.match(adminSource, /queryKeys\[0\] !== NUVEMSHOP_OAUTH_FINAL_PARAM/);
assert.equal(expectedAdminFinalUrl.includes("code="), false);
assert.equal(expectedAdminFinalUrl.includes("state="), false);
assert.equal(expectedAdminFinalUrl.includes("token"), false);
assert.equal(expectedAdminFinalUrl.includes("hash"), false);
assert.equal(expectedAdminFinalUrl.includes("iv"), false);
assert.equal(expectedAdminFinalUrl.includes("store_id"), false);
assert.equal(expectedAdminFinalUrl.includes("erro"), false);
assert.match(readme, /criado_em > redigida_em/);
assert.match(readme, /A migration 34 implementa somente a primeira etapa/);
assert.match(readme, /A futura migration 35 de redacao LGPD/);

assert.equal(canStartOAuth(true, "admin"), true);
assert.equal(canStartOAuth(false, "admin"), false);
assert.equal(canStartOAuth(true, null), false);
assert.equal(canStartOAuth(true, "funcionario"), false);
assert.equal(canStartOAuth(true, "vendedor"), false);

const frontendState = "A".repeat(43);
const expectedAuthorizationUrl = `https://www.nuvemshop.com.br/apps/36716/authorize?state=${frontendState}`;
assert.equal(isValidAuthorizationUrl(expectedAuthorizationUrl), true);
assert.equal(isValidAuthorizationUrl(`https://user:pass@www.nuvemshop.com.br/apps/36716/authorize?state=${frontendState}`), false);
assert.equal(isValidAuthorizationUrl(`${expectedAuthorizationUrl}#fragment`), false);
assert.equal(isValidAuthorizationUrl(`${expectedAuthorizationUrl}&extra=1`), false);
assert.equal(isValidAuthorizationUrl(`${expectedAuthorizationUrl}&state=${frontendState}`), false);
assert.equal(isValidAuthorizationUrl(`https://www.nuvemshop.com.br:444/apps/36716/authorize?state=${frontendState}`), false);

const expectedCleanResultUrl = "https://project.example.supabase.co/functions/v1/nuvemshop-oauth?final=1";
assert.equal(buildCleanOAuthResultUrl("https://project.example.supabase.co"), expectedCleanResultUrl);
assert.equal(buildCleanOAuthResultUrl("https://project.example.supabase.co/"), expectedCleanResultUrl);
assert.throws(() => buildCleanOAuthResultUrl(""), /invalid_supabase_url/);
assert.throws(() => buildCleanOAuthResultUrl("http://project.example.supabase.co"), /invalid_supabase_url/);
assert.throws(() => buildCleanOAuthResultUrl("https://user:pass@project.example.supabase.co"), /invalid_supabase_url/);
assert.throws(() => buildCleanOAuthResultUrl("https://project.example.supabase.co?return_url=https://evil.test"), /invalid_supabase_url/);
assert.throws(() => buildCleanOAuthResultUrl("https://project.example.supabase.co/#fragment"), /invalid_supabase_url/);
const maliciousRequest = new URL(`https://evil.test/other?code=secret&state=${frontendState}#fragment`);
assert.equal(buildCleanOAuthResultUrl("https://project.example.supabase.co"), expectedCleanResultUrl);
assert.equal(expectedCleanResultUrl.includes(maliciousRequest.hostname), false);
assert.equal(expectedCleanResultUrl.includes("code="), false);
assert.equal(expectedCleanResultUrl.includes("state="), false);
assert.equal(expectedCleanResultUrl.includes("#"), false);

const validCallbackState = generateState();
const acceptedCode = "c".repeat(2048);
assert.deepEqual(
  readOAuthCallbackParameters(new URLSearchParams({ code: acceptedCode, state: validCallbackState })),
  { code: acceptedCode, state: validCallbackState },
);
assert.equal(readOAuthCallbackParameters(new URLSearchParams({ code: "c".repeat(2049), state: validCallbackState })), null);
assert.equal(readOAuthCallbackParameters(new URLSearchParams({ code: "   ", state: validCallbackState })), null);
const duplicateCode = new URLSearchParams({ code: "one", state: validCallbackState });
duplicateCode.append("code", "two");
assert.equal(readOAuthCallbackParameters(duplicateCode), null);
const duplicateState = new URLSearchParams({ code: "one", state: validCallbackState });
duplicateState.append("state", validCallbackState);
assert.equal(readOAuthCallbackParameters(duplicateState), null);

const allowedResults = new Set(["sucesso_leitura", "autorizacao_invalida"]);
assert.deepEqual(
  readFixedResultCookie("other=x; oauth_result=sucesso_leitura", "oauth_result", allowedResults),
  { result: "sucesso_leitura", shouldClear: true },
);
assert.deepEqual(
  readFixedResultCookie("oauth_result=adulterado", "oauth_result", allowedResults),
  { result: null, shouldClear: true },
);
assert.deepEqual(
  readFixedResultCookie("oauth_result=sucesso_leitura; oauth_result=autorizacao_invalida", "oauth_result", allowedResults),
  { result: null, shouldClear: true },
);
assert.deepEqual(
  readFixedResultCookie("other=x", "oauth_result", allowedResults),
  { result: null, shouldClear: false },
);
assert.equal(
  buildOAuthResultCookie("sucesso_leitura", 60),
  "__Secure-pds_nuvemshop_oauth_result=sucesso_leitura; Max-Age=60; Path=/functions/v1/nuvemshop-oauth; HttpOnly; Secure; SameSite=Lax",
);
assert.equal(
  buildOAuthResultCookie("", 0),
  "__Secure-pds_nuvemshop_oauth_result=; Max-Age=0; Path=/functions/v1/nuvemshop-oauth; HttpOnly; Secure; SameSite=Lax",
);

const generatedStates = new Set(Array.from({ length: 128 }, generateState));
assert.equal(generatedStates.size, 128);
for (const state of generatedStates) assert.match(state, /^[A-Za-z0-9_-]{43}$/);
const knownState = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const webCryptoHash = Buffer.from(
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(knownState)),
).toString("hex");
assert.equal(hashState(knownState), webCryptoHash);

const database = createDatabase();
const state = generateState();
const firstAttemptId = registerAttempt(database, state);
assert.equal([...database.attempts.values()][0].state, undefined);
assert.throws(() => registerAttempt(database, generateState(), "authenticated"), /forbidden/);
assert.equal(reserveAttempt(database, generateState()), null);
assert.equal(reserveAttempt(database, state), firstAttemptId);
assert.equal(reserveAttempt(database, state), null);
assert.equal(completeAttempt(database, firstAttemptId, 101), true);
assert.equal(reserveAttempt(database, state), null);
assert.equal(completeAttempt(database, firstAttemptId, 202), false);
assert.equal(database.connections.has(202), false);

const concurrentDatabase = createDatabase();
const concurrentState = generateState();
registerAttempt(concurrentDatabase, concurrentState);
const concurrentReservations = await Promise.all([
  Promise.resolve().then(() => reserveAttempt(concurrentDatabase, concurrentState)),
  Promise.resolve().then(() => reserveAttempt(concurrentDatabase, concurrentState)),
]);
assert.equal(concurrentReservations.filter(Boolean).length, 1);

const expiredDatabase = createDatabase();
const expiredState = generateState();
registerAttempt(expiredDatabase, expiredState);
expiredDatabase.now += 600_001;
assert.equal(reserveAttempt(expiredDatabase, expiredState), null);
assert.equal([...expiredDatabase.attempts.values()][0].errorCode, "state_expirado");

const failedDatabase = createDatabase();
const failedState = generateState();
const failedId = registerAttempt(failedDatabase, failedState);
assert.equal(reserveAttempt(failedDatabase, failedState), failedId);
failedDatabase.externalCalls += 1;
assert.equal(failAttempt(failedDatabase, failedId, "troca_recusada"), true);
assert.equal([...failedDatabase.attempts.values()][0].failedAt, failedDatabase.now);
assert.equal(reserveAttempt(failedDatabase, failedState), null);
assert.equal(failedDatabase.connections.size, 0);

const invalidFailureDatabase = createDatabase();
const invalidFailureState = generateState();
const invalidFailureId = registerAttempt(invalidFailureDatabase, invalidFailureState);
reserveAttempt(invalidFailureDatabase, invalidFailureState);
assert.equal(failAttempt(invalidFailureDatabase, invalidFailureId, "mensagem_externa_livre"), false);

const rollbackDatabase = createDatabase();
const rollbackState = generateState();
const rollbackId = registerAttempt(rollbackDatabase, rollbackState);
reserveAttempt(rollbackDatabase, rollbackState);
assert.throws(() => completeAttempt(rollbackDatabase, rollbackId, 303, true), /rollback/);
assert.equal(rollbackDatabase.connections.size, 0);
assert.equal([...rollbackDatabase.attempts.values()][0].status, "reservada");

const orderingDatabase = createDatabase();
const oldState = generateState();
const oldId = registerAttempt(orderingDatabase, oldState);
reserveAttempt(orderingDatabase, oldState);
orderingDatabase.now += 1;
const newState = generateState();
const newId = registerAttempt(orderingDatabase, newState);
reserveAttempt(orderingDatabase, newState);
assert.equal(completeAttempt(orderingDatabase, newId, 404), true);
assert.equal(completeAttempt(orderingDatabase, oldId, 404), false);
assert.equal(orderingDatabase.connections.get(404).oauthAttemptId, newId);

const equalTimestampDatabase = createDatabase();
const equalOldState = generateState();
const equalOldId = registerAttempt(equalTimestampDatabase, equalOldState);
reserveAttempt(equalTimestampDatabase, equalOldState);
const equalNewState = generateState();
const equalNewId = registerAttempt(equalTimestampDatabase, equalNewState);
reserveAttempt(equalTimestampDatabase, equalNewState);
const equalOldAttempt = [...equalTimestampDatabase.attempts.values()].find((item) => item.id === equalOldId);
const equalNewAttempt = [...equalTimestampDatabase.attempts.values()].find((item) => item.id === equalNewId);
assert.equal(equalNewAttempt.createdAt, equalOldAttempt.createdAt);
assert.ok(equalNewAttempt.order > equalOldAttempt.order);
assert.equal(completeAttempt(equalTimestampDatabase, equalOldId, 505), true);
assert.equal(completeAttempt(equalTimestampDatabase, equalNewId, 505), true);
assert.equal(equalTimestampDatabase.connections.get(505).oauthAttemptId, equalNewId);

const reverseEqualDatabase = createDatabase();
const reverseOldState = generateState();
const reverseOldId = registerAttempt(reverseEqualDatabase, reverseOldState);
reserveAttempt(reverseEqualDatabase, reverseOldState);
const reverseNewState = generateState();
const reverseNewId = registerAttempt(reverseEqualDatabase, reverseNewState);
reserveAttempt(reverseEqualDatabase, reverseNewState);
assert.equal(completeAttempt(reverseEqualDatabase, reverseNewId, 606), true);
assert.equal(completeAttempt(reverseEqualDatabase, reverseOldId, 606), false);
assert.equal(reverseEqualDatabase.connections.get(606).oauthAttemptId, reverseNewId);

const forbiddenOperations = [
  "registrar_baixa",
  "registrar_contagem",
  "baixas_csv",
  "pedidos",
  "preco_promocional",
];
for (const operation of forbiddenOperations) {
  assert.equal(startSource.includes(operation), false);
  assert.equal(callbackSource.includes(operation), false);
}

console.log("OAuth state local tests passed without external requests.");
