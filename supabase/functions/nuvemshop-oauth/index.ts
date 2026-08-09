import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptToken, requiredEnv } from "../_shared/nuvemshop.ts";
import {
  buildCleanOAuthResultUrl,
  buildOAuthResultCookie,
  OAUTH_RESULT_COOKIE_NAME,
  readFixedResultCookie,
  readOAuthCallbackParameters,
} from "./oauth-helpers.mjs";

const TOKEN_EXCHANGE_TIMEOUT_MS = 10_000;
const HTML_CONTENT_SECURITY_POLICY = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const RESULT_PAGES = Object.freeze({
  sucesso_escrita: {
    title: "Nuvemshop conectada",
    message: "A autorizacao de leitura e escrita foi concluida. A escrita permanece bloqueada ate um administrador abrir a janela temporaria do piloto.",
    success: true,
  },
  sucesso_leitura: {
    title: "Nuvemshop conectada",
    message: "A autorizacao foi concluida com acesso somente de leitura. Voce ja pode fechar esta pagina.",
    success: true,
  },
  autorizacao_invalida: {
    title: "Instalacao nao concluida",
    message: "A autorizacao recebida nao e valida. Inicie uma nova conexao pelo painel administrativo.",
    success: false,
  },
  autorizacao_utilizada: {
    title: "Instalacao nao concluida",
    message: "A autorizacao expirou ou ja foi utilizada. Inicie uma nova conexao pelo painel administrativo.",
    success: false,
  },
  troca_indisponivel: {
    title: "Instalacao nao concluida",
    message: "Nao foi possivel concluir a autorizacao. Inicie uma nova conexao pelo painel administrativo.",
    success: false,
  },
  resposta_invalida: {
    title: "Instalacao nao concluida",
    message: "A resposta da autorizacao nao foi reconhecida. Inicie uma nova conexao.",
    success: false,
  },
  protecao_falhou: {
    title: "Instalacao nao concluida",
    message: "Nao foi possivel proteger a conexao. Inicie uma nova autorizacao.",
    success: false,
  },
  finalizacao_rejeitada: {
    title: "Instalacao nao concluida",
    message: "Esta autorizacao nao pode mais ser concluida. Inicie uma nova conexao.",
    success: false,
  },
  falha_inesperada: {
    title: "Instalacao nao concluida",
    message: "Ocorreu um erro ao proteger a conexao. Inicie uma nova autorizacao pelo painel.",
    success: false,
  },
});
type ResultCode = keyof typeof RESULT_PAGES;

