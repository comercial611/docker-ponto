import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const adminSource = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8');
const adminHtml = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const migrationSource = readFileSync(new URL('../supabase/34-registrar-entrada-estoque.sql', import.meta.url), 'utf8');

function markedSection(source, name) {
  const match = source.match(new RegExp(`// BEGIN ${name}([\\s\\S]*?)// END ${name}`));
  assert.ok(match, `seção ${name} não encontrada`);
  return match[1];
}

const coreSource = markedSection(adminSource, 'ENTRADA_ESTOQUE_CORE');
const uiSource = markedSection(adminSource, 'ENTRADA_ESTOQUE_UI');
const coreContext = {
  Date,
  Promise,
  Uint8Array,
  clearTimeout,
  setTimeout
};
vm.createContext(coreContext);
vm.runInContext(`${coreSource}\nthis.EntradaEstoqueCore = EntradaEstoqueCore;`, coreContext);
const core = coreContext.EntradaEstoqueCore;

const operationKey = '11111111-1111-4111-8111-111111111111';
const today = '2026-08-21';
const products = [
  { id: 1, nome: 'Papel A4', sku: 'SKU-A4', ativo: true, tem_voltagem: false, quantidade: 10, quantidade_110v: 91, quantidade_220v: 92, preco: 12 },
  { id: 2, nome: 'Prensa', sku: 'SKU-PRENSA', ativo: true, tem_voltagem: true, quantidade: 93, quantidade_110v: 3, quantidade_220v: 4, preco: 900 },
  { id: 3, nome: 'Caneca', sku: 'SKU-CANECA', ativo: true, tem_voltagem: false, quantidade: 7, quantidade_110v: 94, quantidade_220v: 95, preco: 20 },
  { id: 4, nome: 'Inativo', sku: 'SKU-INATIVO', ativo: false, tem_voltagem: false, quantidade: 0, preco: 1 }
];

function draft(itens, overrides = {}) {
  return {
    chave_operacao: operationKey,
    motivo: 'Recebimento da nota 123',
    data_movimento: today,
    itens,
    ...overrides
  };
}

function validItem(produtoId, quantidade, voltagem = null) {
  return { produto_id: String(produtoId), quantidade: String(quantidade), voltagem };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizedPayload(args) {
  return JSON.stringify({
    tipo: 'entrada',
    motivo: args.p_motivo.trim(),
    data_movimento: args.p_data_movimento,
    itens: clone(args.p_itens).sort((a, b) => a.produto_id - b.produto_id || String(a.voltagem).localeCompare(String(b.voltagem)))
  });
}

function createMockRegistrar(initialProducts) {
  const state = new Map(initialProducts.map(product => [product.id, clone(product)]));
  const operations = new Map();

  async function register(args) {
    const payload = normalizedPayload(args);
    const previous = operations.get(args.p_chave_operacao);
    if (previous) {
      if (previous.payload !== payload) throw new Error('chave usada com dados diferentes');
      return clone(previous.rows).map(row => ({ ...row, repetida: true }));
    }

    const staged = new Map(Array.from(state, ([id, product]) => [id, clone(product)]));
    const rows = [];
    for (const item of args.p_itens) {
      const product = staged.get(item.produto_id);
      if (!product || product.ativo !== true) throw new Error('produto inexistente ou inativo');
      if (!Number.isInteger(item.quantidade) || item.quantidade <= 0) throw new Error('quantidade invalida');
      let field;
      if (product.tem_voltagem) {
        if (item.voltagem === '110v') field = 'quantidade_110v';
        else if (item.voltagem === '220v') field = 'quantidade_220v';
        else throw new Error('voltagem invalida');
      } else {
        if (item.voltagem !== null) throw new Error('produto simples com voltagem');
        field = 'quantidade';
      }
      const before = product[field];
      product[field] += item.quantidade;
      rows.push({ produto_id: item.produto_id, voltagem: item.voltagem, quantidade_anterior: before, quantidade_nova: product[field], repetida: false });
    }

    state.clear();
    staged.forEach((product, id) => state.set(id, product));
    operations.set(args.p_chave_operacao, { payload, rows: clone(rows) });
    return rows;
  }

  return { operations, register, state };
}

test('lote simples normaliza IDs e quantidades como números', () => {
  const result = core.validateDraft(draft([validItem(1, 5)]), products, today);
  assert.equal(result.ok, true);
  assert.deepEqual(
    JSON.parse(JSON.stringify(result.normalized.itens)),
    [{ produto_id: 1, quantidade: 5, voltagem: null }]
  );
  assert.equal(core.currentBalance(products[0], null), 10);
});

test('110V e 220V ficam isolados e o mesmo produto aceita as duas variantes', () => {
  const result = core.validateDraft(draft([
    validItem(2, 2, '110v'),
    validItem(2, 6, '220v')
  ]), products, today);
  assert.equal(result.ok, true);
  assert.equal(core.currentBalance(products[1], '110v'), 3);
  assert.equal(core.currentBalance(products[1], '220v'), 4);
});

test('uma entrada aceita múltiplos SKUs', () => {
  const result = core.validateDraft(draft([
    validItem(1, 2),
    validItem(3, 8),
    validItem(2, 1, '110v')
  ]), products, today);
  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.normalized.itens, item => item.produto_id), [1, 3, 2]);
});

