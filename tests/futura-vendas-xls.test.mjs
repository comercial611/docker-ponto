import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as XLSX from '../supabase/functions/_shared/vendor/xlsx-0.20.3.mjs';
import {
  parseFuturaVendasXls,
  prepareFuturaVendasXls,
  sha256Bytes,
  SHEETJS_VERSION
} from '../supabase/functions/_shared/futura-vendas-core.mjs';

const adminHtml = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const adminSource = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8');
const functionSource = readFileSync(
  new URL('../supabase/functions/fechamento-csv-produtos/index.ts', import.meta.url),
  'utf8'
);
const vendorSource = readFileSync(
  new URL('../supabase/functions/_shared/vendor/xlsx-0.20.3.mjs', import.meta.url),
  'utf8'
);

function csvProtocolHarness(protocol) {
  const source = adminSource.match(
    /const CSV_IMPORT_PROTOCOL_MESSAGE[\s\S]*?\n}\n\nfunction loadFuturaVendasCore/
  )?.[0].replace(/\n\nfunction loadFuturaVendasCore$/, '') || '';
  assert.ok(source, 'guarda de protocolo do importador deve existir');

  const elements = {
    'csv-baixa-input': { value: 'relatorio.xls', disabled: false },
    'csv-preview-summary': { textContent: 'estado anterior' },
    'csv-preview-table-wrap': { style: { display: 'block' } },
    'csv-apply-btn': { disabled: false }
  };
  const context = vm.createContext({
    window: { location: { protocol } },
    document: { getElementById: (id) => elements[id] || null }
  });
  vm.runInContext(`${source}; this.guardResult = enforceCsvImportProtocol();`, context);
  return { result: context.guardResult, elements };
}

function workbookBytes(rows, extraSheets = [], customizeReport = null) {
  const workbook = XLSX.utils.book_new();
  const report = XLSX.utils.aoa_to_sheet(rows);
  if (customizeReport) customizeReport(report);
  XLSX.utils.book_append_sheet(workbook, report, 'Report');
  extraSheets.forEach(({ name, rows: sheetRows }) => {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(sheetRows), name);
  });
  return new Uint8Array(XLSX.write(workbook, { bookType: 'xls', type: 'array' }));
}

function validRows() {
  return [
    ['Emitido em 02/09/2026'],
    ['Produtos Vendidos'],
    ['Periodo: 01/09/2026 a 01/09/2026'],
    ['Ref.', 'Descricao', 'Codigo de Barra', 'Qtde', 'Observacao'],
    ['000123', 'Produto sanitizado A', '0000000000123', 2, ''],
    [],
    ['Emitido em 02/09/2026'],
    ['Produtos Vendidos'],
    ['Periodo: 01/09/2026 a 01/09/2026'],
    ['Ref.', 'Descricao', 'Codigo de Barra', '', 'Qtde'],
    ['000124', 'Produto sanitizado B', '0000000000124', '3,00', ''],
    ['', '', '', '5,00', 'Resumo sanitizado sem identificadores']
  ];
}

test('SheetJS 0.20.3 fica local, fixado e sem importacao de runtime externa', () => {
  assert.equal(SHEETJS_VERSION, '0.20.3');
  assert.match(vendorSource, /XLSX\.version = '0\.20\.3'/);
  assert.doesNotMatch(vendorSource, /^\s*import\s+.*(?:https?:|node:|npm:)/m);
  assert.match(adminSource, /\.\.\/supabase\/functions\/_shared\/futura-vendas-core\.mjs\?v=20260901-futura-xls-1/);
  assert.match(functionSource, /\.\.\/_shared\/futura-vendas-core\.mjs/);
});

test('relatorio XLS valido aceita cabecalhos repetidos e Qtde deslocada', () => {
  const parsed = parseFuturaVendasXls(workbookBytes(validRows()));
  assert.equal(parsed.competencia, '2026-09-01');
  assert.equal(parsed.totalCabecalhos, 2);
  assert.deepEqual(parsed.lines, [
    {
      referencia: '000123',
      codigo_barras: '0000000000123',
      descricao: 'Produto sanitizado A',
      quantidade_original: '2'
    },
    {
      referencia: '000124',
      codigo_barras: '0000000000124',
      descricao: 'Produto sanitizado B',
      quantidade_original: '3,00'
    }
  ]);
});

test('preserva zeros a esquerda exibidos pelo formato das celulas de codigo', () => {
  const bytes = workbookBytes([
    ['Produtos Vendidos - 01/09/2026'],
    ['Ref.', 'Descricao', 'Codigo de Barra', 'Qtde'],
    [123, 'Produto sanitizado', 456, 1]
  ], [], (sheet) => {
    sheet.A3.z = '000000';
    sheet.C3.z = '0000000000000';
  });
  const [line] = parseFuturaVendasXls(bytes).lines;
  assert.equal(line.referencia, '000123');
  assert.equal(line.codigo_barras, '0000000000456');
});

