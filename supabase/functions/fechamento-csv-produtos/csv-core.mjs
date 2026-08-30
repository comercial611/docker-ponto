const MAX_BYTES = 1024 * 1024;
const MAX_LINES = 500;
const POSITIVE_QUANTITY = /^\+?([0-9]+|[0-9]{1,3}(\.[0-9]{3})+)(,0+)?$/;

function normalizeCode(value) {
  return String(value ?? "").trim().toLocaleLowerCase("pt-BR");
}

function normalizeHeader(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) {
    throw new Error("O arquivo CSV excede o limite permitido.");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("O conteudo do arquivo CSV e invalido.");
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error("O conteudo do arquivo CSV e invalido.");
  }
  if (binary.length < 1 || binary.length > MAX_BYTES) {
    throw new Error("O arquivo CSV deve ter entre 1 byte e 1 MB.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function normalizeCsvContent(value) {
  const normalized = String(value ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/g, "");
  if (!normalized.trim()) throw new Error("O arquivo CSV esta vazio.");
  if (normalized.includes("\u0000")) throw new Error("O arquivo CSV contem bytes invalidos.");
  return normalized;
}

export function decodeAndNormalizeCsv(base64) {
  const bytes = decodeBase64(base64);
  let decoded;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("O arquivo CSV deve usar codificacao UTF-8 valida.");
  }
  return normalizeCsvContent(decoded);
}

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseCsvContent(text) {
  const rows = [];
  let row = [];
  let current = "";
  let inQuotes = false;
  let closedQuotedField = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const next = text[index + 1];
    if (inQuotes) {
      if (character === '"' && next === '"') {
        current += '"';
        index += 1;
      } else if (character === '"') {
        inQuotes = false;
        closedQuotedField = true;
      } else {
        current += character;
      }
      continue;
    }

    if (closedQuotedField) {
      if (character === ",") {
        row.push(current.trim());
        current = "";
        closedQuotedField = false;
        continue;
      }
      if (character === "\n") {
        row.push(current.trim());
        if (row.some((cell) => cell !== "")) rows.push(row);
        row = [];
        current = "";
        closedQuotedField = false;
        continue;
      }
      throw new Error("O arquivo CSV possui caractere invalido apos campo entre aspas.");
    }

    if (character === '"') {
      if (current.length !== 0) {
        throw new Error("O arquivo CSV possui aspas fora do inicio de um campo.");
      }
      inQuotes = true;
      continue;
    }
    if (character === "," && !inQuotes) {
      row.push(current.trim());
      current = "";
      continue;
    }
    if (character === "\n" && !inQuotes) {
      row.push(current.trim());
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      current = "";
      continue;
    }
    current += character;
  }
  if (inQuotes) throw new Error("O arquivo CSV possui aspas nao finalizadas.");
  row.push(current.trim());
  if (row.some((cell) => cell !== "")) rows.push(row);
  return rows;
}

function headerIndex(headers, accepted, fallback) {
  const normalized = headers.map(normalizeHeader);
  const found = normalized.findIndex((header) => accepted.includes(header));
  return found >= 0 ? found : fallback;
}

function readQuantity(row, index) {
  if (index >= 0 && row[index]) return row[index];
  return row.slice(2).filter(Boolean).pop() || "";
}

export function canonicalLines(rows) {
  if (!Array.isArray(rows) || rows.length < 2) {
    throw new Error("O arquivo CSV deve conter cabecalho e ao menos uma linha.");
  }
  if (rows.length - 1 > MAX_LINES) throw new Error("O arquivo CSV excede o limite de 500 linhas.");
  const headers = rows[0] || [];
  const referenceIndex = headerIndex(headers, ["ref", "referencia"], 0);
  const descriptionIndex = headerIndex(headers, ["descricao", "produto", "nome"], 1);
  const barcodeIndex = headerIndex(headers, ["codigodebarra", "codigobarra", "codigobarras", "codbarra", "barras"], 8);
  const quantityIndex = headerIndex(headers, ["qtde", "qtd", "quantidade"], -1);

  return rows.slice(1).map((row, index) => {
    const referencia = String(row[referenceIndex] || "").trim() || null;
    const codigoBarras = String(row[barcodeIndex] || "").trim() || null;
    const descricao = String(row[descriptionIndex] || "").trim() || null;
    const quantidadeOriginal = String(readQuantity(row, quantityIndex)).trim();
    if (!referencia && !codigoBarras && !descricao) {
      throw new Error(`A linha ${index + 2} nao identifica nenhum item.`);
    }
    if (!POSITIVE_QUANTITY.test(quantidadeOriginal)) {
      throw new Error(`A linha ${index + 2} possui quantidade invalida ou corretiva.`);
    }
    const quantidade = Number(quantidadeOriginal.replace(/^\+/, "").split(",")[0].replaceAll(".", ""));
    if (!Number.isSafeInteger(quantidade) || quantidade < 1 || quantidade > 2147483647) {
      throw new Error(`A linha ${index + 2} possui quantidade fora do limite.`);
    }
    return {
      referencia,
      codigo_barras: codigoBarras,
      descricao,
      quantidade_original: quantidadeOriginal,
    };
  });
}

function productMatches(product, line) {
  const reference = normalizeCode(line.referencia);
  const barcode = normalizeCode(line.codigo_barras);
  if (reference && (
    normalizeCode(product.codigo_referencia) === reference ||
    normalizeCode(product.codigo_interno) === reference ||
    String(product.id) === reference
  )) return true;
  return Boolean(barcode && (
    normalizeCode(product.sku) === barcode ||
    normalizeCode(product.codigo_interno) === barcode ||
    normalizeCode(product.codigo_referencia) === barcode
  ));
}

export function validateCandidates(lines, products) {
  for (const [index, line] of lines.entries()) {
    const candidates = products.filter((product) => productMatches(product, line));
    const productCandidates = candidates.filter((product) => (product.categoria || "maquina") === "produto");
    const activeProducts = productCandidates.filter((product) => product.ativo === true);
    const machines = candidates.filter((product) => (product.categoria || "maquina") !== "produto");
    if (productCandidates.length > 0 && machines.length > 0) {
      throw new Error(`A linha ${index + 2} possui codigo ambiguo entre produto e maquina.`);
    }
    if (productCandidates.length > 0 && activeProducts.length === 0) {
      throw new Error(`A linha ${index + 2} corresponde somente a produto inativo.`);
    }
    if (activeProducts.length > 1) {
      throw new Error(`A linha ${index + 2} possui codigo ambiguo para mais de um produto ativo.`);
    }
  }
}

export async function prepareCsv({ arquivo_base64, products }) {
  const normalizedContent = decodeAndNormalizeCsv(arquivo_base64);
  const lines = canonicalLines(parseCsvContent(normalizedContent));
  validateCandidates(lines, Array.isArray(products) ? products : []);
  return {
    normalizedContent,
    hash: await sha256Hex(normalizedContent),
    lines,
  };
}

export const CSV_LIMITS = Object.freeze({ maxBytes: MAX_BYTES, maxLines: MAX_LINES });
