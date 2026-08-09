import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { requiredEnv } from "../_shared/nuvemshop.ts";

const APP_ID = "36716";
const AUTHORIZATION_URL = `https://www.nuvemshop.com.br/apps/${APP_ID}/authorize`;
const STATE_BYTES = 32;

function requestHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin") || "";
  const allowedOrigins = new Set([
    "https://comercial611.github.io",
    "http://localhost:3000",
    "http://localhost:5500",
    "http://localhost:8000",
    "http://127.0.0.1:5500",
    "http://127.0.0.1:8000",
  ]);
  return {
    "Access-Control-Allow-Origin": allowedOrigins.has(origin)
      ? origin
      : "https://comercial611.github.io",
    "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
    "Vary": "Origin",
  };
}

function jsonResponse(
  body: unknown,
  status: number,
  headers: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function bytesToPostgresBytea(bytes: Uint8Array): string {
  return `\\x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

Deno.serve(async (request) => {
  const headers = requestHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") {
    return jsonResponse({ error: "Metodo nao permitido." }, 405, headers);
  }

  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.toLowerCase().startsWith("bearer ")) {
      return jsonResponse({ error: "Usuario nao autenticado." }, 401, headers);
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const anonKey = requiredEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");

    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userType, error: typeError } = await supabaseUser.rpc("usuario_tipo");
    if (typeError || userType !== "admin") {
      return jsonResponse({ error: "Acesso permitido somente para administradores." }, 403, headers);
    }

    const stateBytes = crypto.getRandomValues(new Uint8Array(STATE_BYTES));
    const state = bytesToBase64Url(stateBytes);
    const stateHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)),
    );

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: attemptId, error: attemptError } = await supabaseAdmin.rpc(
      "registrar_tentativa_oauth_nuvemshop",
      { p_state_hash: bytesToPostgresBytea(stateHash) },
    );
    if (attemptError || !attemptId) {
      console.error("oauth_start_registration_failed");
      return jsonResponse({ error: "Nao foi possivel iniciar a conexao." }, 500, headers);
    }

    const authorizationUrl = new URL(AUTHORIZATION_URL);
    authorizationUrl.searchParams.set("state", state);
    return jsonResponse({ url: authorizationUrl.toString() }, 200, headers);
  } catch {
    console.error("oauth_start_unexpected_failure");
    return jsonResponse({ error: "Nao foi possivel iniciar a conexao." }, 500, headers);
  }
});
