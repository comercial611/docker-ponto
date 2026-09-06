import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
// Execute the actual handlers and helpers. No SDK, bootstrap or network is loaded.
const functions = ['saveProduct', 'editProduct', 'clearForm', 'cancelEdit', 'loadProducts',
  'subscribeRealtime', 'inputText', 'formatVoltageCodes', 'extractVoltageCode',
  'toggleVoltagem', 'setProductStockFormMode', 'isValidSupplierStatus'];
const actualCode = functions.map(name => {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(start, `handler ${name}`);
  const tail = source.slice(start.index);
  const firstLine = tail.split('\n')[0];
  if (firstLine.trimEnd().endsWith('}')) return firstLine;
  const end = /^\}/m.exec(tail);
  assert.ok(end, `end ${name}`);
  return tail.slice(0, end.index + 1);
}).join('\n');
const clone = value => JSON.parse(JSON.stringify(value));
const stockKeys = ['quantidade', 'quantidade_110v', 'quantidade_220v'];
const stock = p => Object.fromEntries(stockKeys.map(key => [key, p[key]]));
const product = (voltage = false) => ({
  id: 900001, nome: 'Produto fictício', ativo: true, categoria: 'produto',
  tem_voltagem: voltage, quantidade: voltage ? 91 : 30,
  quantidade_110v: voltage ? 30 : 92, quantidade_220v: voltage ? 50 : 93,
  minimo: 3, tags: [], fornecedor_status: 'normal', observacoes: 'Observação antiga',
  codigo_interno: 'AUD-001', sku: 'AUD-BAR-001'
});

function harness(initial = product()) {
  let db = clone(initial);
  const writes = [], alerts = [], messages = [], subscriptions = [];
  const noop = () => {};
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map(m => {
    let value = '';
    return [m[1], {
      get value() { return value; }, set value(v) { value = String(v); },
      checked: false, readOnly: false, disabled: false, hidden: false, style: {}, textContent: '',
      focus: noop, classList: { toggle: noop, add: noop, remove: noop, contains: () => false }
    }];
  }));
  const el = id => { assert.ok(elements.has(id), `HTML ID ${id}`); return elements.get(id); };
  const networkBlocked = () => { throw new Error('External network forbidden in cadastro tests'); };
  const context = vm.createContext({
    productEditContext: null, productTags: [], products: [clone(initial)], productsSnapshot: {}, entradaEstoqueDraft: null,
    SUPPLIER_STATUS_CONFIG: { normal: {}, atencao: {}, em_falta: {} },
    document: { getElementById: el, querySelectorAll: () => [] },
    fetch: networkBlocked, XMLHttpRequest: networkBlocked, WebSocket: networkBlocked,
    EventSource: networkBlocked, navigator: { sendBeacon: networkBlocked },
    alert: msg => alerts.push(msg), console: { error: noop },
    resetFuturaImportHelper: noop, setFuturaFeedback: noop, setProductTags: noop,
    previewImg: noop, switchTab: noop, showSuccess: msg => messages.push(msg),
    snapshotProducts: () => ({}), detectStockChanges: noop, renderDashTable: noop,
    renderProdTable: noop, updateStats: noop, renderDashboardResolverToday: noop, renderEntradaEstoqueItems: noop,
    sb: {
      from(table) {
        assert.equal(table, 'produtos', 'no other writes, history or ledger');
        return {
          update(payload) {
            // Check the object itself BEFORE serialization (undefined keys also fail).
            for (const key of [...stockKeys, 'tem_voltagem']) assert.equal(Object.hasOwn(payload, key), false, `UPDATE must omit ${key}`);
            const body = clone(payload);
            return { eq(column, id) {
              assert.equal(column, 'id'); assert.equal(String(id), String(db.id));
              writes.push({ method: 'update', body, id });
              if (context.saveError) return Promise.resolve({ error: { message: 'Erro simulado' } });
              db = { ...db, ...body };
              return Promise.resolve({ error: null });
            }};
          },
          insert(payload) {
            writes.push({ method: 'insert', body: clone(payload) });
            db = { id: 900002, ...clone(payload) };
            return Promise.resolve({ error: null });
          },
          select() { return { order() { return Promise.resolve({ data: [clone(db)], error: null }); } }; }
        };
      },
      rpc() { throw new Error('No stock RPC allowed during cadastro save'); },
      channel() { const ch = { on(event, filter, callback) { subscriptions.push({ filter, callback }); return ch; }, subscribe: noop }; return ch; }
    }
  }, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(actualCode, context, { timeout: 2000 });
  const run = command => vm.runInContext(command, context, { timeout: 2000 });
  return { el, writes, alerts, messages, context, run,
    get db() { return clone(db); },
    open: () => run('editProduct(900001)'), save: () => run('saveProduct()'),
    concurrent: changes => { db = { ...db, ...changes }; },
    realtime: async () => {
      run('subscribeRealtime()');
      await subscriptions.find(s => s.filter.table === 'produtos').callback({ eventType: 'UPDATE', new: {} });
    }
  };
}

