import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders, jsonResponse } from "../_shared/http.ts";
import { prepareCsv } from "./csv-core.mjs";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const REQUEST_FIELDS = new Set(["arquivo_base64", "arquivo_nome", "competencia"]);

function requiredEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Variavel obrigatoria ausente: ${name}`);
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function validDate(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  const today = new Date().toISOString().slice(0, 10);
  return value <= today ? value : null;
}

function validFileName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 255 && normalized.toLowerCase().endsWith(".csv")
    ? normalized
    : null;
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error !== null && "message" in error && typeof error.message === "string"
    ? error.message
    : "";
  const safePrefixes = [
    "O arquivo CSV", "O conteudo", "A linha", "A competencia", "A quantidade", "O CSV", "Produto",
    "Existe produto", "Existe cobertura", "Nenhum produto", "Informe",
  ];
  return safePrefixes.some((prefix) => message.startsWith(prefix))
    ? message
    : "Nao foi possivel aplicar o fechamento oficial do CSV.";
}

function validRpcRows(value: unknown): value is Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length < 1) return false;
  const first = asRecord(value[0]);
  if (!first) return false;
  const lotId = Number(first.lote_id);
  const repeated = first.repetida;
  if (!Number.isSafeInteger(lotId) || lotId < 1 || typeof repeated !== "boolean") return false;
  return value.every((item) => {
    const row = asRecord(item);
    if (!row) return false;
    const productId = Number(row.produto_id);
    const previous = Number(row.quantidade_anterior);
    const next = Number(row.quantidade_nova);
    const applied = Number(row.quantidade_baixada);
    return Number(row.lote_id) === lotId
      && row.repetida === repeated
      && Number.isSafeInteger(productId) && productId > 0
      && typeof row.produto_nome === "string" && row.produto_nome.trim().length > 0
      && Number.isInteger(previous) && previous >= 0
      && Number.isInteger(next) && next >= 0
      && Number.isInteger(applied) && applied >= 0;
  });
}

Deno.serve(async (request) => {
  const headers = {
    ...corsHeaders(request),
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Cache-Control": "no-store",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return jsonResponse({ error: "Metodo nao permitido." }, 405, headers);

  try {
    const authorization = request.headers.get("authorization") || "";
    if (!authorization.toLowerCase().startsWith("bearer ")) {
      return jsonResponse({ error: "Usuario nao autenticado." }, 401, headers);
    }

    const payload = asRecord(await request.json().catch(() => null));
    if (!payload || Object.keys(payload).some((field) => !REQUEST_FIELDS.has(field))) {
      return jsonResponse({ error: "Solicitacao de fechamento CSV invalida." }, 400, headers);
    }
    const fileName = validFileName(payload.arquivo_nome);
    const competence = validDate(payload.competencia);
    if (!fileName || !competence || typeof payload.arquivo_base64 !== "string") {
      return jsonResponse({ error: "Informe arquivo CSV e competencia validos." }, 400, headers);
    }

    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const anonKey = requiredEnv("SUPABASE_ANON_KEY");
    const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const [{ data: userType, error: typeError }, userResult] = await Promise.all([
      userClient.rpc("usuario_tipo"),
      userClient.auth.getUser(),
    ]);
    const authenticatedUser = userResult.data.user;
    if (typeError || userResult.error || !authenticatedUser) {
      return jsonResponse({ error: "Usuario nao autenticado." }, 401, headers);
    }
    if (userType !== "admin") {
      return jsonResponse({ error: "Acesso permitido somente para administradores." }, 403, headers);
    }

    const adminClient = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: products, error: productsError } = await adminClient
      .from("produtos")
      .select("id, ativo, categoria, codigo_referencia, codigo_interno, sku");
    if (productsError || !Array.isArray(products)) {
      return jsonResponse({ error: "Nao foi possivel validar os produtos do CSV." }, 503, headers);
    }

    let prepared;
    try {
      prepared = await prepareCsv({ arquivo_base64: payload.arquivo_base64, products });
    } catch (error) {
      return jsonResponse({ error: safeErrorMessage(error) }, 400, headers);
    }

    // A versao do fechamento e definida exclusivamente pela RPC (v2); o
    // cliente nunca pode escolher ou forjar validacao_versao.
    const { data, error } = await adminClient.rpc("registrar_fechamento_csv_produtos", {
      p_linhas: prepared.lines,
      p_arquivo_nome: fileName,
      p_arquivo_hash: prepared.hash,
      p_data_movimento: competence,
      p_usuario_id: authenticatedUser.id,
    });
    if (error) {
      return jsonResponse({ error: safeErrorMessage(error) }, 409, headers);
    }
    if (!validRpcRows(data)) {
      return jsonResponse({ error: "O servidor retornou um resultado de fechamento invalido." }, 502, headers);
    }

    const totalApplied = data.reduce((total, row) => total + Number(row.quantidade_baixada), 0);
    return jsonResponse({
      aplicado: true,
      repetida: data[0].repetida,
      lote_id: data[0].lote_id,
      total_itens: data.length,
      total_baixado: totalApplied,
      itens: data,
    }, 200, headers);
  } catch {
    console.error("csv_closure_unexpected_failure");
    return jsonResponse({ error: "Nao foi possivel aplicar o fechamento oficial do CSV." }, 500, headers);
  }
});