test('item ou variante duplicada é rejeitado', () => {
  assert.equal(core.validateDraft(draft([validItem(1, 1), validItem(1, 2)]), products, today).ok, false);
  assert.equal(core.validateDraft(draft([validItem(2, 1, '110v'), validItem(2, 2, '110v')]), products, today).ok, false);
});

test('quantidade zero, negativa, fracionária e texto são rejeitados', () => {
  for (const invalid of ['0', '-1', '1.5', 'duas']) {
    const result = core.validateDraft(draft([validItem(1, invalid)]), products, today);
    assert.equal(result.ok, false, `deveria rejeitar ${invalid}`);
    assert.match(result.errors.join(' '), /inteira positiva/);
  }
});

test('produto inativo e inexistente são rejeitados', () => {
  assert.equal(core.validateDraft(draft([validItem(4, 1)]), products, today).ok, false);
  assert.equal(core.validateDraft(draft([validItem(999, 1)]), products, today).ok, false);
});

test('motivo e data inválidos são rejeitados', () => {
  assert.equal(core.validateDraft(draft([validItem(1, 1)], { motivo: '   ' }), products, today).ok, false);
  assert.equal(core.validateDraft(draft([validItem(1, 1)], { motivo: 'x'.repeat(501) }), products, today).ok, false);
  assert.equal(core.validateDraft(draft([validItem(1, 1)], { data_movimento: '2026-02-30' }), products, today).ok, false);
  assert.equal(core.validateDraft(draft([validItem(1, 1)], { data_movimento: '2026-08-22' }), products, today).ok, false);
});

test('primeira chamada soma, repetição idempotente não soma e payload divergente falha', async () => {
  const mock = createMockRegistrar(products);
  const validation = core.validateDraft(draft([validItem(1, 5)]), products, today);
  const args = core.rpcArguments(validation.normalized);
  const first = await mock.register(args);
  assert.equal(first[0].quantidade_nova, 15);
  assert.equal(mock.state.get(1).quantidade, 15);

  const repeated = await mock.register(clone(args));
  assert.equal(repeated[0].repetida, true);
  assert.equal(mock.state.get(1).quantidade, 15);
  assert.equal(mock.operations.size, 1);

  const divergent = clone(args);
  divergent.p_itens[0].quantidade = 6;
  await assert.rejects(mock.register(divergent), /dados diferentes/);
  assert.equal(mock.state.get(1).quantidade, 15);
});

test('falha em qualquer item faz rollback total no mock transacional', async () => {
  const mock = createMockRegistrar(products);
  const validation = core.validateDraft(draft([validItem(1, 5), validItem(3, 2)]), products, today);
  const args = core.rpcArguments(validation.normalized);
  args.p_itens.push({ produto_id: 999, quantidade: 1, voltagem: null });
  await assert.rejects(mock.register(args), /inexistente/);
  assert.equal(mock.state.get(1).quantidade, 10);
  assert.equal(mock.state.get(3).quantidade, 7);
  assert.equal(mock.operations.size, 0);
});

