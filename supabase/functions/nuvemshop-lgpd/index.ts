import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  calculateWebhookHmac,
  requiredEnv,
  safeEqual,
} from "../_shared/nuvemshop.ts";

const supportedRoutes = new Set([
  "store-redact",
  "customers-redact",
  "customers-data-request",
]);

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const route = new URL(request.url).pathname.split("/").filter(Boolean).at(-1) || "";
    if (!supportedRoutes.has(route)) {
      return new Response("Not Found", { status: 404 });
    }

    const rawBody = await request.text();
    const receivedHmac = request.headers.get("x-linkedstore-hmac-sha256")?.trim() || "";
    const clientSecret = requiredEnv("NUVEMSHOP_CLIENT_SECRET");
    const expectedHmac = await calculateWebhookHmac(rawBody, clientSecret);
    if (!receivedHmac || !safeEqual(receivedHmac, expectedHmac)) {
      return new Response("Unauthorized", { status: 401 });
    }

    const payload = JSON.parse(rawBody);
    const storeId = Number(payload.store_id);
    if (!Number.isSafeInteger(storeId) || storeId <= 0) {
      return new Response("Invalid payload", { status: 400 });
    }

    if (route === "store-redact") {
      const supabaseAdmin = createClient(
        requiredEnv("SUPABASE_URL"),
        requiredEnv("SUPABASE_SERVICE_ROLE_KEY"),
        { auth: { persistSession: false, autoRefreshToken: false } },
      );

      const { data: removedConnection, error: connectionError } = await supabaseAdmin
        .from("nuvemshop_conexoes")
        .delete()
        .eq("store_id", storeId)
        .select("store_id")
        .maybeSingle();
      if (connectionError) throw connectionError;

      if (removedConnection) {
        const { error: linksError } = await supabaseAdmin
          .from("nuvemshop_vinculos")
          .delete()
          .neq("id", 0);
        if (linksError) throw linksError;
      }
    }

    // O aplicativo nao solicita nem armazena clientes ou pedidos.
    return new Response(null, { status: 204 });
  } catch (error) {
    console.error("Erro no webhook LGPD", error instanceof Error ? error.message : error);
    return new Response("Internal Server Error", { status: 500 });
  }
});