test('navegador e Function extraem as mesmas linhas, competencia e hash dos mesmos bytes', async () => {
  const bytes = workbookBytes(validRows());
  const preview = parseFuturaVendasXls(bytes);
  const official = await prepareFuturaVendasXls({
    arquivo_base64: Buffer.from(bytes).toString('base64')
  });
  assert.deepEqual(official.lines, preview.lines);
  assert.equal(official.competencia, preview.competencia);
  assert.equal(official.hash, await sha256Bytes(bytes));
});

test('rejeita arquivo que nao seja XLS legado, relatorio errado ou mais de uma planilha', () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(validRows()), 'Report');
  const xlsxBytes = new Uint8Array(XLSX.write(workbook, { bookType: 'xlsx', type: 'array' }));
  assert.throws(() => parseFuturaVendasXls(xlsxBytes), /Excel legado \.xls/);

  assert.throws(
    () => parseFuturaVendasXls(workbookBytes([
      ['Relatorio de Produtos'],
      ['Ref.', 'Descricao', 'Codigo de Barra', 'Qtde'],
      ['A', 'Produto', '1', 1]
    ])),
    /Produtos Vendidos/
  );

  assert.throws(
    () => parseFuturaVendasXls(workbookBytes(validRows(), [{ name: 'Outra', rows: [['x']] }])),
    /somente a planilha "Report"/
  );
});

test('rejeita periodo de varios dias e data invalida', () => {
  assert.throws(
    () => parseFuturaVendasXls(workbookBytes([
      ['Produtos Vendidos - Periodo: 01/09/2026 a 02/09/2026'],
      ['Ref.', 'Descricao', 'Codigo de Barra', 'Qtde'],
      ['A', 'Produto', '1', 1]
    ])),
    /exatamente um unico dia/
  );
  assert.throws(
    () => parseFuturaVendasXls(workbookBytes([
      ['Produtos Vendidos'],
      ['Periodo: 31/02/2026'],
      ['Ref.', 'Descricao', 'Codigo de Barra', 'Qtde'],
      ['A', 'Produto', '1', 1]
    ])),
    /data invalida/
  );
  assert.throws(
    () => parseFuturaVendasXls(workbookBytes([
      ['Produtos Vendidos'],
      ['Periodo nao informado'],
      ['Ref.', 'Descricao', 'Codigo de Barra', 'Qtde'],
      ['A', 'Produto', '1', 1]
    ])),
    /periodo inequivoco/
  );
  assert.throws(
    () => parseFuturaVendasXls(workbookBytes([
      ['Produtos Vendidos'],
      ['Periodo: 01/09/2026'],
      ['Reprocessado em 02/09/2026'],
      ['Ref.', 'Descricao', 'Codigo de Barra', 'Qtde'],
      ['A', 'Produto', '1', 1]
    ])),
    /periodo inequivoco/
  );
});

test('rejeita cabecalho ausente, parcial ou ambiguo', () => {
  assert.throws(
    () => parseFuturaVendasXls(workbookBytes([
      ['Produtos Vendidos - 01/09/2026'],
      ['Texto sem cabecalho']
    ])),
    /titulo sem cabecalho/
  );
  assert.throws(
    () => parseFuturaVendasXls(workbookBytes([
      ['Produtos Vendidos - 01/09/2026'],
      ['Ref.', 'Descricao', 'Codigo de Barra'],
      ['A', 'Produto', '1']
    ])),
    /cabecalho ausente ou ambiguo/
  );
  assert.throws(
    () => parseFuturaVendasXls(workbookBytes([
      ['Produtos Vendidos - 01/09/2026'],
      ['Ref.', 'Descricao', 'Codigo de Barra', 'Qtde', 'Quantidade'],
      ['A', 'Produto', '1', 1, 1]
    ])),
    /cabecalho ausente ou ambiguo/
  );
});

test('rejeita linha sem referencia, barras ou quantidade', () => {
  for (const row of [
    ['', 'Produto', '123', 1],
    ['A', 'Produto', '', 1],
    ['A', 'Produto', '123', '']
  ]) {
    assert.throws(
      () => parseFuturaVendasXls(workbookBytes([
        ['Produtos Vendidos - 01/09/2026'],
        ['Ref.', 'Descricao', 'Codigo de Barra', 'Qtde'],
        row
      ])),
      /referencia, codigo de barras e quantidade/
    );
  }
});

test('rejeita quantidade zero, negativa, fracionaria ou textual', () => {
  for (const quantity of [0, -1, 1.5, 'abc']) {
    assert.throws(
      () => parseFuturaVendasXls(workbookBytes([
        ['Produtos Vendidos - 01/09/2026'],
        ['Ref.', 'Descricao', 'Codigo de Barra', 'Qtde'],
        ['A', 'Produto', '123', quantity]
      ])),
      /quantidade invalida/
    );
  }
});

