const USER_AGENT = "Conferencia de Estoque PDS (comercial@comercial.pontodasublimacao.com.br)";

export class RemoteLinkCheckError extends Error {
  constructor(message) {
    super(message);
    this.name = "RemoteLinkCheckError";
  }
}

export function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function remoteInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export async function checkRemoteLinkAvailability({
  storeId,
  productId,
  variantId,
  accessToken,
  fetchImpl = fetch,
  signal,
}) {
  if (
    !isPositiveSafeInteger(storeId)
    || !isPositiveSafeInteger(productId)
    || (variantId !== null && !isPositiveSafeInteger(variantId))
    || typeof accessToken !== "string"
    || !accessToken
  ) {
    throw new RemoteLinkCheckError("Parametros de verificacao externa invalidos.");
  }

  let response;
  try {
    response = await fetchImpl(
      `https://api.nuvemshop.com.br/v1/${storeId}/products/${productId}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": USER_AGENT,
          "Content-Type": "application/json",
        },
        signal,
      },
    );
  } catch {
    throw new RemoteLinkCheckError("A verificacao externa nao foi concluida.");
  }

  if (!response || typeof response.status !== "number") {
    throw new RemoteLinkCheckError("A verificacao externa retornou formato invalido.");
  }
  if (response.status === 404) return { missingReason: "produto_ausente" };
  if (!response.ok) {
    throw new RemoteLinkCheckError("A verificacao externa foi recusada.");
  }

  let product;
  try {
    product = asRecord(await response.json());
  } catch {
    throw new RemoteLinkCheckError("A verificacao externa retornou conteudo invalido.");
  }
  if (!product || remoteInteger(product.id) !== productId) {
    throw new RemoteLinkCheckError("A verificacao externa retornou produto inesperado.");
  }

  if (variantId === null) return { missingReason: null };
  if (!Array.isArray(product.variants)) {
    throw new RemoteLinkCheckError("A verificacao externa nao confirmou as variantes.");
  }

  const variantExists = product.variants
    .map(asRecord)
    .some((variant) => variant && remoteInteger(variant.id) === variantId);
  return { missingReason: variantExists ? null : "variante_ausente" };
}
