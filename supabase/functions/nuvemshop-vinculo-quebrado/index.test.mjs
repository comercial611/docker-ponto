import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  checkRemoteLinkAvailability,
  RemoteLinkCheckError,
} from "./remote-link-check.mjs";

const directory = new URL(".", import.meta.url);
const sourcePath = fileURLToPath(new URL("./index.ts", directory));
const migrationPath = fileURLToPath(new URL("../../33-desativacao-auditada-vinculos-nuvemshop.sql", directory));

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() {
      return body;
    },
  };
}

async function expectRemoteFailure(callback) {
  await assert.rejects(callback, RemoteLinkCheckError);
}

const call = (fetchImpl, overrides = {}) => checkRemoteLinkAvailability({
  storeId: 3514029,
  productId: 289981518,
  variantId: 1297133495,
  accessToken: "mock-token",
  fetchImpl,
  ...overrides,
});

let requestedUrl = "";
const productMissing = await call(async (url, options) => {
  requestedUrl = url;
  assert.equal(options.method, undefined, "A verificacao de vinculo deve usar GET.");
  assert.equal(options.headers.Authorization, "Bearer mock-token");
  return response(404, null);
});
assert.deepEqual(productMissing, { missingReason: "produto_ausente" });
assert.equal(requestedUrl, "https://api.nuvemshop.com.br/v1/3514029/products/289981518");

const storeBMissing = await call(async (url) => {
  requestedUrl = url;
  return response(404, null);
}, { storeId: 6696910 });
assert.deepEqual(storeBMissing, { missingReason: "produto_ausente" });
assert.equal(requestedUrl, "https://api.nuvemshop.com.br/v1/6696910/products/289981518");

const variantMissing = await call(async () => response(200, {
  id: 289981518,
  variants: [{ id: 1 }],
}));
assert.deepEqual(variantMissing, { missingReason: "variante_ausente" });

const variantPresent = await call(async () => response(200, {
  id: 289981518,
  variants: [{ id: 1297133495 }],
}));
assert.deepEqual(variantPresent, { missingReason: null });

const productPresentWithoutVariant = await call(async () => response(200, { id: 289981518 }), {
  variantId: null,
});
assert.deepEqual(productPresentWithoutVariant, { missingReason: null });

for (const status of [401, 403, 429, 500]) {
  await expectRemoteFailure(() => call(async () => response(status, { error: "temporario" })));
}
await expectRemoteFailure(() => call(async () => response(200, { id: 999, variants: [] })));
await expectRemoteFailure(() => call(async () => response(200, { id: 289981518, variants: null })));
await expectRemoteFailure(() => call(async () => ({
  status: 200,
  ok: true,
  async json() { throw new Error("invalid-json"); },
})));
await expectRemoteFailure(() => call(async () => { throw new Error("network"); }));

const [source, migration] = await Promise.all([
  readFile(sourcePath, "utf8"),
  readFile(migrationPath, "utf8"),
]);
assert.match(source, /request\.method !== "POST"/);
assert.match(source, /\.eq\("id", linkId\)\s*\.eq\("store_id", storeId\)/s);
assert.match(source, /checkRemoteLinkAvailability/);
assert.match(source, /desativar_vinculo_nuvemshop/);
assert.doesNotMatch(source, /\.update\(\{\s*ativo:\s*false\s*\}\)/s);
assert.doesNotMatch(source, /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/);
assert.match(migration, /where id = p_vinculo_id\s*and store_id = p_store_id\s*for update;/s);
assert.match(migration, /set ativo = false\s*where id = v_vinculo\.id\s*and store_id = p_store_id\s*and ativo;/s);
assert.match(migration, /insert into public\.nuvemshop_vinculos_eventos/s);
assert.match(migration, /grant execute on function public\.desativar_vinculo_nuvemshop[\s\S]*to service_role;/);
assert.match(migration, /revoke update, delete on table public\.nuvemshop_vinculos from authenticated;/);
assert.match(migration, /drop policy if exists "Nuvemshop vinculos: admin pode atualizar"/);
assert.doesNotMatch(migration, /delete\s+from\s+public\.nuvemshop_vinculos/i);

console.log("nuvemshop-vinculo-quebrado: testes mockados aprovados");