for (const [name, changes, field] of [
  ['baixa 30 → 28 e nome', { quantidade: 28 }, 'p-nome'],
  ['entrada 30 → 35 e observação', { quantidade: 35 }, 'p-obs']
]) test(name, async () => {
  const h = harness(); h.open(); h.concurrent(changes); const before = stock(h.db);
  h.el(field).value = 'Cadastro alterado'; await h.save();
  assert.deepEqual(stock(h.db), before);
  assert.equal(h.writes.length, 1); assert.equal(h.writes[0].method, 'update');
  assert.equal(h.db[field === 'p-nome' ? 'nome' : 'observacoes'], 'Cadastro alterado');
  assert.equal(h.alerts.length, 0); assert.equal(h.messages.length, 1);
});

test('Realtime atualiza a lista e mantém saldo de consulta como retrato ao abrir', async () => {
  const h = harness(); h.open(); h.concurrent({ quantidade: 28 }); await h.realtime();
  assert.equal(h.context.products[0].quantidade, 28); assert.equal(h.el('p-qty').value, '30');
  assert.equal(h.el('p-qty').readOnly, true); await h.save(); assert.equal(h.db.quantidade, 28);
});

for (const [name, changes, field] of [
  ['nome com duas baixas', { quantidade_110v: 28, quantidade_220v: 47 }, 'p-nome'],
  ['código 110 preserva 220', { quantidade_220v: 47 }, 'p-cod-fab-110'],
  ['código 220 preserva 110', { quantidade_110v: 28 }, 'p-cod-fab-220']
]) test(name, async () => {
  const h = harness(product(true)); h.open(); h.concurrent(changes); const before = stock(h.db);
  h.el(field).value = 'AUD-NOVO'; await h.save(); assert.deepEqual(stock(h.db), before);
  assert.equal(h.writes.length, 1); assert.equal(h.alerts.length, 0);
});

test('edição não lê/valida saldos, mesmo manipulados, inválidos ou desabilitados', async () => {
  const h = harness(); h.open();
  for (const id of ['p-qty', 'p-qty-110', 'p-qty-220']) {
    h.el(id).disabled = true;
    Object.defineProperty(h.el(id), 'value', { get() { throw new Error('Saldo de edição não pode ser lido'); }, set() {} });
  }
  await h.save(); assert.deepEqual(stock(h.db), stock(product())); assert.equal(h.writes.length, 1);
});

test('campos legados não usados não são zerados por edição', async () => {
  for (const voltage of [false, true]) {
    const h = harness(product(voltage)); h.open(); await h.save();
    assert.deepEqual(stock(h.db), stock(product(voltage)));
  }
});

for (const voltage of [false, true]) test(`criação ${voltage ? '110/220V' : 'simples'} mantém saldo inicial`, async () => {
  const h = harness(); h.run('clearForm()');
  h.el('p-nome').value = 'Produto novo'; h.el('p-tem-voltagem').checked = voltage;
  h.el('p-qty').value = '7'; h.el('p-qty-110').value = '9'; h.el('p-qty-220').value = '11';
  await h.save(); assert.equal(h.writes[0].method, 'insert');
  assert.deepEqual(stock(h.db), voltage ? { quantidade: 0, quantidade_110v: 9, quantidade_220v: 11 } : { quantidade: 7, quantidade_110v: 0, quantidade_220v: 0 });
  assert.equal(h.db.tem_voltagem, voltage);
});

