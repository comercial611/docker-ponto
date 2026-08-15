import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { decryptToken, requiredEnv } from "../_shared/nuvemshop.ts";
import {
  checkRemoteLinkAvailability,
  isPositiveSafeInteger,
  RemoteLinkCheckError,
} from "./remote-link-check.mjs";

const MANUAL_ACTION = "manual";
const BROKEN_ACTION = "quebrado";
const BROKEN_REASONS = Object.freeze({
  produto_ausente: "Produto externo nao encontrado na Nuvemshop.",
  variante_ausente: "Variante externa nao encontrada na Nuvemshop.",
});

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveSafeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return isPositiveSafeInteger(parsed) ? parsed : null;
}

function manualReason(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 500 ? normalized : null;
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

    const payload = asRecord(await request.json().catch(() => null));
    const storeId = positiveSafeInteger(payload?.store_id);
    const linkId = positiveSafeInteger(payload?.vinculo_id);
    const action = String(payload?.acao || "");
    if (!storeId || !linkId || ![MANUAL_ACTION, BROKEN_ACTION].includes(action)) {
      return jsonResponse({ error: "Solicitacao de vinculo invalida." }, 400, headers);
    }

    const requestedManualReason = action === MANUAL_ACTION ? manualReason(payload?.motivo) : null;
    if (action === MANUAL_ACTION && !requestedManualReason) {
      return jsonResponse({ error: "Informe o motivo da desativacao manual." }, 400, headers);
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const anonKey = requiredEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
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
    const { data: link, error: linkError } = await supabaseAdmin
      .from("nuvemshop_vinculos")
      .select("id, store_id, produto_id, nuvemshop_produto_id, nuvemshop_variante_id, ativo")
      .eq("id", linkId)
      .eq("store_id", storeId)
      .maybeSingle();
    if (linkError) throw linkError;
    if (!link) {
      return jsonResponse({ error: "Vinculo da loja selecionada nao foi encontrado." }, 404, headers);
    }
    if (link.ativo !== true) {
      return jsonResponse({ desativado: false, idempotente: true }, 200, {
        ...headers,
        "Cache-Control": "no-store",
      });
    }

    const remoteProductId = positiveSafeInteger(link.nuvemshop_produto_id);
    const remoteVariantId = link.nuvemshop_variante_id == null
      ? null
      : positiveSafeInteger(link.nuvemshop_variante_id);
    if (!remoteProductId || (link.nuvemshop_variante_id != null && !remoteVariantId)) {
      return jsonResponse({ error: "Vinculo possui identificadores externos invalidos." }, 409, headers);
    }

    let auditType = MANUAL_ACTION;
    let auditReason = requestedManualReason as string;
    if (action === BROKEN_ACTION) {
      const { data: connection, error: connectionError } = await supabaseAdmin
        .from("nuvemshop_conexoes")
        .select("store_id, token_cifrado, token_iv")
        .eq("store_id", storeId)
        .maybeSingle();
      if (connectionError) throw connectionError;
      if (!connection) {
        return jsonResponse({ error: "Loja Nuvemshop nao conectada." }, 409, headers);
      }

      let verification;
      try {
        const encryptionKey = requiredEnv("NUVEMSHOP_TOKEN_ENCRYPTION_KEY");
        const accessToken = await decryptToken(connection.token_cifrado, connection.token_iv, encryptionKey);
        verification = await checkRemoteLinkAvailability({
          storeId,
          productId: remoteProductId,
          variantId: remoteVariantId,
          accessToken,
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        if (error instanceof RemoteLinkCheckError) {
          return jsonResponse({
            error: "Nao foi possivel confirmar o vinculo na Nuvemshop. Ele permaneceu ativo.",
          }, 502, headers);
        }
        console.error("Falha ao preparar verificacao de vinculo quebrado.");
        return jsonResponse({
          error: "Nao foi possivel confirmar o vinculo na Nuvemshop. Ele permaneceu ativo.",
        }, 502, headers);
      }

      if (!verification.missingReason) {
        return jsonResponse({
          error: "O produto ou variante ainda existe na Nuvemshop. Use a desativacao manual se esta for uma decisao administrativa.",
        }, 409, headers);
      }
      auditType = verification.missingReason;
      auditReason = BROKEN_REASONS[verification.missingReason];
    }

    const { data: deactivated, error: deactivationError } = await supabaseAdmin.rpc(
      "desativar_vinculo_nuvemshop",
      {
        p_store_id: storeId,
        p_vinculo_id: linkId,
        p_tipo: auditType,
        p_motivo: auditReason,
        p_solicitado_por: userResult.data.user.id,
        p_nuvemshop_produto_id: remoteProductId,
        p_nuvemshop_variante_id: remoteVariantId,
      },
    );
    if (deactivationError) {
      console.error("Falha ao registrar desativacao de vinculo.");
      return jsonResponse({ error: "Nao foi possivel desativar o vinculo selecionado." }, 409, headers);
    }

    return jsonResponse({
      desativado: deactivated === true,
      idempotente: deactivated !== true,
    }, 200, { ...headers, "Cache-Control": "no-store" });
  } catch {
    console.error("Erro inesperado na desativacao de vinculo Nuvemshop.");
    return jsonResponse({ error: "Nao foi possivel concluir a desativacao do vinculo." }, 500, headers);
  }
});
