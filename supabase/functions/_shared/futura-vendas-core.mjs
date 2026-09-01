import * as XLSX from "./vendor/xlsx-0.20.3.mjs";
import * as cptable from "./vendor/cpexcel-1.15.0.mjs";

XLSX.set_cptable(cptable);

const MAX_BYTES = 1024 * 1024;
const MAX_DATA_LINES = 500;
const MAX_SHEET_ROWS = 5000;
const MAX_SHEET_COLUMNS = 128;
const OLE_HEADER = Object.freeze([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const POSITIVE_QUANTITY = /^\+?([0-9]+|[0-9]{1,3}(\.[0-9]{3})+)(,0+)?$/;

const HEADER_NAMES = Object.freeze({
  referencia: new Set(["ref", "referencia"]),
  descricao: new Set(["descricao"]),
  codigo_barras: new Set(["codigodebarra", "codigobarra", "codigobarras", "codbarra", "barras"]),
  quantidade: new Set(["qtde", "qtd", "quantidade"]),
});

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new Error("O arquivo XLS do Futura e invalido.");
}

function normalizeText(value) {
  return String(value ?? "").trim();
}

export function normalizeFuturaLabel(value) {
  return normalizeText(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

export function isLegacyXlsBytes(value) {
  const bytes = asBytes(value);
  return bytes.length >= OLE_HEADER.length
    && OLE_HEADER.every((expected, index) => bytes[index] === expected);
}

function decodeBase64(value) {
  if (typeof value !== "string" || !value || value.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) {
    throw new Error("O arquivo XLS do Futura excede o limite permitido.");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw new Error("O arquivo XLS do Futura e invalido.");
  }
  let binary;
  try {
    binary = atob(value);
  } catch {
    throw new Error("O arquivo XLS do Futura e invalido.");
  }
  if (binary.length < 1 || binary.length > MAX_BYTES) {
    throw new Error("O arquivo XLS do Futura deve ter entre 1 byte e 1 MB.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export async function sha256Bytes(value) {
  const bytes = asBytes(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function worksheetCell(sheet, row, column) {
  return sheet[XLSX.utils.encode_cell({ r: row, c: column })] || null;
}

function cellText(cell) {
  if (!cell) return "";
  if (cell.w != null) return normalizeText(cell.w);
  return normalizeText(cell.v);
}

function rowTexts(sheet, row, firstColumn, lastColumn) {
  const values = [];
  for (let column = firstColumn; column <= lastColumn; column += 1) {
    values.push(cellText(worksheetCell(sheet, row, column)));
  }
  return values;
}

function isReportTitle(values) {
  return normalizeFuturaLabel(values.filter(Boolean).join(" ")).includes("produtosvendidos");
}

function parseDatePart(dayText, monthText, yearText) {
  const day = Number(dayText);
  const month = Number(monthText);
  let year = Number(yearText);
  if (year < 100) year += 2000;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function datesFromMetadata(values, rowNumber) {
  const metadata = values.filter(Boolean).join(" ");
  const matches = Array.from(metadata.matchAll(/(?:^|\D)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})(?=\D|$)/g));
  return matches.map((match) => {
    const parsed = parseDatePart(match[1], match[2], match[3]);
    if (!parsed) throw new Error(`O relatorio Produtos Vendidos possui data invalida nos metadados da linha ${rowNumber}.`);
    return parsed;
  });
}

function isEmptyMetadataRow(values) {
  return values.every((value) => !value);
}

function pagePreludeRows(rows, firstRow) {
  const ignored = new Set();
  rows.forEach((values, titleIndex) => {
    if (!isReportTitle(values) || titleIndex < 1) return;

    const candidates = [];
    let index = titleIndex - 1;
    while (index >= 0 && !isEmptyMetadataRow(rows[index])) {
      candidates.push(index);
      index -= 1;
    }
    if (index < 0 || !candidates.some((candidate) => datesFromMetadata(rows[candidate], firstRow + candidate + 1).length)) {
      return;
    }
    candidates.forEach((candidate) => ignored.add(firstRow + candidate));
  });
  return ignored;
}

function headerMatches(values) {
  const matches = {
    referencia: [],
    descricao: [],
    codigo_barras: [],
    quantidade: [],
  };
  values.forEach((value, index) => {
    const normalized = normalizeFuturaLabel(value);
    for (const [role, accepted] of Object.entries(HEADER_NAMES)) {
      if (accepted.has(normalized)) matches[role].push(index);
    }
  });
  return matches;
}

function headerRoleCount(matches) {
  return Object.values(matches).filter((indexes) => indexes.length > 0).length;
}

function resolveHeader(values, rowNumber, firstColumn) {
  const matches = headerMatches(values);
  const rolesFound = headerRoleCount(matches);
  if (rolesFound < 2) return null;
  if (Object.values(matches).some((indexes) => indexes.length !== 1)) {
    throw new Error(`O relatorio Futura possui cabecalho ausente ou ambiguo na linha ${rowNumber}.`);
  }
  const resolved = Object.fromEntries(
    Object.entries(matches).map(([role, indexes]) => [role, firstColumn + indexes[0]])
  );
  const quantityIndex = matches.quantidade[0];
  const quantidadeAlternativas = [quantityIndex - 1, quantityIndex + 1]
    .filter((index) => index >= 0 && index < values.length && !normalizeText(values[index]))
    .map((index) => firstColumn + index);
  return { ...resolved, quantidadeAlternativas };
}

function resolveQuantityCell(sheet, row, header, rowNumber) {
  const declared = worksheetCell(sheet, row, header.quantidade);
  if (cellText(declared)) return declared;

  const alternatives = header.quantidadeAlternativas
    .map((column) => worksheetCell(sheet, row, column))
    .filter((cell) => cellText(cell));
  if (alternatives.length > 1) {
    throw new Error(`A linha ${rowNumber} do relatorio Futura possui quantidade ambigua.`);
  }
  return alternatives[0] || null;
}

function parseQuantity(cell, rowNumber) {
  if (!cell) throw new Error(`A linha ${rowNumber} do relatorio Futura esta sem quantidade.`);
  if (typeof cell.v === "number") {
    if (!Number.isSafeInteger(cell.v) || cell.v < 1 || cell.v > 2147483647) {
      throw new Error(`A linha ${rowNumber} do relatorio Futura possui quantidade invalida.`);
    }
    return String(cell.v);
  }
  const original = cellText(cell);
  if (!POSITIVE_QUANTITY.test(original)) {
    throw new Error(`A linha ${rowNumber} do relatorio Futura possui quantidade invalida.`);
  }
  const quantity = Number(original.replace(/^\+/, "").split(",")[0].replaceAll(".", ""));
  if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 2147483647) {
    throw new Error(`A linha ${rowNumber} do relatorio Futura possui quantidade invalida.`);
  }
  return original;
}

export function quantityFromOfficialText(value) {
  const original = normalizeText(value);
  if (!POSITIVE_QUANTITY.test(original)) return 0;
  const quantity = Number(original.replace(/^\+/, "").split(",")[0].replaceAll(".", ""));
  return Number.isSafeInteger(quantity) && quantity > 0 ? quantity : 0;
}

export function parseFuturaVendasXls(value) {
  const bytes = asBytes(value);
  if (bytes.length < 1 || bytes.length > MAX_BYTES) {
    throw new Error("O arquivo XLS do Futura deve ter entre 1 byte e 1 MB.");
  }
  if (!isLegacyXlsBytes(bytes)) {
    throw new Error("O arquivo deve ser um Excel legado .xls valido do Futura.");
  }

  let workbook;
  try {
    workbook = XLSX.read(bytes, {
      type: "array",
      cellDates: false,
      cellFormula: false,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      bookVBA: false,
      bookFiles: false,
      dense: false,
      WTF: false,
    });
  } catch {
    throw new Error("O arquivo XLS do Futura nao pode ser interpretado.");
  }

  if (!Array.isArray(workbook.SheetNames)
      || workbook.SheetNames.length !== 1
      || workbook.SheetNames[0] !== "Report") {
    throw new Error('O arquivo deve conter somente a planilha "Report" do Futura.');
  }

  const sheet = workbook.Sheets.Report;
  if (!sheet || !sheet["!ref"]) throw new Error("O relatorio Produtos Vendidos esta vazio.");
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const rowCount = range.e.r - range.s.r + 1;
  const columnCount = range.e.c - range.s.c + 1;
  if (rowCount > MAX_SHEET_ROWS || columnCount > MAX_SHEET_COLUMNS) {
    throw new Error("O relatorio Produtos Vendidos excede os limites de linhas ou colunas.");
  }
  const worksheetRows = Array.from(
    { length: rowCount },
    (_, index) => rowTexts(sheet, range.s.r + index, range.s.c, range.e.c)
  );
  const ignoredPagePreludeRows = pagePreludeRows(worksheetRows, range.s.r);

  const periodDates = new Set();
  const lines = [];
  let titleCount = 0;
  let headerCount = 0;
  let activeHeader = null;
  let titleAwaitingHeader = false;
  let currentMetadataDates = new Set();

  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const values = worksheetRows[row - range.s.r];
    const rowNumber = row + 1;

    if (ignoredPagePreludeRows.has(row)) continue;

    if (isReportTitle(values)) {
      if (titleAwaitingHeader) {
        throw new Error(`O relatorio Futura esta sem cabecalho apos o titulo anterior a linha ${rowNumber}.`);
      }
      titleCount += 1;
      activeHeader = null;
      titleAwaitingHeader = true;
      currentMetadataDates = new Set(datesFromMetadata(values, rowNumber));
      continue;
    }

    const resolvedHeader = resolveHeader(values, rowNumber, range.s.c);
    if (resolvedHeader) {
      if (!titleCount) throw new Error('O arquivo nao e o relatorio "Produtos Vendidos" esperado.');
      if (titleAwaitingHeader) {
        if (currentMetadataDates.size !== 1) {
          throw new Error("O relatorio Produtos Vendidos deve informar um periodo inequivoco de exatamente um unico dia antes do cabecalho.");
        }
        currentMetadataDates.forEach((date) => periodDates.add(date));
      }
      activeHeader = resolvedHeader;
      titleAwaitingHeader = false;
      headerCount += 1;
      continue;
    }

    if (titleAwaitingHeader) {
      datesFromMetadata(values, rowNumber).forEach((date) => currentMetadataDates.add(date));
      continue;
    }

    if (!activeHeader) continue;

    const referenceCell = worksheetCell(sheet, row, activeHeader.referencia);
    const descriptionCell = worksheetCell(sheet, row, activeHeader.descricao);
    const barcodeCell = worksheetCell(sheet, row, activeHeader.codigo_barras);
    const referencia = cellText(referenceCell);
    const descricao = cellText(descriptionCell);
    const codigoBarras = cellText(barcodeCell);
    if (!referencia && !descricao && !codigoBarras) continue;

    const quantityCell = resolveQuantityCell(sheet, row, activeHeader, rowNumber);
    const quantidadeText = cellText(quantityCell);

    if (!referencia || !codigoBarras || !quantidadeText) {
      throw new Error(`A linha ${rowNumber} do relatorio Futura deve conter referencia, codigo de barras e quantidade.`);
    }
    if (referenceCell?.f || barcodeCell?.f || quantityCell?.f) {
      throw new Error(`A linha ${rowNumber} do relatorio Futura possui formula em campo obrigatorio.`);
    }

    lines.push({
      referencia,
      codigo_barras: codigoBarras,
      descricao: descricao || null,
      quantidade_original: parseQuantity(quantityCell, rowNumber),
    });
    if (lines.length > MAX_DATA_LINES) {
      throw new Error("O relatorio Produtos Vendidos excede o limite de 500 linhas.");
    }
  }

  if (!titleCount) throw new Error('O arquivo nao e o relatorio "Produtos Vendidos" esperado.');
  if (titleAwaitingHeader || !headerCount) {
    throw new Error("O relatorio Futura possui titulo sem cabecalho de dados.");
  }
  if (periodDates.size !== 1) {
    throw new Error("O relatorio Produtos Vendidos deve abranger exatamente um unico dia.");
  }
  if (!lines.length) throw new Error("O relatorio Produtos Vendidos nao possui linhas de produtos.");

  return {
    competencia: Array.from(periodDates)[0],
    lines,
    totalCabecalhos: headerCount,
  };
}

export async function prepareFuturaVendasXls({ arquivo_base64 }) {
  const bytes = decodeBase64(arquivo_base64);
  const parsed = parseFuturaVendasXls(bytes);
  return {
    ...parsed,
    hash: await sha256Bytes(bytes),
  };
}

export const FUTURA_XLS_LIMITS = Object.freeze({
  maxBytes: MAX_BYTES,
  maxDataLines: MAX_DATA_LINES,
  maxSheetRows: MAX_SHEET_ROWS,
  maxSheetColumns: MAX_SHEET_COLUMNS,
});

export const SHEETJS_VERSION = XLSX.version;
