import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { encryptToken, requiredEnv } from "../_shared/nuvemshop.ts";

function htmlPage(title: string, message: string, success: boolean): Response {
  const color = success ? "#15803d" : "#b91c1c";
  return new Response(`<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (request) => {
  if (request.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const requestUrl = new URL(request.url);
    const code = requestUrl.searchParams.get("code")?.trim();
    if (!code) {
      return htmlPage(
        "Instalacao nao concluida",
        "A Nuvemshop nao enviou o codigo de autorizacao. Volte ao painel e tente instalar novamente.",
        false,
      );
    }

    const appId = requiredEnv("NUVEMSHOP_APP_ID");
    const clientSecret = requiredEnv("NUVEMSHOP_CLIENT_SECRET");
    const encryptionKey = requiredEnv("NUVEMSHOP_TOKEN_ENCRYPTION_KEY");
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const redirectUrl = `${supabaseUrl}/functions/v1/nuvemshop-oauth`;

    const tokenResponse = await fetch("https://www.tiendanube.com/apps/authorize/token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: appId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUrl,
      }),
    });

    if (!tokenResponse.ok) {
      console.error("Falha OAuth Nuvemshop", tokenResponse.status);
      return htmlPage(
        "Instalacao nao concluida",
        "Nao foi possivel autorizar a conexao. Volte ao painel e tente novamente.",
        false,
      );
    }

    const tokenData = await tokenResponse.json();
    const accessToken = String(tokenData.access_token || "").trim();
    const storeId = Number(tokenData.user_id);
    const scopes = tokenData.scope ? String(tokenData.scope) : "read_products";
    const writeProductsGranted = scopes
      .split(/[\s,]+/)
      .map((scope) => scope.trim().toLowerCase())
      .includes("write_products");
    if (!accessToken || !Number.isSafeInteger(storeId) || storeId <= 0) {
      throw new Error("Resposta OAuth sem token ou identificacao da loja.");
    }

    const encrypted = await encryptToken(accessToken, encryptionKey);
    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { error } = await supabaseAdmin.from("nuvemshop_conexoes").upsert({
      store_id: storeId,
      token_cifrado: encrypted.cipherText,
      token_iv: encrypted.iv,
      escopos: scopes,
      conectado_em: new Date().toISOString(),
      escrita_habilitada: false,
      escrita_habilitada_em: null,
      escrita_habilitada_por: null,
      escrita_habilitada_ate: null,
      escrita_simulacao_id: null,
    });
    if (error) throw error;

    return htmlPage(
      "Nuvemshop conectada",
      writeProductsGranted
        ? "A autorizacao de leitura e escrita foi concluida. A escrita permanece bloqueada ate um administrador abrir a janela temporaria do piloto."
        : "A autorizacao foi concluida com acesso somente de leitura. Voce ja pode fechar esta pagina.",
      true,
    );
  } catch (error) {
    console.error("Erro no retorno OAuth", error instanceof Error ? error.message : error);
    return htmlPage(
      "Instalacao nao concluida",
      "Ocorreu um erro ao proteger a conexao. Nenhum estoque foi alterado.",
      false,
    );
  }
});