test('timeout preserva e reutiliza a mesma UUID e os mesmos argumentos', async () => {
  const validation = core.validateDraft(draft([validItem(1, 4)]), products, today);
  const args = core.rpcArguments(validation.normalized);
  const attempts = [];
  await assert.rejects(
    core.callWithTimeout(received => {
      attempts.push(clone(received));
      return new Promise(() => {});
    }, args, 5),
    error => core.isNetworkFailure(error)
  );

  const storageData = new Map();
  const storage = {
    getItem: key => storageData.get(key) || null,
    setItem: (key, value) => storageData.set(key, value)
  };
  const retryDraft = { version: 1, chave_operacao: operationKey, retry_locked: true, pending_args: args };
  assert.equal(core.saveDraft(storage, 'entrada', retryDraft), true);
  const restored = core.loadDraft(storage, 'entrada');
  const response = await core.callWithTimeout(received => {
    attempts.push(clone(received));
    return { data: [{ repetida: true }], error: null };
  }, restored.pending_args, 20);

  assert.equal(response.error, null);
  assert.deepEqual(attempts[0], attempts[1]);
  assert.equal(attempts[1].p_chave_operacao, operationKey);
});

test('timeout bloqueia descarte e mantém rascunho, UUID e payload', async () => {
  const validation = core.validateDraft(draft([validItem(1, 4)]), products, today);
  const args = core.rpcArguments(validation.normalized);
  let timeoutError;
  try {
    await core.callWithTimeout(() => new Promise(() => {}), args, 5);
  } catch (error) {
    timeoutError = error;
  }

  const locked = core.draftAfterFailure({
    version: 1,
    chave_operacao: operationKey,
    confirmado: true,
    retry_locked: true,
    pending_args: args
  }, timeoutError);
  assert.equal(locked.retry_locked, true);
  assert.equal(core.canDiscardDraft(locked), false);
  assert.equal(locked.chave_operacao, operationKey);
  assert.deepEqual(locked.pending_args, args);

  const discardSource = uiSource.slice(
    uiSource.indexOf('function discardEntradaEstoque()'),
    uiSource.indexOf('function setEntradaEstoqueFeedback')
  );
  const guardPosition = discardSource.indexOf('EntradaEstoqueCore.canDiscardDraft');
  const removePosition = discardSource.indexOf('sessionStorage.removeItem');
  assert.ok(guardPosition >= 0 && removePosition > guardPosition);
  assert.match(discardSource, /não pode ser descartada porque o resultado é incerto/);

  const discardHarness = {
    EntradaEstoqueCore: core,
    entradaEstoqueDraft: locked,
    entradaEstoqueSubmitting: false,
    feedback: '',
    controlUpdates: 0,
    confirms: 0,
    removals: 0,
    sessionStorage: { removeItem() { discardHarness.removals += 1; } },
    closeEntradaEstoqueModal() {},
    refreshEntradaEstoqueButton() {}
  };
  discardHarness.setEntradaEstoqueFeedback = message => { discardHarness.feedback = message; };
  discardHarness.updateEntradaEstoqueControls = () => { discardHarness.controlUpdates += 1; };
  discardHarness.confirm = () => { discardHarness.confirms += 1; return true; };
  vm.createContext(discardHarness);
  vm.runInContext(`${discardSource}\nthis.runDiscard = discardEntradaEstoque;`, discardHarness);
  discardHarness.runDiscard();
  assert.strictEqual(discardHarness.entradaEstoqueDraft, locked);
  assert.equal(discardHarness.removals, 0);
  assert.equal(discardHarness.confirms, 0);
  assert.equal(discardHarness.controlUpdates, 1);
  assert.match(discardHarness.feedback, /não pode ser descartada/);
});

test('timeout impede abrir nova entrada com nova UUID', () => {
  const args = core.rpcArguments(core.validateDraft(draft([validItem(1, 2)]), products, today).normalized);
  const locked = {
    version: 1,
    chave_operacao: operationKey,
    retry_locked: true,
    pending_args: args
  };
  const selected = core.selectDraftForOpen(locked, null);
  assert.strictEqual(selected, locked);
  assert.equal(selected.chave_operacao, operationKey);
  assert.deepEqual(selected.pending_args, args);
  assert.match(uiSource, /selectDraftForOpen\(entradaEstoqueDraft, stored\)/);
  assert.match(uiSource, /Retomar operação pendente/);
});

