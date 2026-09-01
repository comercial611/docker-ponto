import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {
  canonicalLines,
  parseCsvContent,
  prepareCsv,
  validateCandidates
} from '../supabase/functions/fechamento-csv-produtos/csv-core.mjs';

const adminSource = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8');
const migrationSource = readFileSync(
  new URL('../supabase/36-base-reconciliacao-zeragem-csv.sql', import.meta.url),
  'utf8'
);
const functionSource = readFileSync(
  new URL('../supabase/functions/fechamento-csv-produtos/index.ts', import.meta.url),
  'utf8'
);
const configSource = readFileSync(new URL('../supabase/config.toml', import.meta.url), 'utf8');

function extractCore() {
  const match = adminSource.match(
    /\/\/ BEGIN CSV_RECONCILIATION_CORE([\s\S]*?)\/\/ END CSV_RECONCILIATION_CORE/
  );
  assert.ok(match, 'núcleo CSV local deve existir');
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${match[1]}; this.core = CsvReconciliationCore;`, context);
  return context.core;
}

const core = extractCore();

function canonicalPayload(input) {
  return JSON.stringify({
    version: 2,
    name: input.name,
    hash: input.hash,
    competence: input.competence,
    lines: input.lines
  });
}

function applyModel(initial, input) {
  const next = structuredClone(initial);
  const payload = canonicalPayload(input);
  const priorHash = next.lots.find(lot => lot.hash === input.hash);
  if (priorHash) {
    if (priorHash.competence !== input.competence || priorHash.payload !== payload) {
      throw new Error('hash divergente');
    }
    return { state: initial, repeated: true };
  }
  if (next.lots.some(lot => lot.competence === input.competence)) {
    throw new Error('competência já fechada');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) throw new Error('CSV vazio');

  if (next.coverages.some(coverage => !coverage.reconciled
      && (coverage.competence !== input.competence || coverage.voltage))) {
    throw new Error('competência divergente ou voltagem sem identificação');
  }

  const aggregated = new Map();
  for (const line of input.lines) {
    if (!Number.isInteger(line.productId) || !Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new Error('linha inválida');
    }
    aggregated.set(line.productId, (aggregated.get(line.productId) || 0) + line.quantity);
  }

  for (const [productId, quantity] of aggregated) {
    const coverage = next.coverages.find(item => item.productId === productId && !item.reconciled);
    if (coverage && coverage.quantity !== quantity) throw new Error('cobertura divergente');
    if (!coverage && next.stock[productId] < quantity) throw new Error('estoque insuficiente');
  }
  for (const coverage of next.coverages.filter(item => item.competence === input.competence && !item.reconciled)) {
    if (!aggregated.has(coverage.productId)) throw new Error('cobertura ausente no CSV');
  }

  for (const [productId, quantity] of aggregated) {
    const coverage = next.coverages.find(item => item.productId === productId && item.competence === input.competence && !item.reconciled);
    if (coverage) {
      coverage.reconciled = true;
      next.events.push({ productId, quantity, competence: input.competence });
    } else {
      next.stock[productId] -= quantity;
    }
  }
  next.lots.push({ hash: input.hash, competence: input.competence, payload });
  return { state: next, repeated: false };
}

test('frontend envia somente arquivo bruto e metadados mínimos à Function', () => {
  assert.match(adminSource, /sb\.functions\.invoke\('fechamento-csv-produtos'/);
  const invocation = adminSource.match(/sb\.functions\.invoke\('fechamento-csv-produtos'[\s\S]*?\}\)\)/)?.[0] || '';
  assert.match(invocation, /arquivo_base64:\s*csvPreviewRawBase64/);
  assert.match(invocation, /arquivo_nome:\s*csvPreviewFileName/);
  assert.match(invocation, /competencia:\s*movementDate/);
  assert.doesNotMatch(invocation, /hash|produto_id|resumo|usuario|email|perfil/i);
  assert.doesNotMatch(adminSource, /sb\.rpc\(['"]registrar_fechamento_csv_produtos/);
  assert.match(adminSource, /validOfficialResult\(data\)/);
});

test('mensagem final preserva sucesso e replay idempotente após recarregar os dados', () => {
  const successBlock = adminSource.match(
    /csvPreviewApplied = true;([\s\S]*?)\n\}/
  )?.[1] || '';
  const stateUpdate = successBlock.indexOf('updateCsvApplyState();');
  const resultMessage = successBlock.indexOf("msg.textContent = data.repetida");

  assert.ok(stateUpdate >= 0, 'estado final deve ser atualizado');
  assert.ok(resultMessage > stateUpdate, 'mensagem específica deve ser definida depois do estado genérico');
  assert.match(successBlock, /Este fechamento oficial ja havia sido aplicado/);
  assert.match(successBlock, /sem nova baixa/);
});

test('normalização usada no hash permanece determinística', () => {
  assert.equal(core.normalizeContent('\uFEFFa,b\r\n1,2\r\n'), 'a,b\n1,2');
});

test('Function calcula hash do conteúdo bruto normalizado e ignora hash forjado', async () => {
  const content = '\uFEFFreferencia,descricao,quantidade\r\nA-1,Produto,2\r\n';
  const prepared = await prepareCsv({
    arquivo_base64: Buffer.from(content, 'utf8').toString('base64'),
    hash: '0'.repeat(64),
    products: [{ id: 1, ativo: true, categoria: 'produto', codigo_referencia: 'A-1' }]
  });
  assert.equal(prepared.normalizedContent, 'referencia,descricao,quantidade\nA-1,Produto,2');
  assert.notEqual(prepared.hash, '0'.repeat(64));
  assert.equal(prepared.hash.length, 64);
  assert.deepEqual(prepared.lines, [{
    referencia: 'A-1', codigo_barras: null, descricao: 'Produto', quantidade_original: '2'
  }]);
});

test('arquivo truncado, codificação inválida e quantidade corretiva falham antes da RPC', async () => {
  await assert.rejects(() => prepareCsv({
    arquivo_base64: Buffer.from('referencia,descricao,quantidade\n"A-1,Produto,2', 'utf8').toString('base64'),
    products: []
  }), /aspas nao finalizadas/);
  await assert.rejects(() => prepareCsv({
    arquivo_base64: Buffer.from([0xff, 0xfe]).toString('base64'),
    products: []
  }), /UTF-8/);
  assert.throws(() => canonicalLines(parseCsvContent('referencia,descricao,quantidade\nA-1,Produto,-2')), /corretiva/);
});

test('parser CSV aceita somente aspas estruturais e escape duplo dentro de campo quoted', () => {
  assert.throws(
    () => parseCsvContent('"A-1"x,Produto,1'),
    /caractere invalido apos campo entre aspas/
  );
  assert.throws(
    () => parseCsvContent('A"1,Produto,1'),
    /aspas fora do inicio de um campo/
  );
  assert.deepEqual(parseCsvContent('"A""1",Produto,1'), [['A"1', 'Produto', '1']]);

  assert.throws(() => core.parseContent('"A-1"x,Produto,1'), /Caractere invalido/);
  assert.throws(() => core.parseContent('A"1,Produto,1'), /Aspas fora do inicio/);
  assert.deepEqual(
    JSON.parse(JSON.stringify(core.parseContent('"A""1",Produto,1'))),
    [['A"1', 'Produto', '1']]
  );
});

test('prévia local trata erro de parser e bloqueia candidatos ambíguos', () => {
  const activeProduct = { product: { id: 1, ativo: true }, matchBy: 'Referencia' };
  const machine = { product: { id: 2, ativo: true }, matchBy: 'Referencia' };
  assert.equal(core.resolveCandidates([activeProduct], [machine]).status, 'ambiguous');
  assert.equal(core.resolveCandidates([activeProduct], []).status, 'product');
  assert.equal(core.resolveCandidates([
    activeProduct,
    { product: { id: 3, ativo: true }, matchBy: 'Referencia' }
  ], []).status, 'ambiguous');

  assert.match(adminSource, /new TextDecoder\('utf-8', \{ fatal: true \}\)\.decode\(fileBytes\);[\s\S]*csvRowsToItems\(parseCsvText\(text\)\)/);
  assert.match(adminSource, /Nao foi possivel interpretar o arquivo/);
  assert.match(adminSource, /blockingReason:\s*resolution\.status === 'ambiguous'/);
  assert.match(adminSource, /const blocked = csvPreviewRows\.some\(row => row\.blocking\)/);
  assert.match(adminSource, /btn\.disabled = [^;]*blocked/);
});

test('candidato produto e máquina com o mesmo código é rejeitado', () => {
  const lines = [{ referencia: 'X-1', codigo_barras: null, descricao: 'Item', quantidade_original: '1' }];
  assert.throws(() => validateCandidates(lines, [
    { id: 1, ativo: true, categoria: 'produto', codigo_referencia: 'X-1' },
    { id: 2, ativo: true, categoria: 'maquina', codigo_referencia: 'X-1' }
  ]), /ambiguo entre produto e maquina/);
});

test('código que corresponde somente a produto inativo é rejeitado sem aplicação', () => {
  const lines = [{ referencia: 'INATIVO-1', codigo_barras: null, descricao: 'Item', quantidade_original: '1' }];
  assert.throws(() => validateCandidates(lines, [
    { id: 7, ativo: false, categoria: 'produto', codigo_referencia: 'INATIVO-1' }
  ]), /somente a produto inativo/);

  const inactiveGuard = migrationSource.indexOf('codigo correspondente somente a produto inativo');
  const firstMutation = migrationSource.indexOf('insert into public.baixas_csv_lotes');
  assert.ok(inactiveGuard > 0 && inactiveGuard < firstMutation);
  assert.match(migrationSource, /candidatos_produto > 0 and candidatos_produto_ativo = 0/i);
});

test('payload forjado e autenticação inválida são rejeitados na Function', () => {
  assert.match(functionSource, /REQUEST_FIELDS = new Set\(\["arquivo_base64", "arquivo_nome", "competencia"\]\)/);
  assert.match(functionSource, /Object\.keys\(payload\)\.some\(\(field\) => !REQUEST_FIELDS\.has\(field\)\)/);
  assert.match(functionSource, /auth\.getUser\(\)/);
  assert.match(functionSource, /userClient\.rpc\("usuario_tipo"\)/);
  assert.match(functionSource, /userType !== "admin"/);
  assert.match(configSource, /\[functions\.fechamento-csv-produtos\]\s*verify_jwt = true/);
});

test('CSV válido aplica a baixa uma única vez', () => {
  const initial = { stock: { 1: 10 }, lots: [], coverages: [], events: [] };
  const input = {
    name: 'oficial.csv', hash: 'a'.repeat(64), competence: '2026-08-24',
    lines: [{ productId: 1, quantity: 3 }]
  };
  const first = applyModel(initial, input);
  assert.equal(first.state.stock[1], 7);
  const retry = applyModel(first.state, input);
  assert.equal(retry.repeated, true);
  assert.equal(retry.state.stock[1], 7);
  assert.equal(retry.state.lots.length, 1);
});

test('payload divergente com o mesmo hash falha sem mutação', () => {
  const initial = { stock: { 1: 10 }, lots: [], coverages: [], events: [] };
  const base = {
    name: 'oficial.csv', hash: 'b'.repeat(64), competence: '2026-08-24',
    lines: [{ productId: 1, quantity: 3 }]
  };
  const applied = applyModel(initial, base).state;
  const snapshot = structuredClone(applied);
  assert.throws(() => applyModel(applied, { ...base, lines: [{ productId: 1, quantity: 4 }] }), /hash divergente/);
  assert.deepEqual(applied, snapshot);
});

test('lote inválido produz rollback integral', () => {
  const initial = { stock: { 1: 10, 2: 1 }, lots: [], coverages: [], events: [] };
  const snapshot = structuredClone(initial);
  assert.throws(() => applyModel(initial, {
    name: 'oficial.csv', hash: 'c'.repeat(64), competence: '2026-08-24',
    lines: [{ productId: 1, quantity: 2 }, { productId: 2, quantity: 3 }]
  }), /estoque insuficiente/);
  assert.deepEqual(initial, snapshot);
});

test('competência única bloqueia arquivo corretivo ou diferente', () => {
  const initial = {
    stock: { 1: 10 },
    lots: [{ hash: 'd'.repeat(64), competence: '2026-08-24', payload: '{}' }],
    coverages: [], events: []
  };
  assert.throws(() => applyModel(initial, {
    name: 'corretivo.csv', hash: 'e'.repeat(64), competence: '2026-08-24',
    lines: [{ productId: 1, quantity: 1 }]
  }), /competência já fechada/);
});

test('cobertura exige competência e quantidade exatas sem consumir entrada posterior', () => {
  const initial = {
    stock: { 1: 5 },
    lots: [],
    coverages: [{ productId: 1, competence: '2026-08-24', quantity: 4, voltage: null, reconciled: false }],
    events: []
  };
  const input = {
    name: 'oficial.csv', hash: 'f'.repeat(64), competence: '2026-08-24',
    lines: [{ productId: 1, quantity: 4 }]
  };
  const applied = applyModel(initial, input).state;
  assert.equal(applied.stock[1], 5, 'entrada posterior deve permanecer intacta');
  assert.equal(applied.events.length, 1);

  assert.throws(() => applyModel({ ...structuredClone(initial), lots: [] }, {
    ...input, hash: '1'.repeat(64), lines: [{ productId: 1, quantity: 3 }]
  }), /cobertura divergente/);
  assert.throws(() => applyModel({ ...structuredClone(initial), lots: [] }, {
    ...input, hash: '2'.repeat(64), competence: '2026-08-25'
  }), /competência divergente/);
});

test('cobertura ausente e cobertura de voltagem são bloqueadas', () => {
  const missing = {
    stock: { 1: 0, 2: 10 }, lots: [],
    coverages: [{ productId: 1, competence: '2026-08-24', quantity: 2, voltage: null, reconciled: false }],
    events: []
  };
  assert.throws(() => applyModel(missing, {
    name: 'oficial.csv', hash: '3'.repeat(64), competence: '2026-08-24',
    lines: [{ productId: 2, quantity: 1 }]
  }), /cobertura ausente/);

  const voltage = {
    stock: { 1: 0 }, lots: [],
    coverages: [{ productId: 1, competence: '2026-08-24', quantity: 2, voltage: '110v', reconciled: false }],
    events: []
  };
  assert.throws(() => applyModel(voltage, {
    name: 'oficial.csv', hash: '4'.repeat(64), competence: '2026-08-24',
    lines: [{ productId: 1, quantity: 2 }]
  }), /voltagem/);
});

test('cobertura de outra competência bloqueia mesmo se o produto estiver ausente', () => {
  const state = {
    stock: { 1: 0, 2: 10 }, lots: [],
    coverages: [{ productId: 1, competence: '2026-08-23', quantity: 2, voltage: null, reconciled: false }],
    events: []
  };
  const snapshot = structuredClone(state);
  assert.throws(() => applyModel(state, {
    name: 'oficial.csv', hash: '5'.repeat(64), competence: '2026-08-24',
    lines: [{ productId: 2, quantity: 1 }]
  }), /competência divergente/);
  assert.deepEqual(state, snapshot);
});

test('migration 36 mantém uma transação, uma fronteira server-side e rollback por exceção', () => {
  assert.equal((migrationSource.match(/^begin;$/gim) || []).length, 1);
  assert.equal((migrationSource.match(/^commit;$/gim) || []).length, 1);
  assert.match(
    migrationSource,
    /create unique index baixas_csv_lotes_competencia_uidx[\s\S]*where validacao_versao >= 2[\s\S]*data_movimento is not null/i
  );
  assert.match(migrationSource, /pg_advisory_xact_lock[\s\S]*csv-competencia:[\s\S]*pg_advisory_xact_lock[\s\S]*csv-arquivo:/i);
  assert.match(migrationSource, /v_lote\.payload_normalizado is distinct from v_payload/i);
  assert.match(migrationSource, /corretivos exigem revisao manual auditada/i);
  assert.match(migrationSource, /correspondencia exata/i);
  assert.match(migrationSource, /join public\.perfis p on p\.user_id = u\.id[\s\S]*p\.tipo = 'admin'/i);
  assert.doesNotMatch(migrationSource, /v_usuario_id uuid := auth\.uid\(\)/i);
  assert.doesNotMatch(migrationSource, /auth\.jwt\(\)->>'email'/i);
  assert.match(
    migrationSource,
    /A guarda[\s\S]*e global: o produto coberto nao precisa aparecer no novo arquivo/i
  );

  const firstMutation = migrationSource.indexOf('insert into public.baixas_csv_lotes');
  assert.ok(firstMutation > migrationSource.indexOf('Existe produto com estoque insuficiente'));
  assert.ok(firstMutation > migrationSource.indexOf('O CSV oficial nao contem todos os produtos'));
});

test('migration 36 preserva legado v1 e grava somente fechamentos oficiais como v2', () => {
  assert.match(
    migrationSource,
    /add column validacao_versao smallint not null default 1/i
  );
  assert.match(
    migrationSource,
    /validacao_versao,\s*payload_normalizado[\s\S]*\) values \([\s\S]*,\s*2,\s*v_payload/i
  );
  assert.doesNotMatch(
    migrationSource,
    /create unique index baixas_csv_lotes_competencia_uidx[\s\S]*where data_movimento is not null\s*;/i
  );
  assert.match(
    migrationSource,
    /where l\.validacao_versao >= 2\s+and l\.data_movimento = p_data_movimento/i
  );
  assert.match(
    migrationSource,
    /v_lote\.validacao_versao <> 2[\s\S]*or v_lote\.data_movimento is distinct from p_data_movimento/i
  );
});

test('trigger de cobertura usa alvos escalares compatíveis no SELECT INTO', () => {
  assert.doesNotMatch(
    migrationSource,
    /select\s+i\s*,\s*o\.tipo\s+into\s+v_item\s*,\s*v_tipo/i
  );
  assert.match(
    migrationSource,
    /select\s+i\.produto_id\s*,\s*i\.voltagem\s*,\s*i\.quantidade_anterior\s*,\s*i\.quantidade_nova\s*,\s*o\.tipo\s+into\s+v_item_produto_id\s*,\s*v_item_voltagem\s*,\s*v_item_quantidade_anterior\s*,\s*v_item_quantidade_nova\s*,\s*v_tipo/i
  );
});

test('RPC inferior não pode ser chamada pelo navegador', () => {
  assert.match(migrationSource, /registrar_baixa_csv_produtos[\s\S]*nao aceita chamadas diretas/i);
  assert.match(migrationSource, /revoke all on function public\.registrar_baixa_csv_produtos[\s\S]*from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(adminSource, /sb\.rpc\(['"]registrar_baixa_csv_produtos/);
  assert.match(
    migrationSource,
    /revoke all on function public\.registrar_fechamento_csv_produtos\(jsonb, text, text, date, uuid\)[\s\S]*from public, anon, authenticated, service_role[\s\S]*grant execute on function public\.registrar_fechamento_csv_produtos\(jsonb, text, text, date, uuid\)[\s\S]*to service_role/i
  );
  assert.doesNotMatch(migrationSource, /grant execute on function public\.registrar_fechamento_csv_produtos[\s\S]{0,150}to authenticated/i);
  assert.match(functionSource, /p_usuario_id:\s*authenticatedUser\.id/);
  assert.doesNotMatch(functionSource, /p_(usuario_email|perfil|tipo_usuario)/i);
});

test('Function nao permite que o cliente controle a versao do lote', () => {
  assert.match(functionSource, /registrar_fechamento_csv_produtos/);
  assert.doesNotMatch(functionSource, /validacao_versao\s*:/i);
  assert.doesNotMatch(functionSource, /payload_normalizado\s*:/i);
});

test('SQL rejeita ambiguidade produto/máquina antes da primeira escrita', () => {
  const ambiguity = migrationSource.indexOf('codigo ambiguo entre produto e maquina');
  const firstMutation = migrationSource.indexOf('insert into public.baixas_csv_lotes');
  assert.ok(ambiguity > 0 && ambiguity < firstMutation);
  assert.match(migrationSource, /candidatos_produto > 0 and candidatos_maquina > 0/i);
  assert.match(migrationSource, /candidatos_produto_ativo = 1[\s\S]*candidatos_maquina = 0/i);
});

test('fundação de cobertura não expõe escrita nem cria zeragem', () => {
  assert.match(migrationSource, /create table public\.estoque_coberturas_csv/i);
  assert.match(migrationSource, /create table public\.estoque_cobertura_csv_eventos/i);
  assert.match(migrationSource, /revoke all on public\.estoque_coberturas_csv[\s\S]*from public, anon, authenticated/i);
  assert.doesNotMatch(migrationSource, /create\s+(or\s+replace\s+)?function\s+public\.registrar_zeragem/i);
});

test('fase não contém integração ou escrita Nuvemshop', () => {
  assert.doesNotMatch(migrationSource, /nuvemshop_[a-z_]+/i);
  assert.doesNotMatch(functionSource, /nuvemshop|fetch\s*\(/i);
});
