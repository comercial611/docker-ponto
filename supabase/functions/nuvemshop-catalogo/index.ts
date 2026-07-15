import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { decryptToken, requiredEnv } from "../_shared/nuvemshop.ts";

const USER_AGENT = "Conferencia de Estoque PDS (comercial@comercial.pontodasublimacao.com.br)";
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

Deno.serve(async (request) => {
  const headers = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "GET") return jsonResponse({ error: "Metodo nao permitido." }, 405, headers);

  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.toLowerCase().startsWith("bearer ")) {
      return jsonResponse({ error: "Usuario nao autenticado." }, 401, headers);
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const anonKey = requiredEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const encryptionKey = requiredEnv("NUVEMSHOP_TOKEN_ENCRYPTION_KEY");

    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userType, error: typeError } = await supabaseUser.rpc("usuario_tipo");
    if (typeError || userType !== "admin") {
      return jsonResponse({ error: "Acesso permitido somente para administradores." }, 403, headers);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: connection, error: connectionError } = await supabaseAdmin
      .from("nuvemshop_conexoes")
      .select("store_id, token_cifrado, token_iv")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection) {
      return jsonResponse({ error: "A Nuvemshop ainda nao foi conectada." }, 409, headers);
    }

    const accessToken = await decryptToken(
      connection.token_cifrado,
      connection.token_iv,
      encryptionKey,
    );
    const products: unknown[] = [];
    const perPage = 200;

    for (let page = 1; page <= 50; page += 1) {
      const apiUrl = new URL(`https://api.nuvemshop.com.br/v1/${connection.store_id}/products`);
      apiUrl.searchParams.set("page", String(page));
      apiUrl.searchParams.set("per_page", String(perPage));

      const apiResponse = await fetch(apiUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
        },
      });
      if (!apiResponse.ok) {
        console.error("Falha ao consultar catalogo", apiResponse.status);
        return jsonResponse({ error: "A Nuvemshop recusou a consulta do catalogo." }, 502, headers);
      }

      const pageProducts = await apiResponse.json();
      if (!Array.isArray(pageProducts)) throw new Error("Resposta de produtos em formato inesperado.");
      products.push(...pageProducts);
      if (pageProducts.length < perPage) break;
      await wait(550);
    }

    return jsonResponse({
      store_id: connection.store_id,
      total: products.length,
      produtos: products,
    }, 200, { ...headers, "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Erro ao consultar catalogo", error instanceof Error ? error.message : error);
    return jsonResponse({ error: "Nao foi possivel consultar o catalogo." }, 500, headers);
  }
});
