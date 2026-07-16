import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { decryptToken, requiredEnv } from "../_shared/nuvemshop.ts";

const USER_AGENT = "Conferencia de Estoque PDS (comercial@comercial.pontodasublimacao.com.br)";
const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function integerOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function hasScope(value: unknown, expectedScope: string): boolean {
  return String(value || "")
    .split(/[\s,]+/)
    .map((scope) => scope.trim().toLowerCase())
    .includes(expectedScope.toLowerCase());
}

function localDestination(product: Record<string, unknown>, voltage: unknown): number | null {
  if (product.tem_voltagem === true) {
    if (voltage === "110V") return integerOrNull(product.quantidade_110v);
    if (voltage === "220V") return integerOrNull(product.quantidade_220v);
    return null;
  }
  return integerOrNull(product.quantidade);
}

function variantStock(variant: Record<string, unknown>, locationId: string): number | null {
  if (Array.isArray(variant.inventory_levels)) {
    const level = variant.inventory_levels
      .map(asRecord)
      .find((item) => item && String(item.location_id || "") === locationId);
    if (level) return integerOrNull(level.stock);
  }
  return integerOrNull(variant.stock);
}

async function loadRemoteProducts(storeId: number, accessToken: string): Promise<unknown[]> {
  const products: unknown[] = [];
  const perPage = 200;

  for (let page = 1; page <= 50; page += 1) {
    const apiUrl = new URL(`https://api.nuvemshop.com.br/v1/${storeId}/products`);
    apiUrl.searchParams.set("page", String(page));
    apiUrl.searchParams.set("per_page", String(perPage));

    const response = await fetch(apiUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": USER_AGENT,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      console.error("Falha ao simular catalogo", response.status);
      throw new Error("A Nuvemshop recusou a consulta usada na simulacao.");
    }

    const pageProducts = await response.json();
    if (!Array.isArray(pageProducts)) throw new Error("Catalogo em formato inesperado.");
    products.push(...pageProducts);
    if (pageProducts.length < perPage) break;
    await wait(550);
  }

  return products;
}

