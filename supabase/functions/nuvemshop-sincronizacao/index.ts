import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { decryptToken, requiredEnv } from "../_shared/nuvemshop.ts";

const USER_AGENT = "Conferencia de Estoque PDS (comercial@comercial.pontodasublimacao.com.br)";
const PILOT_CONFIRMATION = "APLICAR 1 ITEM";
const PILOT_WINDOW_CONFIRMATION = "LIBERAR PILOTO POR 5 MINUTOS";
const BATCH_MAX_ITEMS = 10;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
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

function isPilotWindowActive(connection: Record<string, unknown>): boolean {
  const expiresAt = new Date(String(connection.escrita_habilitada_ate || "")).getTime();
  return connection.escrita_habilitada === true
    && Number.isFinite(expiresAt)
    && expiresAt > Date.now();
}

function localDestination(product: Record<string, unknown>, voltage: unknown): number | null {
  if (product.tem_voltagem === true) {
    if (voltage === "110V") return integerOrNull(product.quantidade_110v);
    if (voltage === "220V") return integerOrNull(product.quantidade_220v);
    return null;
  }
  return integerOrNull(product.quantidade);
}

function stockForOffer(physicalStock: number | null, unitsPerSaleValue: unknown): number | null {
  const unitsPerSale = integerOrNull(unitsPerSaleValue);
  if (
    physicalStock === null
    || physicalStock < 0
    || unitsPerSale === null
    || unitsPerSale < 1
    || unitsPerSale > 10000
  ) return null;
  return Math.floor(physicalStock / unitsPerSale);
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

function strictVariantStock(variant: Record<string, unknown>, locationId: string): number | null {
  if (!Array.isArray(variant.inventory_levels)) return null;
  const level = variant.inventory_levels
    .map(asRecord)
    .find((item) => item && String(item.location_id || "") === locationId);
  return level ? integerOrNull(level.stock) : null;
}

function findRemoteVariant(
  product: Record<string, unknown>,
  variantId: number,
): Record<string, unknown> | null {
  if (!Array.isArray(product.variants)) return null;
  return product.variants
    .map(asRecord)
    .find((variant) => variant && integerOrNull(variant.id) === variantId) || null;
}

function nuvemshopHeaders(accessToken: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": USER_AGENT,
    "Content-Type": "application/json",
  };
}

async function loadRemoteProduct(
  storeId: number,
  productId: number,
  accessToken: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `https://api.nuvemshop.com.br/v1/${storeId}/products/${productId}`,
    {
      headers: nuvemshopHeaders(accessToken),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok) {
    console.error("Falha ao consultar produto do piloto", response.status);
    throw new Error(`Consulta externa recusada (HTTP ${response.status}).`);
  }

  const product = asRecord(await response.json());
  if (!product || integerOrNull(product.id) !== productId) {
    throw new Error("Produto externo retornado em formato inesperado.");
  }
  return product;
}

async function replaceRemoteVariantStock(
  storeId: number,
  productId: number,
  variantId: number,
  locationId: string,
  destinationStock: number,
  accessToken: string,
): Promise<Response> {
  return fetch(
    `https://api.nuvemshop.com.br/v1/${storeId}/products/${productId}/variants/stock`,
    {
      method: "POST",
      headers: nuvemshopHeaders(accessToken),
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        action: "replace",
        value: destinationStock,
        location_id: locationId,
        id: variantId,
      }),
    },
  );
}

async function finalizePilot(
  supabaseAdmin: ReturnType<typeof createClient>,
  applicationId: string,
  result: "concluida" | "parcial" | "falhou",
  confirmedStock: number | null,
  errorMessage: string | null,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc(
    "finalizar_aplicacao_piloto_nuvemshop",
    {
      p_aplicacao_id: applicationId,
      p_resultado: result,
      p_estoque_confirmado: confirmedStock,
      p_erro: errorMessage,
    },
  );
  if (error) {
    console.error("Falha ao finalizar auditoria do piloto", error.message);
    throw new Error("A tentativa terminou, mas a auditoria nao foi finalizada.");
  }
}

async function disablePilotWindow(
  supabaseAdmin: ReturnType<typeof createClient>,
  storeId: number,
  auditId: string | null,
  userId: string,
): Promise<void> {
  const { error } = await supabaseAdmin.rpc(
    "configurar_janela_piloto_nuvemshop",
    {
      p_store_id: storeId,
      p_simulacao_id: auditId,
      p_solicitado_por: userId,
      p_habilitar: false,
      p_confirmacao: null,
    },
  );
  if (error) {
    console.error("Falha ao fechar janela do piloto", error.message);
  }
}