function htmlPage(
  title: string,
  message: string,
  success: boolean,
  extraHeaders: Record<string, string> = {},
): Response {
  const color = success ? "#15803d" : "#b91c1c";
  return new Response(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>${title}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 32px; background: #f8fafc; color: #111827; }
    main { max-width: 560px; margin: 12vh auto; background: white; border: 1px solid #e5e7eb; padding: 28px; border-radius: 8px; }
    h1 { color: ${color}; font-size: 24px; }
    p { line-height: 1.5; }
  </style>
</head>
<body><main><h1>${title}</h1><p>${message}</p></main></body>
</html>`, {
    status: success ? 200 : 400,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY,
      ...extraHeaders,
    },
  });
}

function cleanResultRedirect(cleanResultUrl: string, result: ResultCode): Response {
  return new Response(null, {
    status: 303,
    headers: {
      "Location": cleanResultUrl,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Set-Cookie": buildOAuthResultCookie(result, 60),
    },
  });
}

function resultPage(request: Request): Response | null {
  const requestUrl = new URL(request.url);
  const finalValues = requestUrl.searchParams.getAll("final");
  const queryKeys = Array.from(requestUrl.searchParams.keys());
  if (
    requestUrl.hash
    || finalValues.length !== 1
    || finalValues[0] !== "1"
    || queryKeys.length !== 1
    || queryKeys[0] !== "final"
  ) return null;
  const cookie = readFixedResultCookie(
    request.headers.get("cookie"),
    OAUTH_RESULT_COOKIE_NAME,
    new Set(Object.keys(RESULT_PAGES)),
  );
  const clearHeaders = cookie.shouldClear
    ? { "Set-Cookie": buildOAuthResultCookie("", 0) }
    : {};
  if (!cookie.result || !Object.prototype.hasOwnProperty.call(RESULT_PAGES, cookie.result)) {
    return htmlPage(
      "Processamento finalizado",
      "Volte ao painel administrativo para verificar o estado da conexao.",
      false,
      clearHeaders,
    );
  }
  const page = RESULT_PAGES[cookie.result as ResultCode];
  return htmlPage(page.title, page.message, page.success, {
    "Set-Cookie": buildOAuthResultCookie("", 0),
  });
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
  let cleanResultUrl: string;
  try {
    cleanResultUrl = buildCleanOAuthResultUrl(requiredEnv("SUPABASE_URL"));
  } catch {
    console.error("oauth_callback_invalid_environment");
    return htmlPage(
      "Instalacao nao concluida",
      "Nao foi possivel concluir a autorizacao. Tente novamente mais tarde.",
      false,
    );
  }
  try {
    const requestUrl = new URL(request.url);
    const existingResultPage = resultPage(request);
    if (existingResultPage) return existingResultPage;

    const callbackParameters = readOAuthCallbackParameters(requestUrl.searchParams);
    if (!callbackParameters) return cleanResultRedirect(cleanResultUrl, "autorizacao_invalida");
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
      return cleanResultRedirect(cleanResultUrl, "autorizacao_utilizada");
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
      return cleanResultRedirect(cleanResultUrl, "troca_indisponivel");
    } finally {
      clearTimeout(timeoutId);
    }

    if (!tokenResponse.ok) {
      await recordAttemptFailure(supabaseAdmin, attemptId, "troca_recusada");
      console.error("oauth_token_exchange_rejected", tokenResponse.status);
      return cleanResultRedirect(cleanResultUrl, "troca_indisponivel");
    }

    let tokenData: Record<string, unknown>;
    try {
      tokenData = await tokenResponse.json();
    } catch {
      await recordAttemptFailure(supabaseAdmin, attemptId, "resposta_invalida");
      return cleanResultRedirect(cleanResultUrl, "resposta_invalida");
    }

    const accessToken = String(tokenData.access_token || "").trim();
    const storeId = Number(tokenData.user_id);
    const scopes = tokenData.scope ? String(tokenData.scope) : "read_products";
    const writeProductsGranted = scopes
      .split(/[\s,]+/)
      .map((scope) => scope.trim().toLowerCase())
      .includes("write_products");
    if (!accessToken || !Number.isSafeInteger(storeId) || storeId <= 0) {
      await recordAttemptFailure(supabaseAdmin, attemptId, "resposta_invalida");
      return cleanResultRedirect(cleanResultUrl, "resposta_invalida");
    }

    let encrypted: { cipherText: string; iv: string };
    try {
      encrypted = await encryptToken(accessToken, encryptionKey);
    } catch {
      await recordAttemptFailure(supabaseAdmin, attemptId, "protecao_token_falhou");
      return cleanResultRedirect(cleanResultUrl, "protecao_falhou");
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
      return cleanResultRedirect(cleanResultUrl, "finalizacao_rejeitada");
    }

    return cleanResultRedirect(
      cleanResultUrl,
      writeProductsGranted ? "sucesso_escrita" : "sucesso_leitura",
    );
  } catch {
    if (supabaseAdmin && attemptId) {
      await recordAttemptFailure(supabaseAdmin, attemptId, "falha_inesperada");
    }
    console.error("oauth_callback_unexpected_failure");
    return cleanResultRedirect(cleanResultUrl, "falha_inesperada");
  }
});