Deno.serve(async (request) => {
  const headers = {
    ...corsHeaders(request),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") {
    return jsonResponse({ error: "Metodo nao permitido." }, 405, headers);
  }

  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.toLowerCase().startsWith("bearer ")) {
      return jsonResponse({ error: "Usuario nao autenticado." }, 401, headers);
    }

    const body = await request.json().catch(() => null);
    const payload = asRecord(body);
    const storeId = Number(payload?.store_id);
    const operationMode = String(payload?.modo || "");
    const requestedAuditId = String(payload?.auditoria_id || "");
    if (!["simular", "verificar_piloto"].includes(operationMode)) {
      return jsonResponse({ error: "Modo de operacao nao permitido." }, 400, headers);
    }
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      return jsonResponse({ error: "Loja Nuvemshop invalida." }, 400, headers);
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const anonKey = requiredEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const encryptionKey = requiredEnv("NUVEMSHOP_TOKEN_ENCRYPTION_KEY");

    const supabaseUser = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [{ data: userType, error: typeError }, userResult] = await Promise.all([
      supabaseUser.rpc("usuario_tipo"),
      supabaseUser.auth.getUser(),
    ]);
    if (typeError || userType !== "admin" || userResult.error || !userResult.data.user) {
      return jsonResponse({ error: "Acesso permitido somente para administradores." }, 403, headers);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: connection, error: connectionError } = await supabaseAdmin
      .from("nuvemshop_conexoes")
      .select("store_id, token_cifrado, token_iv, escopos, local_estoque_id, local_estoque_nome, escrita_habilitada, limite_aplicacao")
      .eq("store_id", storeId)
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection) {
      return jsonResponse({ error: "Loja Nuvemshop nao conectada." }, 409, headers);
    }
    const { data: links, error: linksError } = await supabaseAdmin
      .from("nuvemshop_vinculos")
      .select("id, produto_id, voltagem, nuvemshop_produto_id, nuvemshop_variante_id")
      .eq("store_id", storeId)
      .eq("ativo", true)
      .order("id")
      .limit(501);
    if (linksError) throw linksError;

    if (operationMode === "verificar_piloto") {
      const writeScopeGranted = hasScope(connection.escopos, "write_products");
      const locationConfirmed = Boolean(connection.local_estoque_id);
      const linksWithinLimit = Boolean(links?.length) && links.length <= 500;
      const writeEnabled = connection.escrita_habilitada === true;
      const applicationLimit = integerOrNull(connection.limite_aplicacao) || 1;
      const safePilotLimit = applicationLimit === 1;
      const blockers: string[] = [];
      let simulationValid = false;
      let simulationExpiresAt: string | null = null;

      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedAuditId)) {
        const { data: audit, error: auditError } = await supabaseAdmin
          .from("nuvemshop_sincronizacoes")
          .select("id, store_id, modo, status, solicitado_por, itens_falha, created_at")
          .eq("id", requestedAuditId)
          .eq("store_id", storeId)
          .eq("modo", "simulacao")
          .eq("solicitado_por", userResult.data.user.id)
          .maybeSingle();
        if (auditError) throw auditError;
        if (audit?.created_at) {
          const createdAt = new Date(audit.created_at).getTime();
          const expiresAt = createdAt + 15 * 60 * 1000;
          simulationExpiresAt = new Date(expiresAt).toISOString();
          simulationValid = audit.status === "concluida"
            && Number(audit.itens_falha) === 0
            && Number.isFinite(createdAt)
            && Date.now() <= expiresAt;
        }
      }

      if (!writeScopeGranted) blockers.push("O aplicativo ainda nao possui o escopo write_products.");
      if (!locationConfirmed) blockers.push("O local de estoque ainda nao foi confirmado.");
      if (!links?.length) blockers.push("Nenhum vinculo ativo foi encontrado para esta loja.");
      if (links && links.length > 500) blockers.push("A quantidade de vinculos excede o limite de seguranca.");
      if (!safePilotLimit) blockers.push("O limite do piloto precisa permanecer em um item.");
      if (!simulationValid) blockers.push("A simulacao precisa ser recente, concluida e sem falhas.");
      if (!writeEnabled) blockers.push("O interruptor de escrita da loja permanece desligado.");

      return jsonResponse({
        modo: "verificacao_piloto",
        store_id: storeId,
        escopo_escrita: writeScopeGranted,
        local_confirmado: locationConfirmed,
        local_estoque: locationConfirmed
          ? {
            id: connection.local_estoque_id,
            nome: connection.local_estoque_nome || "Local unico da Nuvemshop",
          }
          : null,
        vinculos_ativos: links?.length || 0,
        vinculos_dentro_limite: linksWithinLimit,
        limite_itens: applicationLimit,
        limite_seguro: safePilotLimit,
        auditoria_id: requestedAuditId || null,
        simulacao_valida: simulationValid,
        simulacao_expira_em: simulationExpiresAt,
        escrita_habilitada: writeEnabled,
        requisitos_atendidos: writeScopeGranted
          && locationConfirmed
          && linksWithinLimit
          && safePilotLimit
          && simulationValid,
        pronto_para_aplicar: blockers.length === 0,
        bloqueios: blockers,
        escrita_executada: false,
      }, 200, { ...headers, "Cache-Control": "no-store" });
    }

    if (!connection.local_estoque_id) {
      return jsonResponse({ error: "Local de estoque ainda nao confirmado." }, 409, headers);
    }
    if (!links?.length) {
      return jsonResponse({ error: "Nenhum vinculo ativo para esta loja." }, 409, headers);
    }
    if (links.length > 500) {
      return jsonResponse({ error: "Quantidade de vinculos acima do limite de seguranca." }, 409, headers);
    }

    const productIds = Array.from(new Set(links.map((item) => item.produto_id)));
    const { data: localProducts, error: productsError } = await supabaseAdmin
      .from("produtos")
      .select("id, nome, tem_voltagem, quantidade, quantidade_110v, quantidade_220v")
      .in("id", productIds);
    if (productsError) throw productsError;
    const localById = new Map(
      (localProducts || []).map((item) => [Number(item.id), item as Record<string, unknown>]),
    );

    const accessToken = await decryptToken(
      connection.token_cifrado,
      connection.token_iv,
      encryptionKey,
    );
    const remoteProducts = await loadRemoteProducts(storeId, accessToken);
    const remoteById = new Map<number, Record<string, unknown>>();
    for (const value of remoteProducts) {
      const product = asRecord(value);
      const productId = integerOrNull(product?.id);
      if (product && productId && productId > 0) remoteById.set(productId, product);
    }

    const items = links.map((link) => {
      const localProduct = localById.get(Number(link.produto_id));
      const remoteProduct = remoteById.get(Number(link.nuvemshop_produto_id));
      const destinationStock = localProduct ? localDestination(localProduct, link.voltagem) : null;
      const variants = Array.isArray(remoteProduct?.variants)
        ? remoteProduct.variants.map(asRecord).filter(Boolean) as Record<string, unknown>[]
        : [];
      const linkedVariantId = integerOrNull(link.nuvemshop_variante_id);
      const remoteVariant = linkedVariantId
        ? variants.find((variant) => integerOrNull(variant.id) === linkedVariantId)
        : variants.length === 1 ? variants[0] : null;
      const currentStock = remoteVariant
        ? variantStock(remoteVariant, String(connection.local_estoque_id))
        : null;

      let status = "alteraria";
      let error: string | null = null;
      if (!localProduct) {
        status = "erro";
        error = "Produto local nao encontrado.";
      } else if (!remoteProduct || !remoteVariant) {
        status = "erro";
        error = "Produto ou variante nao encontrado na Nuvemshop.";
      } else if (destinationStock === null || destinationStock < 0) {
        status = "erro";
        error = "Estoque local invalido.";
      } else if (currentStock !== null && currentStock < 0) {
        status = "erro";
        error = "Estoque externo invalido.";
      } else if (currentStock === null) {
        status = "sem_controle";
      } else if (currentStock === destinationStock) {
        status = "igual";
      }

      return {
        vinculo_id: link.id,
        produto_id: link.produto_id,
        produto_nome: localProduct?.nome || "Produto nao encontrado",
        voltagem: link.voltagem,
        nuvemshop_produto_id: link.nuvemshop_produto_id,
        nuvemshop_variante_id: link.nuvemshop_variante_id,
        estoque_atual: currentStock,
        estoque_destino: destinationStock,
        diferenca: currentStock === null || destinationStock === null
          ? null
          : destinationStock - currentStock,
        status,
        erro: error,
      };
    });

    const summary = {
      vinculados: items.length,
      iguais: items.filter((item) => item.status === "igual").length,
      alterariam: items.filter((item) => item.status === "alteraria").length,
      sem_controle: items.filter((item) => item.status === "sem_controle").length,
      erros: items.filter((item) => item.status === "erro").length,
    };

    const operationId = crypto.randomUUID();
    const generatedAt = new Date().toISOString();
    const { data: auditId, error: auditError } = await supabaseAdmin.rpc(
      "registrar_auditoria_simulacao_nuvemshop",
      {
        p_chave_operacao: operationId,
        p_store_id: storeId,
        p_local_estoque_id: connection.local_estoque_id,
        p_solicitado_por: userResult.data.user.id,
        p_itens: items,
      },
    );
    if (auditError || !auditId) {
      console.error("Falha ao registrar auditoria", auditError?.message || "ID ausente");
      throw new Error("A simulacao foi calculada, mas a auditoria nao foi registrada.");
    }

    return jsonResponse({
      modo: "simulacao",
      operacao_id: operationId,
      auditoria_id: auditId,
      store_id: storeId,
      local_estoque: {
        id: connection.local_estoque_id,
        nome: connection.local_estoque_nome || "Local unico da Nuvemshop",
      },
      solicitado_por: userResult.data.user.id,
      gerado_em: generatedAt,
      resumo: summary,
      itens: items,
      escrita_habilitada: false,
    }, 200, { ...headers, "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Erro na simulacao Nuvemshop", error instanceof Error ? error.message : error);
    return jsonResponse({ error: "Nao foi possivel gerar a simulacao segura." }, 500, headers);
  }
});