test('reload durante a primeira chamada recupera lote já bloqueado e imutável', async () => {
  const validation = core.validateDraft(draft([validItem(1, 9), validItem(2, 2, '220v')]), products, today);
  const args = core.rpcArguments(validation.normalized);
  const storageData = new Map();
  const storage = {
    getItem: key => storageData.get(key) || null,
    setItem: (key, value) => storageData.set(key, value)
  };
  const inFlightDraft = {
    version: 1,
    chave_operacao: operationKey,
    motivo: args.p_motivo,
    data_movimento: args.p_data_movimento,
    itens: args.p_itens,
    confirmado: true,
    retry_locked: true,
    pending_args: args
  };

  assert.equal(core.saveDraft(storage, 'entrada', inFlightDraft), true);
  const restoredWhileInFlight = core.loadDraft(storage, 'entrada');
  const selectedAfterReload = core.selectDraftForOpen(null, restoredWhileInFlight);
  assert.equal(restoredWhileInFlight.retry_locked, true);
  assert.deepEqual(restoredWhileInFlight.pending_args, args);
  assert.equal(restoredWhileInFlight.chave_operacao, operationKey);
  assert.strictEqual(selectedAfterReload, restoredWhileInFlight);
  assert.equal(core.canDiscardDraft(selectedAfterReload), false);
  assert.match(uiSource, /discard\.hidden = entradaEstoqueDraft\.retry_locked/);
  assert.match(uiSource, /if \(!entradaEstoqueDraft \|\| entradaEstoqueDraft\.retry_locked\) return;/);
  assert.match(uiSource, /if \(entradaEstoqueDraft\.retry_locked\) \{\s*args = entradaEstoqueDraft\.pending_args;/);

  const submitSource = uiSource.slice(uiSource.indexOf('async function submitEntradaEstoque()'));
  const lockPosition = submitSource.indexOf('entradaEstoqueDraft.retry_locked = true');
  const persistPosition = submitSource.indexOf('saveEntradaEstoqueDraft()', lockPosition);
  const requestPosition = submitSource.indexOf('EntradaEstoqueCore.callWithTimeout', persistPosition);
  assert.ok(lockPosition >= 0 && persistPosition > lockPosition && requestPosition > persistPosition);
});

test('somente erro definitivo sem escrita libera correção ou novo rascunho', () => {
  const args = core.rpcArguments(core.validateDraft(draft([validItem(1, 3)]), products, today).normalized);
  const locked = {
    version: 1,
    chave_operacao: operationKey,
    confirmado: true,
    retry_locked: true,
    pending_args: args
  };

  const definitive = core.rpcErrorFromResponse({ message: 'quantidade rejeitada' }, 400);
  const released = core.draftAfterFailure(locked, definitive);
  assert.equal(core.isConfirmedNoWriteError(definitive), true);
  assert.equal(released.retry_locked, false);
  assert.equal(released.pending_args, null);
  assert.equal(released.confirmado, false);
  assert.equal(core.canDiscardDraft(released), true);

  for (const status of [408, 425, 429, 500, 502, undefined]) {
    const ambiguous = core.rpcErrorFromResponse({ message: 'resultado incerto' }, status);
    const preserved = core.draftAfterFailure(locked, ambiguous);
    assert.equal(core.isConfirmedNoWriteError(ambiguous), false, `status ${status} deve continuar ambíguo`);
    assert.equal(preserved.retry_locked, true);
    assert.deepEqual(preserved.pending_args, args);
  }
});

test('resposta anômala da RPC mantém operação incerta e somente o contrato real é aceito', () => {
  const args = core.rpcArguments(core.validateDraft(draft([
    validItem(1, 3),
    validItem(2, 2, '220v')
  ]), products, today).normalized);
  const validData = [
    {
      operacao_id: 51,
      chave_operacao: operationKey,
      produto_id: 1,
      produto_nome: 'Papel A4',
      voltagem: null,
      quantidade: 3,
      quantidade_anterior: 10,
      quantidade_nova: 13,
      historico_id: 71,
      repetida: false
    },
    {
      operacao_id: 51,
      chave_operacao: operationKey,
      produto_id: 2,
      produto_nome: 'Prensa',
      voltagem: '220v',
      quantidade: 2,
      quantidade_anterior: 4,
      quantidade_nova: 6,
      historico_id: 72,
      repetida: false
    }
  ];
  const locked = {
    version: 1,
    chave_operacao: operationKey,
    confirmado: true,
    retry_locked: true,
    pending_args: args
  };

  assert.equal(core.isValidRpcResult(validData, args), true);
  for (const invalidData of [
    null,
    { ...validData[0] },
    [],
    [{ ...validData[0], quantidade_nova: 14 }, validData[1]]
  ]) {
    assert.equal(core.isValidRpcResult(invalidData, args), false);
    const preserved = core.draftAfterFailure(locked, new Error('resultado incerto'));
    assert.equal(preserved.retry_locked, true);
    assert.equal(preserved.chave_operacao, operationKey);
    assert.deepEqual(preserved.pending_args, args);
  }

  const validationPosition = uiSource.indexOf('EntradaEstoqueCore.isValidRpcResult(data, args)');
  const reloadPosition = uiSource.indexOf('loadProducts({ throwOnError: true })');
  const cleanupPosition = uiSource.indexOf('sessionStorage.removeItem(ENTRADA_ESTOQUE_STORAGE_KEY)', validationPosition);
  assert.ok(validationPosition >= 0 && reloadPosition > validationPosition && cleanupPosition > validationPosition);
  assert.match(uiSource, /resposta inesperada\. O resultado da operação é incerto/);
});

test('novo fluxo usa somente a RPC local e conteúdo dinâmico seguro', () => {
  assert.match(uiSource, /sb\.rpc\('registrar_entrada_estoque', params\)/);
  assert.doesNotMatch(uiSource, /\.from\s*\(/);
  assert.doesNotMatch(uiSource, /\bfetch\s*\(|\.insert\s*\(|\.update\s*\(/);
  assert.doesNotMatch(uiSource, /functions\.invoke|nuvemshop|csv|pre[cç]o|price|cat[aá]logo|oauth/i);
  assert.doesNotMatch(uiSource, /innerHTML|insertAdjacentHTML|outerHTML/);
  assert.match(uiSource, /\.textContent\s*=/);
  assert.match(uiSource, /sessionStorage/);
  assert.doesNotMatch(uiSource, /\bproduct\.quantidade(?:_110v|_220v)?\s*=/);
  assert.match(adminHtml, />Registrar entrada</);
  assert.match(adminHtml, /css\/admin\.css\?v=20260821-entrada-estoque-1/);
  assert.match(adminHtml, /js\/admin\.js\?v=20260821-entrada-estoque-1/);
  assert.match(adminHtml, /id="entrada-estoque-confirm"/);
  assert.match(adminHtml, /id="entrada-estoque-feedback" role="alert" aria-live="assertive"/);

  const callPosition = uiSource.indexOf("sb.rpc('registrar_entrada_estoque'");
  const reloadPosition = uiSource.indexOf('loadProducts({ throwOnError: true })');
  assert.ok(callPosition >= 0 && reloadPosition > callPosition, 'estoque visual deve ser recarregado somente após a RPC');
});

test('migration protege tipos, auditoria, idempotência e permissões', () => {
  assert.equal((migrationSource.match(/^begin;\r?$/gim) || []).length, 1);
  assert.equal((migrationSource.match(/^commit;\r?$/gim) || []).length, 1);
  assert.match(migrationSource, /create table public\.estoque_operacoes/i);
  assert.match(migrationSource, /create table public\.estoque_operacao_itens/i);
  assert.match(migrationSource, /check \(tipo = 'entrada'\)/i);
  assert.match(migrationSource, /enable row level security/gi);
  assert.match(migrationSource, /jsonb_typeof\(raw\.item->'produto_id'\) <> 'number'/);
  assert.match(migrationSource, /jsonb_typeof\(raw\.item->'quantidade'\) <> 'number'/);
  assert.match(migrationSource, /security definer\s+set search_path = public, pg_temp/i);
  assert.match(migrationSource, /pg_advisory_xact_lock/);
  assert.match(migrationSource, /for update/i);
  assert.match(migrationSource, /payload_normalizado is distinct from v_payload_normalizado/i);
  assert.match(migrationSource, /before update or delete on public\.estoque_operacoes/i);
  assert.match(migrationSource, /before update or delete on public\.estoque_operacao_itens/i);
  assert.match(migrationSource, /revoke all on function public\.registrar_entrada_estoque[\s\S]*from public, anon, authenticated/i);
  assert.match(migrationSource, /grant execute on function public\.registrar_entrada_estoque[\s\S]*to authenticated/i);
});

test('migration rejeita destino nulo para produto com voltagem', async () => {
  assert.match(
    migrationSource,
    /if v_produto\.tem_voltagem then\s+if v_item\.voltagem is null\s+or v_item\.voltagem not in \('110v', '220v'\) then/i
  );
  assert.match(
    migrationSource,
    /else\s+if v_item\.voltagem is not null then\s+raise exception 'Produto sem voltagem deve usar o estoque simples:/i
  );

  const mock = createMockRegistrar(products);
  await assert.rejects(
    mock.register({
      p_chave_operacao: operationKey,
      p_motivo: 'Entrada sem destino',
      p_data_movimento: today,
      p_itens: [{ produto_id: 2, quantidade: 1, voltagem: null }]
    }),
    /voltagem invalida/
  );
  assert.equal(mock.state.get(2).quantidade, 93);
  assert.equal(mock.state.get(2).quantidade_110v, 3);
  assert.equal(mock.state.get(2).quantidade_220v, 4);
  assert.equal(mock.operations.size, 0);
});

test('histórico distingue entrada de mercadoria de contagem e baixa', () => {
  const rowTypeSource = adminSource.match(/function historyRowType\(row\) \{[\s\S]*?\n\}/)?.[0] || '';
  const labelSource = adminSource.match(/function historyTypeLabel\(row\) \{[\s\S]*?\n\}/)?.[0] || '';
  const context = {
    isBaixaTipo: tipo => String(tipo || '').startsWith('baixa')
  };
  vm.createContext(context);
  vm.runInContext(`${rowTypeSource}\n${labelSource}\nthis.rowType = historyRowType; this.typeLabel = historyTypeLabel;`, context);

  assert.equal(context.rowType({ tipo: 'entrada_mercadoria' }), 'entrada_mercadoria');
  assert.equal(context.rowType({ tipo: 'contagem' }), 'entrada');
  assert.equal(context.rowType({ tipo: 'baixa_csv_produto' }), 'csv');
  assert.equal(context.typeLabel({ tipo: 'entrada_mercadoria' }), 'Entrada de mercadoria');
  assert.match(adminHtml, /option value="entrada_mercadoria">Entradas de mercadoria/);
  assert.match(adminHtml, /option value="entrada">Contagens \/ outras entradas/);
  assert.match(adminSource, /historyTypeLabel\(row\)/);
  assert.match(adminSource, /history-type-tag entrada/);
});

test('RPC SQL altera apenas o saldo alvo e não toca legado, outra integração, CSV ou preço', () => {
  const rpc = migrationSource.match(/create or replace function public\.registrar_entrada_estoque[\s\S]*?revoke all on function public\.registrar_entrada_estoque/i)?.[0] || '';
  assert.match(rpc, /set quantidade_110v = v_quantidade_nova::integer/);
  assert.match(rpc, /set quantidade_220v = v_quantidade_nova::integer/);
  assert.match(rpc, /set quantidade = v_quantidade_nova::integer/);
  assert.doesNotMatch(rpc, /ultima_baixa|nuvemshop|baixas_csv|preco|codigo_|sku/i);

  const mock = createMockRegistrar(products);
  return mock.register({
    p_chave_operacao: operationKey,
    p_motivo: 'Entrada 110V',
    p_data_movimento: today,
    p_itens: [{ produto_id: 2, quantidade: 5, voltagem: '110v' }]
  }).then(() => {
    const product = mock.state.get(2);
    assert.equal(product.quantidade_110v, 8);
    assert.equal(product.quantidade_220v, 4);
    assert.equal(product.quantidade, 93);
    assert.equal(product.preco, 900);
    assert.equal(product.sku, 'SKU-PRENSA');
  });
});
