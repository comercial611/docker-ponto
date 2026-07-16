import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { decryptToken, requiredEnv } from "../_shared/nuvemshop.ts";

const USER_AGENT = "Conferencia de Estoque PDS (comercial@comercial.pontodasublimacao.com.br)";
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function inferLocationsFromProducts(products: unknown[]): Array<Record<string, unknown>> {
  const locationIds = new Set<string>();

  for (const productValue of products) {
    if (!productValue || typeof productValue !== "object") continue;
    const product = productValue as Record<string, unknown>;
    if (!Array.isArray(product.variants)) continue;

    for (const variantValue of product.variants) {
      if (!variantValue || typeof variantValue !== "object") continue;
      const variant = variantValue as Record<string, unknown>;
      if (!Array.isArray(variant.inventory_levels)) continue;

      for (const levelValue of variant.inventory_levels) {
        if (!levelValue || typeof levelValue !== "object") continue;
        const locationId = String((levelValue as Record<string, unknown>).location_id || "").trim();
        if (locationId) locationIds.add(locationId);
      }
    }
  }

  return Array.from(locationIds, (id, index) => ({
    id,
    nome: locationIds.size === 1 ? "Local unico da Nuvemshop" : `Local ${index + 1}`,
    padrao: locationIds.size === 1,
    prioridade: index,
    origem: "catalogo",
  }));
}

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
    const requestedStoreId = Number(new URL(request.url).searchParams.get("store_id"));
    let connectionQuery = supabaseAdmin
      .from("nuvemshop_conexoes")
      .select("store_id, token_cifrado, token_iv, local_estoque_id, local_estoque_nome")
      .order("updated_at", { ascending: false });
    if (Number.isSafeInteger(requestedStoreId) && requestedStoreId > 0) {
      connectionQuery = connectionQuery.eq("store_id", requestedStoreId);
    } else {
      connectionQuery = connectionQuery.limit(2);
    }

    const { data: connections, error: connectionError } = await connectionQuery;
    if (connectionError) throw connectionError;
    if (!connections?.length) {
      return jsonResponse({ error: "A Nuvemshop ainda nao foi conectada." }, 409, headers);
    }
    if (connections.length > 1) {
      return jsonResponse({
        error: "Selecione a loja Nuvemshop que deseja consultar.",
        lojas: connections.map((item) => item.store_id),
      }, 409, headers);
    }
    const connection = connections[0];

    const accessToken = await decryptToken(
      connection.token_cifrado,
      connection.token_iv,
      encryptionKey,
    );
    const products: unknown[] = [];
    const perPage = 200;
    let locations: Array<Record<string, unknown>> = [];
    let locationCheckError: string | null = null;

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

    locations = inferLocationsFromProducts(products);
    if (locations.length === 0 && connection.local_estoque_id) {
      locations = [{
        id: connection.local_estoque_id,
        nome: connection.local_estoque_nome || "Local unico da Nuvemshop",
        padrao: true,
        prioridade: 0,
        origem: "cache",
      }];
    }
    if (locations.length === 0) {
      locationCheckError = "Nao foi possivel identificar o local de estoque pelo catalogo.";
    }

    const singleLocation = locations.length === 1 ? locations[0] : null;
    if (!locationCheckError) {
      const { error: locationSaveError } = await supabaseAdmin
        .from("nuvemshop_conexoes")
        .update({
          local_estoque_id: singleLocation?.id || null,
          local_estoque_nome: singleLocation?.nome || null,
          locais_verificados_em: new Date().toISOString(),
        })
        .eq("store_id", connection.store_id);
      if (locationSaveError) throw locationSaveError;
    }

    return jsonResponse({
      store_id: connection.store_id,
      estoque_local: {
        status: locationCheckError
          ? "indisponivel"
          : locations.length === 1
            ? "unico"
            : locations.length > 1 ? "multiplo" : "nao_encontrado",
        total: locations.length,
        local: singleLocation,
        locais: locations,
        erro: locationCheckError,
        http_status: null,
      },
      total: products.length,
      produtos: products,
    }, 200, { ...headers, "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Erro ao consultar catalogo", error instanceof Error ? error.message : error);
    return jsonResponse({ error: "Nao foi possivel consultar o catalogo." }, 500, headers);
  }
});