test('criação com quantidade vazia mantém regra inicial zero', async () => {
  const h = harness(); h.run('clearForm()'); h.el('p-nome').value = 'Produto novo'; await h.save();
  assert.deepEqual(stock(h.db), { quantidade: 0, quantidade_110v: 0, quantidade_220v: 0 });
});

for (const voltage of [false, true]) test(`conversão ${voltage ? 'variante → simples' : 'simples → variante'} bloqueada pelo save`, async () => {
  const h = harness(product(voltage)); h.open();
  h.el('p-tem-voltagem').disabled = false; h.el('p-tem-voltagem').checked = !voltage;
  await h.save(); assert.equal(h.writes.length, 0); assert.match(h.alerts[0], /tipo de estoque/);
  assert.deepEqual(h.db, product(voltage));
});

test('toggle manipulado restaura tipo original sem converter', () => {
  const h = harness(); h.open(); h.el('p-tem-voltagem').checked = true;
  h.run("toggleVoltagem({ target: document.getElementById('p-tem-voltagem') })");
  assert.equal(h.el('p-tem-voltagem').checked, false); assert.equal(h.writes.length, 0);
});

test('mudança remota de tipo durante edição exige reabertura', async () => {
  const h = harness(); h.open(); h.concurrent({ tem_voltagem: true }); await h.realtime();
  await h.save(); assert.equal(h.writes.length, 0); assert.match(h.alerts[0], /tipo de estoque/);
});

for (const id of ['', '900002']) test(`ID manipulado (${id || 'vazio'}) não vira criação nem outro produto`, async () => {
  const h = harness(); h.open(); h.el('p-edit-id').value = id; await h.save();
  assert.equal(h.writes.length, 0); assert.match(h.alerts[0], /edição inválido/);
});

test('ID sem contexto de edição não permite UPDATE', async () => {
  const h = harness(); h.el('p-edit-id').value = '900001'; await h.save(); assert.equal(h.writes.length, 0);
});

test('cancelar e salvar restauram controles de criação', async () => {
  const h = harness(product(true)); h.open();
  assert.equal(h.el('p-tem-voltagem').disabled, true); assert.equal(h.el('p-stock-edit-note').hidden, false);
  for (const id of ['p-qty', 'p-qty-110', 'p-qty-220']) assert.equal(h.el(id).readOnly, true);
  h.run('cancelEdit()');
  assert.equal(h.el('p-tem-voltagem').disabled, false); assert.equal(h.el('p-stock-edit-note').hidden, true);
  for (const id of ['p-qty', 'p-qty-110', 'p-qty-220']) assert.equal(h.el(id).readOnly, false);
  h.open(); await h.save(); assert.equal(h.el('p-edit-id').value, ''); assert.equal(h.context.productEditContext, null);
});

test('erro de salvamento preserva cadastro e bloqueio de tipo para tentar novamente', async () => {
  const h = harness(); h.open(); h.context.saveError = true; h.el('p-nome').value = 'Alterado';
  await h.save(); assert.equal(h.el('p-edit-id').value, '900001'); assert.equal(h.el('p-nome').value, 'Alterado');
  assert.equal(h.el('p-tem-voltagem').disabled, true); assert.equal(h.messages.length, 0);
  assert.deepEqual(h.db, product()); assert.match(h.alerts[0], /Erro simulado/);
});

test('dados cadastrais, mínimo e limpeza de fabricante continuam editáveis', async () => {
  const h = harness({ ...product(true), codigo_fabricante: 'AUD110 (110V) - AUD220 (220V)' });
  h.open(); h.el('p-cod-fab-110').value = ''; h.el('p-cod-fab-220').value = '';
  h.el('p-min-volt').value = '8'; h.el('p-obs').value = 'Observação alterada';
  await h.save(); assert.equal(h.db.codigo_fabricante, null); assert.equal(h.db.codigo_fabricante_110v, null);
  assert.equal(h.db.codigo_fabricante_220v, null); assert.equal(h.db.minimo, 8);
  assert.equal(h.db.observacoes, 'Observação alterada'); assert.deepEqual(stock(h.db), stock(product(true)));
});