test('Admin aceita CSV e XLS, compara competencia e envia somente arquivo bruto', () => {
  assert.match(adminHtml, /accept="\.csv,\.xls,text\/csv,application\/vnd\.ms-excel"/);
  assert.match(adminSource, /selectedDate !== report\.competencia/);
  assert.match(adminSource, /csvPreviewReportDate && movementDate !== csvPreviewReportDate/);
  const invocation = adminSource.match(/sb\.functions\.invoke\('fechamento-csv-produtos'[\s\S]*?\}\)\)/)?.[0] || '';
  assert.match(invocation, /arquivo_base64:\s*csvPreviewRawBase64/);
  assert.match(invocation, /arquivo_nome:\s*csvPreviewFileName/);
  assert.match(invocation, /competencia:\s*movementDate/);
  assert.doesNotMatch(invocation, /linhas|produto_id|hash|resumo/i);
});

test('file protocol bloqueia leitura e aplicacao com orientacao segura', () => {
  const { result, elements } = csvProtocolHarness('file:');
  assert.equal(result, false);
  assert.equal(csvProtocolHarness('about:').result, false);
  assert.equal(elements['csv-baixa-input'].disabled, true);
  assert.equal(elements['csv-baixa-input'].value, '');
  assert.equal(elements['csv-preview-table-wrap'].style.display, 'none');
  assert.equal(elements['csv-apply-btn'].disabled, true);
  assert.match(elements['csv-preview-summary'].textContent, /servidor HTTP local/);
  assert.match(elements['csv-preview-summary'].textContent, /file:\/\//);

  const preview = adminSource.match(/async function handleCsvPreview\(event\) \{[\s\S]*?\r?\n}\r?\n\r?\nasync function confirmCsvBaixa/)?.[0] || '';
  assert.ok(preview, 'fluxo de previa deve existir');
  assert.ok(preview.indexOf('enforceCsvImportProtocol()') < preview.indexOf('file.arrayBuffer()'));
  assert.ok(preview.indexOf('enforceCsvImportProtocol()') < preview.indexOf('loadFuturaVendasCore()'));

  const confirm = adminSource.match(/async function confirmCsvBaixa\(\) \{[\s\S]*?\r?\n}\r?\n\r?\n\/\/ ─── VENDEDORES/)?.[0] || '';
  assert.ok(confirm, 'fluxo de aplicacao deve existir');
  assert.ok(confirm.indexOf('enforceCsvImportProtocol()') < confirm.indexOf("sb.functions.invoke('fechamento-csv-produtos'"));
});

test('HTTP e HTTPS mantem o importador habilitado para servidor local e GitHub Pages', () => {
  for (const protocol of ['http:', 'https:']) {
    const { result, elements } = csvProtocolHarness(protocol);
    assert.equal(result, true);
    assert.equal(elements['csv-baixa-input'].disabled, false);
    assert.equal(elements['csv-baixa-input'].value, 'relatorio.xls');
    assert.equal(elements['csv-preview-summary'].textContent, 'estado anterior');
    assert.equal(elements['csv-preview-table-wrap'].style.display, 'block');
    assert.equal(elements['csv-apply-btn'].disabled, false);
  }
  assert.match(adminHtml, /js\/admin\.js\?v=20260901-futura-xls-2/);
  assert.match(adminSource, /import\('\.\.\/supabase\/functions\/_shared\/futura-vendas-core\.mjs\?v=20260901-futura-xls-1'\)/);
});

test('Function reprocessa XLS bruto, compara competencia e valida candidatos antes da RPC', () => {
  assert.match(functionSource, /prepareFuturaVendasXls\(\{ arquivo_base64: payload\.arquivo_base64 \}\)/);
  assert.match(functionSource, /prepared\.competencia !== competence/);
  const xlsBlock = functionSource.match(/if \(fileName\.toLowerCase\(\)\.endsWith\("\.xls"\)\)[\s\S]*?\} else \{/i)?.[0] || '';
  assert.match(xlsBlock, /validateCandidates\(prepared\.lines, products\)/);
  assert.ok(xlsBlock.indexOf('validateCandidates') < functionSource.indexOf('adminClient.rpc("registrar_fechamento_csv_produtos"'));
});

test('migration 36 permanece fora do escopo do importador XLS', () => {
  const migration = readFileSync(
    new URL('../supabase/36-base-reconciliacao-zeragem-csv.sql', import.meta.url),
    'utf8'
  );
  assert.match(migration, /create or replace function public\.registrar_fechamento_csv_produtos/);
  assert.equal((migration.match(/^begin;$/gim) || []).length, 1);
  assert.equal((migration.match(/^commit;$/gim) || []).length, 1);
});