async function processReservedBatchItem(
  supabaseAdmin: ReturnType<typeof createClient>,
  storeId: number,
  applicationId: string,
  reservedItem: Record<string, unknown>,
  expectedAuditId: string,
  expectedUserId: string,
  expectedLimit: number,
  expectedLocationId: string,
  encryptionKey: string,
): Promise<{
  result: "concluido" | "falhou";
  confirmedStock: number | null;
  error: string | null;
  uncertain: boolean;
}> {
  const itemId = integerOrNull(reservedItem.id);
  const productId = integerOrNull(reservedItem.nuvemshop_produto_id);
  const variantId = integerOrNull(reservedItem.nuvemshop_variante_id);
  const previousStock = integerOrNull(reservedItem.estoque_anterior);
  const destinationStock = integerOrNull(reservedItem.estoque_destino);
  const unitsPerSale = integerOrNull(reservedItem.unidades_por_venda);
  if (
    !itemId
    || !productId
    || !variantId
    || previousStock === null
    || destinationStock === null
    || !unitsPerSale
  ) {
    return {
      result: "falhou",
      confirmedStock: null,
      error: "Item reservado possui dados externos incompletos.",
      uncertain: false,
    };
  }

  let writeAttempted = false;
  let confirmedStock: number | null = null;
  try {
    const { data: latestConnection, error: latestConnectionError } = await supabaseAdmin
      .from("nuvemshop_conexoes")
      .select("token_cifrado, token_iv, escopos, local_estoque_id, escrita_habilitada, escrita_habilitada_ate, escrita_simulacao_id, escrita_habilitada_por, limite_aplicacao")
      .eq("store_id", storeId)
      .single();
    if (latestConnectionError || !latestConnection) {
      throw new Error("A conexao nao pode ser revalidada.");
    }
    if (
      !isPilotWindowActive(latestConnection as Record<string, unknown>)
      || integerOrNull(latestConnection.limite_aplicacao) !== expectedLimit
      || !hasScope(latestConnection.escopos, "write_products")
      || String(latestConnection.local_estoque_id || "") !== expectedLocationId
      || String(latestConnection.escrita_simulacao_id || "") !== expectedAuditId
      || String(latestConnection.escrita_habilitada_por || "") !== expectedUserId
    ) {
      throw new Error("As protecoes do lote mudaram depois da reserva.");
    }

    const { data: localProduct, error: localProductError } = await supabaseAdmin
      .from("produtos")
      .select("id, tem_voltagem, quantidade, quantidade_110v, quantidade_220v")
      .eq("id", reservedItem.produto_id)
      .single();
    if (localProductError || !localProduct) {
      throw new Error("Produto local reservado nao foi encontrado.");
    }
    const currentPhysicalStock = localDestination(
      localProduct as Record<string, unknown>,
      reservedItem.voltagem,
    );
    if (stockForOffer(currentPhysicalStock, unitsPerSale) !== destinationStock) {
      throw new Error("O estoque local mudou depois da reserva.");
    }

    const accessToken = await decryptToken(
      latestConnection.token_cifrado,
      latestConnection.token_iv,
      encryptionKey,
    );
    const remoteBefore = await loadRemoteProduct(storeId, productId, accessToken);
    const variantBefore = findRemoteVariant(remoteBefore, variantId);
    const stockBefore = variantBefore
      ? strictVariantStock(variantBefore, expectedLocationId)
      : null;
    if (!variantBefore || stockBefore === null) {
      throw new Error("A variante nao possui estoque no local confirmado.");
    }
    if (stockBefore !== previousStock) {
      throw new Error("O estoque externo mudou desde a simulacao.");
    }

    writeAttempted = true;
    const writeResponse = await replaceRemoteVariantStock(
      storeId,
      productId,
      variantId,
      expectedLocationId,
      destinationStock,
      accessToken,
    );
    await writeResponse.arrayBuffer().catch(() => null);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await wait(attempt === 0 ? 700 : 1300);
      const remoteAfter = await loadRemoteProduct(storeId, productId, accessToken);
      const variantAfter = findRemoteVariant(remoteAfter, variantId);
      confirmedStock = variantAfter
        ? strictVariantStock(variantAfter, expectedLocationId)
        : null;
      if (confirmedStock === destinationStock) break;
    }

    if (confirmedStock === destinationStock) {
      return { result: "concluido", confirmedStock, error: null, uncertain: false };
    }

    const rejected = !writeResponse.ok && confirmedStock === previousStock;
    return {
      result: "falhou",
      confirmedStock,
      error: rejected
        ? `A Nuvemshop recusou a alteracao (HTTP ${writeResponse.status}).`
        : "O resultado externo ficou incerto apos a tentativa.",
      uncertain: !rejected,
    };
  } catch (error) {
    return {
      result: "falhou",
      confirmedStock,
      error: error instanceof Error ? error.message : "Falha inesperada no item do lote.",
      uncertain: writeAttempted,
    };
  }
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
    const requestedAuditItemId = integerOrNull(payload?.item_auditoria_id);
    const requestedBatchItemsValue = payload?.itens_auditoria_ids;
    const requestedBatchItemIds = Array.isArray(requestedBatchItemsValue)
      ? Array.from(new Set(
        requestedBatchItemsValue
          .map(integerOrNull)
          .filter((value): value is number => Boolean(value && value > 0)),
      ))
      : [];
    const requestedConfirmation = String(payload?.confirmacao || "");
    if (![
      "simular",
      "verificar_piloto",
      "habilitar_piloto",
      "desabilitar_piloto",
      "aplicar_piloto",
      "verificar_lote",
      "habilitar_lote",
      "desabilitar_lote",
      "aplicar_lote",
    ].includes(operationMode)) {
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
      .select("store_id, token_cifrado, token_iv, escopos, local_estoque_id, local_estoque_nome, escrita_habilitada, escrita_habilitada_ate, escrita_simulacao_id, escrita_habilitada_por, limite_aplicacao")
      .eq("store_id", storeId)
      .maybeSingle();
    if (connectionError) throw connectionError;
    if (!connection) {
      return jsonResponse({ error: "Loja Nuvemshop nao conectada." }, 409, headers);
    }

    if (operationMode === "desabilitar_piloto" || operationMode === "desabilitar_lote") {
      const batchMode = operationMode === "desabilitar_lote";
      const { error: windowError } = await supabaseAdmin.rpc(
        batchMode
          ? "configurar_janela_lote_nuvemshop"
          : "configurar_janela_piloto_nuvemshop",
        {
          p_store_id: storeId,
          p_simulacao_id: UUID_PATTERN.test(requestedAuditId) ? requestedAuditId : null,
          p_solicitado_por: userResult.data.user.id,
          p_habilitar: false,
          ...(batchMode ? { p_limite: null } : {}),
          p_confirmacao: null,
        },
      );
      if (windowError) {
        console.error("Desligamento da janela do piloto recusado", windowError.message);
        return jsonResponse({
          error: "Nao foi possivel confirmar o desligamento da janela.",
          escrita_executada: false,
        }, 409, { ...headers, "Cache-Control": "no-store" });
      }

      return jsonResponse({
        modo: batchMode ? "janela_lote_desabilitada" : "janela_piloto_desabilitada",
        store_id: storeId,
        auditoria_id: UUID_PATTERN.test(requestedAuditId) ? requestedAuditId : null,
        escrita_habilitada: false,
        escrita_habilitada_ate: null,
        limite_itens: 1,
        escrita_executada: false,
      }, 200, { ...headers, "Cache-Control": "no-store" });
    }

    const { data: links, error: linksError } = await supabaseAdmin
      .from("nuvemshop_vinculos")
      .select("id, produto_id, voltagem, nuvemshop_produto_id, nuvemshop_variante_id, unidades_por_venda")
      .eq("store_id", storeId)
      .eq("ativo", true)
      .order("id")
      .limit(501);
    if (linksError) throw linksError;

    if (operationMode === "habilitar_lote") {
      const batchSize = requestedBatchItemIds.length;
      const expectedConfirmation = `LIBERAR LOTE DE ${batchSize} ITENS POR 5 MINUTOS`;
      if (
        !UUID_PATTERN.test(requestedAuditId)
        || batchSize < 2
        || batchSize > BATCH_MAX_ITEMS
      ) {
        return jsonResponse({
          error: "Selecione de dois a dez itens da simulacao recente.",
          escrita_executada: false,
        }, 400, headers);
      }
      if (requestedConfirmation !== expectedConfirmation) {
        return jsonResponse({
          error: `Digite exatamente "${expectedConfirmation}".`,
          escrita_executada: false,
        }, 400, headers);
      }

      const { data: expiresAt, error: windowError } = await supabaseAdmin.rpc(
        "configurar_janela_lote_nuvemshop",
        {
          p_store_id: storeId,
          p_simulacao_id: requestedAuditId,
          p_solicitado_por: userResult.data.user.id,
          p_habilitar: true,
          p_limite: batchSize,
          p_confirmacao: requestedConfirmation,
        },
      );
      if (windowError) {
        console.error("Janela do lote recusada", windowError.message);
        return jsonResponse({
          error: "A janela do lote nao foi liberada. Gere uma nova validacao.",
          escrita_executada: false,
        }, 409, { ...headers, "Cache-Control": "no-store" });
      }

      return jsonResponse({
        modo: "janela_lote_habilitada",
        store_id: storeId,
        auditoria_id: requestedAuditId,
        escrita_habilitada: true,
        escrita_habilitada_ate: expiresAt,
        limite_itens: batchSize,
        escrita_executada: false,
      }, 200, { ...headers, "Cache-Control": "no-store" });
    }

    if (operationMode === "habilitar_piloto") {
      if (!UUID_PATTERN.test(requestedAuditId)) {
        return jsonResponse({
          error: "Informe a simulacao recente que autorizara a janela.",
          escrita_executada: false,
        }, 400, headers);
      }
      if (requestedConfirmation !== PILOT_WINDOW_CONFIRMATION) {
        return jsonResponse({
          error: `Digite exatamente "${PILOT_WINDOW_CONFIRMATION}".`,
          escrita_executada: false,
        }, 400, headers);
      }
      if (!links?.length || links.length > 500) {
        return jsonResponse({
          error: "Os vinculos ativos nao atendem ao limite de seguranca.",
          escrita_executada: false,
        }, 409, headers);
      }

      const { data: expiresAt, error: windowError } = await supabaseAdmin.rpc(
        "configurar_janela_piloto_nuvemshop",
        {
          p_store_id: storeId,
          p_simulacao_id: requestedAuditId,
          p_solicitado_por: userResult.data.user.id,
          p_habilitar: true,
          p_confirmacao: requestedConfirmation,
        },
      );
      if (windowError) {
        console.error("Janela do piloto recusada", windowError.message);
        return jsonResponse({
          error: "A janela nao foi liberada. Gere uma nova validacao e confira as protecoes.",
          escrita_executada: false,
        }, 409, { ...headers, "Cache-Control": "no-store" });
      }

      return jsonResponse({
        modo: "janela_piloto_habilitada",
        store_id: storeId,
        auditoria_id: requestedAuditId,
        escrita_habilitada: true,
        escrita_habilitada_ate: expiresAt,
        limite_itens: 1,
        escrita_executada: false,
      }, 200, { ...headers, "Cache-Control": "no-store" });
    }

    if (operationMode === "aplicar_lote") {
      const batchSize = requestedBatchItemIds.length;
      const expectedConfirmation = `APLICAR LOTE DE ${batchSize} ITENS`;
      if (
        !UUID_PATTERN.test(requestedAuditId)
        || batchSize < 2
        || batchSize > BATCH_MAX_ITEMS
      ) {
        return jsonResponse({
          error: "Selecione de dois a dez itens da simulacao.",
          escrita_executada: false,
        }, 400, headers);
      }
      if (requestedConfirmation !== expectedConfirmation) {
        return jsonResponse({
          error: `Digite exatamente "${expectedConfirmation}".`,
          escrita_executada: false,
        }, 400, headers);
      }
      if (
        !hasScope(connection.escopos, "write_products")
        || !connection.local_estoque_id
        || !isPilotWindowActive(connection as Record<string, unknown>)
        || String(connection.escrita_simulacao_id || "") !== requestedAuditId
        || String(connection.escrita_habilitada_por || "") !== userResult.data.user.id
        || integerOrNull(connection.limite_aplicacao) !== batchSize
      ) {
        return jsonResponse({
          error: "Aplicacao em lote bloqueada pelas protecoes.",
          escrita_executada: false,
        }, 409, { ...headers, "Cache-Control": "no-store" });
      }

      const operationId = crypto.randomUUID();
      const { data: applicationId, error: reservationError } = await supabaseAdmin.rpc(
        "iniciar_aplicacao_lote_nuvemshop",
        {
          p_chave_operacao: operationId,
          p_simulacao_id: requestedAuditId,
          p_itens_simulacao_ids: requestedBatchItemIds,
          p_store_id: storeId,
          p_solicitado_por: userResult.data.user.id,
        },
      );
      if (reservationError || typeof applicationId !== "string" || !UUID_PATTERN.test(applicationId)) {
        console.error("Reserva do lote recusada", reservationError?.message || "ID ausente");
        return jsonResponse({
          error: "A reserva do lote foi recusada. Gere uma nova simulacao.",
          escrita_executada: false,
        }, 409, { ...headers, "Cache-Control": "no-store" });
      }

      const { data: reservedItems, error: reservedItemsError } = await supabaseAdmin
        .from("nuvemshop_sincronizacao_itens")
        .select("id, origem_item_id, produto_id, voltagem, nuvemshop_produto_id, nuvemshop_variante_id, unidades_por_venda, estoque_anterior, estoque_destino")
        .eq("sincronizacao_id", applicationId);
      if (reservedItemsError || reservedItems?.length !== batchSize) {
        const { error: interruptError } = await supabaseAdmin.rpc(
          "interromper_aplicacao_lote_nuvemshop",
          {
            p_aplicacao_id: applicationId,
            p_motivo: "A reserva do lote nao retornou todos os itens.",
          },
        );
        if (interruptError) {
          console.error("Falha ao interromper reserva incompleta", interruptError.message);
        }
        return jsonResponse({
          error: "A reserva do lote ficou incompleta. Nenhuma escrita foi iniciada.",
          escrita_executada: false,
        }, 409, { ...headers, "Cache-Control": "no-store" });
      }

      const order = new Map(requestedBatchItemIds.map((id, index) => [id, index]));
      reservedItems.sort((a, b) =>
        (order.get(Number(a.origem_item_id)) ?? 99)
        - (order.get(Number(b.origem_item_id)) ?? 99)
      );

      const results: Record<string, unknown>[] = [];
      let interrupted = false;
      for (let itemIndex = 0; itemIndex < reservedItems.length; itemIndex += 1) {
        const reservedItem = reservedItems[itemIndex];
        const itemResult = await processReservedBatchItem(
          supabaseAdmin,
          storeId,
          applicationId,
          reservedItem as Record<string, unknown>,
          requestedAuditId,
          userResult.data.user.id,
          batchSize,
          String(connection.local_estoque_id),
          encryptionKey,
        );
        const itemId = Number(reservedItem.id);
        const { error: finalizeError } = await supabaseAdmin.rpc(
          "finalizar_item_aplicacao_lote_nuvemshop",
          {
            p_aplicacao_id: applicationId,
            p_item_aplicacao_id: itemId,
            p_resultado: itemResult.result,
            p_estoque_confirmado: itemResult.confirmedStock,
            p_erro: itemResult.error,
          },
        );
        if (finalizeError) {
          console.error("Falha ao finalizar item do lote", finalizeError.message);
          itemResult.result = "falhou";
          itemResult.error = "A auditoria do item nao foi finalizada.";
          itemResult.uncertain = true;
        }
        results.push({
          item_auditoria_id: reservedItem.origem_item_id,
          estoque_destino: reservedItem.estoque_destino,
          estoque_confirmado: itemResult.confirmedStock,
          resultado: itemResult.result,
          erro: itemResult.error,
        });

        if (itemResult.result !== "concluido" || itemResult.uncertain) {
          interrupted = true;
          if (finalizeError || itemIndex < reservedItems.length - 1) {
            const { error: interruptError } = await supabaseAdmin.rpc(
              "interromper_aplicacao_lote_nuvemshop",
              {
                p_aplicacao_id: applicationId,
                p_motivo: itemResult.uncertain
                  ? "Lote interrompido por resultado externo incerto."
                  : "Lote interrompido apos falha confirmada.",
              },
            );
            if (interruptError) {
              console.error("Falha ao interromper itens restantes do lote", interruptError.message);
            }
          }
          break;
        }
      }

      return jsonResponse({
        modo: "aplicacao_lote",
        operacao_id: operationId,
        aplicacao_id: applicationId,
        store_id: storeId,
        total_reservado: batchSize,
        total_processado: results.length,
        interrompido: interrupted,
        itens: results,
        escrita_executada: results.some((item) => item.resultado === "concluido"),
        resultado: interrupted ? "interrompido" : "concluida",
      }, interrupted ? 409 : 200, { ...headers, "Cache-Control": "no-store" });
    }

    if (operationMode === "aplicar_piloto") {
      if (!UUID_PATTERN.test(requestedAuditId) || !requestedAuditItemId || requestedAuditItemId <= 0) {
        return jsonResponse({
          error: "Informe a simulacao e o item auditado que sera aplicado.",
          escrita_executada: false,
        }, 400, headers);
      }
      if (requestedConfirmation !== PILOT_CONFIRMATION) {
        return jsonResponse({
          error: `Digite exatamente "${PILOT_CONFIRMATION}" para confirmar.`,
          escrita_executada: false,
        }, 400, headers);
      }

      const blockers: string[] = [];
      if (!hasScope(connection.escopos, "write_products")) {
        blockers.push("O aplicativo nao possui o escopo write_products.");
      }
      if (!connection.local_estoque_id) {
        blockers.push("O local de estoque nao esta confirmado.");
      }
      if (!isPilotWindowActive(connection as Record<string, unknown>)) {
        blockers.push("A janela temporaria de escrita esta fechada ou expirada.");
      }
      if (String(connection.escrita_simulacao_id || "") !== requestedAuditId) {
        blockers.push("A janela temporaria nao pertence a esta simulacao.");
      }
      if (String(connection.escrita_habilitada_por || "") !== userResult.data.user.id) {
        blockers.push("A janela temporaria nao pertence a este administrador.");
      }
      if (integerOrNull(connection.limite_aplicacao) !== 1) {
        blockers.push("O limite do piloto precisa ser exatamente um item.");
      }
      if (!links?.length || links.length > 500) {
        blockers.push("Os vinculos ativos nao atendem ao limite de seguranca.");
      }
      if (blockers.length) {
        if (isPilotWindowActive(connection as Record<string, unknown>)) {
          await disablePilotWindow(
            supabaseAdmin,
            storeId,
            UUID_PATTERN.test(requestedAuditId) ? requestedAuditId : null,
            userResult.data.user.id,
          );
        }
        return jsonResponse({
          error: "Aplicacao piloto bloqueada pelas protecoes.",
          bloqueios: blockers,
          escrita_executada: false,
        }, 409, { ...headers, "Cache-Control": "no-store" });
      }

      const operationId = crypto.randomUUID();
      const { data: applicationId, error: reservationError } = await supabaseAdmin.rpc(
        "iniciar_aplicacao_piloto_nuvemshop",
        {
          p_chave_operacao: operationId,
          p_simulacao_id: requestedAuditId,
          p_item_simulacao_id: requestedAuditItemId,
          p_store_id: storeId,
          p_solicitado_por: userResult.data.user.id,
        },
      );
      if (reservationError || typeof applicationId !== "string" || !UUID_PATTERN.test(applicationId)) {
        console.error("Reserva do piloto recusada", reservationError?.message || "ID ausente");
        await disablePilotWindow(
          supabaseAdmin,
          storeId,
          requestedAuditId,
          userResult.data.user.id,
        );
        return jsonResponse({
          error: "A reserva foi recusada. Gere uma nova simulacao e confira as protecoes.",
          escrita_executada: false,
        }, 409, { ...headers, "Cache-Control": "no-store" });
      }

      let writeAttempted = false;
      let confirmedStock: number | null = null;
      try {
        const { data: reservedItem, error: reservedItemError } = await supabaseAdmin
          .from("nuvemshop_sincronizacao_itens")
          .select("id, produto_id, voltagem, nuvemshop_produto_id, nuvemshop_variante_id, unidades_por_venda, estoque_anterior, estoque_destino")
          .eq("sincronizacao_id", applicationId)
          .single();
        if (reservedItemError || !reservedItem) {
          throw new Error("Item reservado nao foi encontrado.");
        }

        const productId = integerOrNull(reservedItem.nuvemshop_produto_id);
        const variantId = integerOrNull(reservedItem.nuvemshop_variante_id);
        const previousStock = integerOrNull(reservedItem.estoque_anterior);
        const destinationStock = integerOrNull(reservedItem.estoque_destino);
        const unitsPerSale = integerOrNull(reservedItem.unidades_por_venda);
        if (
          !productId
          || !variantId
          || previousStock === null
          || destinationStock === null
          || !unitsPerSale
          || unitsPerSale < 1
        ) {
          throw new Error("O item reservado nao possui uma variante externa explicita.");
        }

        const { data: latestConnection, error: latestConnectionError } = await supabaseAdmin
          .from("nuvemshop_conexoes")
          .select("token_cifrado, token_iv, escopos, local_estoque_id, escrita_habilitada, escrita_habilitada_ate, escrita_simulacao_id, escrita_habilitada_por, limite_aplicacao")
          .eq("store_id", storeId)
          .single();
        if (latestConnectionError || !latestConnection) {
          throw new Error("A conexao nao pode ser revalidada.");
        }
        if (
          !isPilotWindowActive(latestConnection as Record<string, unknown>)
          || integerOrNull(latestConnection.limite_aplicacao) !== 1
          || !hasScope(latestConnection.escopos, "write_products")
          || String(latestConnection.local_estoque_id || "") !== String(connection.local_estoque_id)
          || String(latestConnection.escrita_simulacao_id || "") !== requestedAuditId
          || String(latestConnection.escrita_habilitada_por || "") !== userResult.data.user.id
        ) {
          throw new Error("As protecoes da loja mudaram depois da reserva.");
        }

        const { data: localProduct, error: localProductError } = await supabaseAdmin
          .from("produtos")
          .select("id, tem_voltagem, quantidade, quantidade_110v, quantidade_220v")
          .eq("id", reservedItem.produto_id)
          .single();
        if (localProductError || !localProduct) {
          throw new Error("Produto local reservado nao foi encontrado.");
        }
        const currentPhysicalStock = localDestination(
          localProduct as Record<string, unknown>,
          reservedItem.voltagem,
        );
        const currentOfferStock = stockForOffer(currentPhysicalStock, unitsPerSale);
        if (currentOfferStock !== destinationStock) {
          throw new Error("O estoque local mudou depois da reserva. Gere uma nova simulacao.");
        }

        const accessToken = await decryptToken(
          latestConnection.token_cifrado,
          latestConnection.token_iv,
          encryptionKey,
        );
        const remoteBefore = await loadRemoteProduct(storeId, productId, accessToken);
        const variantBefore = findRemoteVariant(remoteBefore, variantId);
        const locationId = String(latestConnection.local_estoque_id);
        const stockBefore = variantBefore ? strictVariantStock(variantBefore, locationId) : null;
        if (!variantBefore || stockBefore === null) {
          throw new Error("A variante nao possui estoque no local confirmado.");
        }
        if (stockBefore !== previousStock) {
          throw new Error("O estoque externo mudou desde a simulacao. Gere uma nova previa.");
        }

        writeAttempted = true;
        let writeResponse: Response | null = null;
        let writeFailure: string | null = null;
        try {
          writeResponse = await replaceRemoteVariantStock(
            storeId,
            productId,
            variantId,
            locationId,
            destinationStock,
            accessToken,
          );
          if (!writeResponse.ok) {
            writeFailure = `A Nuvemshop recusou a alteracao (HTTP ${writeResponse.status}).`;
            console.error("Alteracao piloto recusada", writeResponse.status);
          }
          await writeResponse.arrayBuffer().catch(() => null);
        } catch (error) {
          writeFailure = "A resposta da alteracao nao foi confirmada.";
          console.error(
            "Resposta ambigua na alteracao piloto",
            error instanceof Error ? error.message : error,
          );
        }

        let confirmationFailure: string | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await wait(attempt === 0 ? 700 : 1300);
          try {
            const remoteAfter = await loadRemoteProduct(storeId, productId, accessToken);
            const variantAfter = findRemoteVariant(remoteAfter, variantId);
            confirmedStock = variantAfter ? strictVariantStock(variantAfter, locationId) : null;
            if (confirmedStock === destinationStock) break;
          } catch (error) {
            confirmationFailure = error instanceof Error
              ? error.message
              : "Falha ao reler o estoque externo.";
          }
        }

        if (confirmedStock === destinationStock) {
          await finalizePilot(supabaseAdmin, applicationId, "concluida", confirmedStock, null);
          return jsonResponse({
            modo: "aplicacao_piloto",
            operacao_id: operationId,
            aplicacao_id: applicationId,
            store_id: storeId,
            item_auditoria_id: requestedAuditItemId,
            estoque_anterior: previousStock,
            estoque_destino: destinationStock,
            estoque_confirmado: confirmedStock,
            escrita_executada: true,
            resultado: "concluida",
          }, 200, { ...headers, "Cache-Control": "no-store" });
        }

        const definitelyRejected = Boolean(
          writeResponse
          && writeResponse.status >= 400
          && writeResponse.status < 500
          && confirmedStock === previousStock,
        );
        const finalResult = definitelyRejected ? "falhou" : "parcial";
        const finalError = [
          writeFailure,
          confirmationFailure,
          confirmedStock === null
            ? "Nao foi possivel confirmar o estoque final."
            : `Estoque confirmado em ${confirmedStock}, diferente do destino ${destinationStock}.`,
        ].filter(Boolean).join(" ");

        await finalizePilot(
          supabaseAdmin,
          applicationId,
          finalResult,
          confirmedStock,
          finalError,
        );
        return jsonResponse({
          error: finalResult === "falhou"
            ? "A Nuvemshop recusou a aplicacao. O estoque permaneceu inalterado."
            : "O resultado externo ficou incerto. Nao tente novamente antes de conferir a auditoria.",
          aplicacao_id: applicationId,
          resultado: finalResult,
          estoque_confirmado: confirmedStock,
          tentativa_externa: true,
          escrita_executada: finalResult === "falhou" ? false : null,
        }, finalResult === "falhou" ? 409 : 502, {
          ...headers,
          "Cache-Control": "no-store",
        });
      } catch (error) {
        const errorMessage = error instanceof Error
          ? error.message
          : "Falha inesperada na aplicacao piloto.";
        const finalResult = writeAttempted ? "parcial" : "falhou";
        await finalizePilot(
          supabaseAdmin,
          applicationId,
          finalResult,
          confirmedStock,
          errorMessage,
        );
        return jsonResponse({
          error: writeAttempted
            ? "A tentativa externa ficou incerta. Confira a auditoria antes de qualquer nova acao."
            : errorMessage,
          aplicacao_id: applicationId,
          resultado: finalResult,
          estoque_confirmado: confirmedStock,
          tentativa_externa: writeAttempted,
          escrita_executada: writeAttempted ? null : false,
        }, writeAttempted ? 502 : 409, { ...headers, "Cache-Control": "no-store" });
      }
    }

    if (operationMode === "verificar_piloto" || operationMode === "verificar_lote") {
      const batchMode = operationMode === "verificar_lote";
      const desiredLimit = batchMode ? requestedBatchItemIds.length : 1;
      const writeScopeGranted = hasScope(connection.escopos, "write_products");
      const locationConfirmed = Boolean(connection.local_estoque_id);
      const linksWithinLimit = Boolean(links?.length) && links.length <= 500;
      const writeWindowActive = isPilotWindowActive(connection as Record<string, unknown>);
      const writeWindowMatches = writeWindowActive
        && String(connection.escrita_simulacao_id || "") === requestedAuditId
        && String(connection.escrita_habilitada_por || "") === userResult.data.user.id;
      const applicationLimit = integerOrNull(connection.limite_aplicacao) || 1;
      const safePilotLimit = batchMode
        ? desiredLimit >= 2
          && desiredLimit <= BATCH_MAX_ITEMS
          && (!writeWindowActive || applicationLimit === desiredLimit)
        : applicationLimit === 1;
      const blockers: string[] = [];
      let simulationValid = false;
      let simulationExpiresAt: string | null = null;

      if (UUID_PATTERN.test(requestedAuditId)) {
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
      if (!safePilotLimit) {
        blockers.push(batchMode
          ? "O lote deve conter de dois a dez itens e coincidir com a janela ativa."
          : "O limite do piloto precisa permanecer em um item.");
      }
      if (!simulationValid) blockers.push("A simulacao precisa ser recente, concluida e sem falhas.");
      if (!writeWindowActive) {
        blockers.push("A janela temporaria de escrita permanece fechada ou expirada.");
      } else if (!writeWindowMatches) {
        blockers.push("A janela temporaria pertence a outra simulacao ou administrador.");
      }

      const prerequisitesMet = writeScopeGranted
        && locationConfirmed
        && linksWithinLimit
        && safePilotLimit
        && simulationValid;

      return jsonResponse({
        modo: batchMode ? "verificacao_lote" : "verificacao_piloto",
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
        janela_ativa: writeWindowActive,
        escrita_habilitada: writeWindowMatches,
        escrita_habilitada_ate: writeWindowActive ? connection.escrita_habilitada_ate : null,
        confirmacao_liberacao_exigida: batchMode
          ? `LIBERAR LOTE DE ${desiredLimit} ITENS POR 5 MINUTOS`
          : PILOT_WINDOW_CONFIRMATION,
        confirmacao_exigida: batchMode
          ? `APLICAR LOTE DE ${desiredLimit} ITENS`
          : PILOT_CONFIRMATION,
        requisitos_atendidos: prerequisitesMet,
        pode_habilitar: prerequisitesMet && !writeWindowActive,
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
      const physicalStock = localProduct ? localDestination(localProduct, link.voltagem) : null;
      const unitsPerSale = integerOrNull(link.unidades_por_venda);
      const destinationStock = stockForOffer(physicalStock, unitsPerSale);
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
        error = unitsPerSale === null || unitsPerSale < 1
          ? "Quantidade de unidades por venda invalida."
          : "Estoque local invalido.";
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
        unidades_por_venda: unitsPerSale,
        estoque_local_base: physicalStock,
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

    const { data: auditItems, error: auditItemsError } = await supabaseAdmin
      .from("nuvemshop_sincronizacao_itens")
      .select("id, vinculo_id")
      .eq("sincronizacao_id", auditId);
    if (auditItemsError || auditItems?.length !== items.length) {
      console.error("Falha ao recuperar itens da auditoria", auditItemsError?.message || "Total divergente");
      throw new Error("A auditoria foi registrada, mas seus itens nao foram confirmados.");
    }
    const auditItemByLink = new Map(
      auditItems.map((item) => [Number(item.vinculo_id), Number(item.id)]),
    );
    const auditedItems = items.map((item) => ({
      ...item,
      auditoria_item_id: auditItemByLink.get(Number(item.vinculo_id)) || null,
    }));
    if (auditedItems.some((item) => !item.auditoria_item_id)) {
      throw new Error("A auditoria registrada possui item sem identificador.");
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
      itens: auditedItems,
      escrita_habilitada: false,
    }, 200, { ...headers, "Cache-Control": "no-store" });
  } catch (error) {
    console.error("Erro na sincronizacao Nuvemshop", error instanceof Error ? error.message : error);
    return jsonResponse({ error: "Nao foi possivel concluir a operacao segura." }, 500, headers);
  }
});
