import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptToken, requiredEnv } from "../_shared/nuvemshop.ts";
import {
  buildOAuthResultCookie,
  readOAuthCallbackParameters,
} from "./oauth-helpers.mjs";

const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const HTML_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const ADMIN_OAUTH_FINAL_URL = "https://comercial611.github.io/docker-ponto/admin.html?nuvemshop_oauth=finalizado";

function adminResultRedirect(): Response {
  return new Response(null, {
    status: 303,
    headers: {
      "Location": ADMIN_OAUTH_FINAL_URL,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY,
      "Set-Cookie": buildOAuthResultCookie("", 0),
    },
  });
}

function isFinalResultRequest(request: Request): boolean {
  const requestUrl = new URL(request.url);
  const finalValues = requestUrl.searchParams.getAll("final");
  const queryKeys = Array.from(requestUrl.searchParams.keys());
  if (
    requestUrl.hash
    || finalValues.length !== 1
    || finalValues[0] !== "1"
    || queryKeys.length !== 1
    || queryKeys[0] !== "final"
  ) return false;
  return true;
}

function bytesToPostgresBytea(bytes: Uint8Array): string {
  return `\\x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

async function recordAttemptFailure(
  supabaseAdmin: ReturnType<typeof createClient>,
  attemptId: string,
  errorCode: string,
): Promise<void> {
  try {
    await supabaseAdmin.rpc("falhar_tentativa_oauth_nuvemshop", {
      p_tentativa_id: attemptId,
      p_erro_codigo: errorCode,
    });
  } catch {
    // A tentativa permanece consumida mesmo se o registro auxiliar da falha indisponibilizar.
  }
}

Deno.serve(async (request) => {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let attemptId: string | null = null;
  let supabaseAdmin: ReturnType<typeof createClient> | null = null;
  try {
    const requestUrl = new URL(request.url);
    if (isFinalResultRequest(request)) return adminResultRedirect();

    const callbackParameters = readOAuthCallbackParameters(requestUrl.searchParams);
    if (!callbackParameters) return adminResultRedirect();
    const { code, state } = callbackParameters;

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const stateHash = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(state)),
    );
    const { data: reservedAttemptId, error: reserveError } = await supabaseAdmin.rpc(
      "reservar_tentativa_oauth_nuvemshop",
      { p_state_hash: bytesToPostgresBytea(stateHash) },
    );
    if (reserveError || typeof reservedAttemptId !== "string" || !reservedAttemptId) {
      console.error("oauth_reservation_rejected");
      return adminResultRedirect();
    }
    attemptId = reservedAttemptId;

    const appId = requiredEnv("NUVEMSHOP_APP_ID");
    const clientSecret = requiredEnv("NUVEMSHOP_CLIENT_SECRET");
    const encryptionKey = requiredEnv("NUVEMSHOP_TOKEN_ENCRYPTION_KEY");
    const redirectUrl = `${supabaseUrl}/functions/v1/nuvemshop-oauth`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TOKEN_EXCHANGE_TIMEOUT_MS);
    let tokenResponse: Response;
    try {
      tokenResponse = await fetch("https://www.tiendanube.com/apps/authorize/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: appId,
          client_secret: clientSecret,
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUrl,
        }),
        signal: controller.signal,
      });
    } catch {
      const errorCode = controller.signal.aborted ? "troca_timeout" : "troca_indisponivel";
      await recordAttemptFailure(supabaseAdmin, attemptId, errorCode);
      console.error(controller.signal.aborted
        ? "oauth_token_exchange_timeout"
        : "oauth_token_exchange_unavailable");
      return adminResultRedirect();
    } finally {
      clearTimeout(timeoutId);
    }

    if (!tokenResponse.ok) {
      await recordAttemptFailure(supabaseAdmin, attemptId, "troca_recusada");
      console.error("oauth_token_exchange_rejected", tokenResponse.status);
      return adminResultRedirect();
    }

    let tokenData: Record<string, unknown>;
    try {
      tokenData = await tokenResponse.json();
    } catch {
      await recordAttemptFailure(supabaseAdmin, attemptId, "resposta_invalida");
      return adminResultRedirect();
    }

    const accessToken = String(tokenData.access_token || "").trim();
    const storeId = Number(tokenData.user_id);
    const scopes = tokenData.scope ? String(tokenData.scope) : "read_products";
    if (!accessToken || !Number.isSafeInteger(storeId) || storeId <= 0) {
      await recordAttemptFailure(supabaseAdmin, attemptId, "resposta_invalida");
      return adminResultRedirect();
    }

    let encrypted: { cipherText: string; iv: string };
    try {
      encrypted = await encryptToken(accessToken, encryptionKey);
    } catch {
      await recordAttemptFailure(supabaseAdmin, attemptId, "protecao_token_falhou");
      return adminResultRedirect();
    }

    const { data: completed, error: completionError } = await supabaseAdmin.rpc(
      "concluir_tentativa_oauth_nuvemshop",
      {
        p_tentativa_id: attemptId,
        p_store_id: storeId,
        p_token_cifrado: encrypted.cipherText,
        p_token_iv: encrypted.iv,
        p_escopos: scopes,
      },
    );
    if (completionError || completed !== true) {
      if (completionError) {
        await recordAttemptFailure(supabaseAdmin, attemptId, "finalizacao_falhou");
      }
      console.error("oauth_completion_rejected");
      return adminResultRedirect();
    }

    return adminResultRedirect();
  } catch {
    if (supabaseAdmin && attemptId) {
      await recordAttemptFailure(supabaseAdmin, attemptId, "falha_inesperada");
    }
    console.error("oauth_callback_unexpected_failure");
    return adminResultRedirect();
  }
});
