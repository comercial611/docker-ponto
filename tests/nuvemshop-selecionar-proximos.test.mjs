import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const adminSource = readFileSync(new URL('../js/admin.js', import.meta.url), 'utf8');
const adminHtml = readFileSync(new URL('../admin.html', import.meta.url), 'utf8');
const functionSource = readFileSync(
  new URL('../supabase/functions/nuvemshop-sincronizacao/index.ts', import.meta.url),
  'utf8'
);
const migrationSource = readFileSync(
  new URL('../supabase/26-ampliar-lote-nuvemshop-15-itens.sql', import.meta.url),
  'utf8'
);

function markedSection(source, name) {
  const match = source.match(new RegExp(`// BEGIN ${name}([\\s\\S]*?)// END ${name}`));
  assert.ok(match, `seção ${name} não encontrada`);
  return match[1];
}

const coreContext = {};
vm.createContext(coreContext);
vm.runInContext(
  `${markedSection(adminSource, 'NUVEMSHOP_BATCH_SELECTION_CORE')}\nthis.core = NuvemshopBatchSelectionCore;`,
  coreContext
);
const core = coreContext.core;

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function eligibleItem(id, overrides = {}) {
  return {
    auditoria_item_id: id,
    vinculo_id: 1000 + id,
    status: 'alteraria',
    ...overrides
  };
}

function eligibleItems(total) {
  return Array.from({ length: total }, (_, index) => eligibleItem(index + 1));
}

test('seleciona os primeiros 15 entre mais de 15 elegíveis', () => {
  const result = plain(core.selectNext([], eligibleItems(40), 15));
  assert.deepEqual(result.selectedIds, Array.from({ length: 15 }, (_, index) => index + 1));
  assert.deepEqual(result.addedIds, result.selectedIds);
  assert.equal(result.selectedCount, 15);
  assert.equal(result.eligibleRemaining, 25);
  assert.equal(result.requiresIndividual, false);
});

test('completa uma seleção parcial sem ultrapassar 15', () => {
  const result = plain(core.selectNext([1, 2, 3, 4, 5, 6, 7], eligibleItems(40), 15));
  assert.deepEqual(result.selectedIds, Array.from({ length: 15 }, (_, index) => index + 1));
  assert.deepEqual(result.addedIds, [8, 9, 10, 11, 12, 13, 14, 15]);
  assert.equal(result.selectedCount, 15);
});

test('seleção cheia permanece intacta e nunca ultrapassa o máximo', () => {
  const selected = Array.from({ length: 15 }, (_, index) => index + 1);
  const result = plain(core.selectNext(selected, eligibleItems(40), 15));
  assert.deepEqual(result.selectedIds, selected);
  assert.deepEqual(result.addedIds, []);
  assert.equal(result.selectedCount, 15);
  assert.equal(core.canSelectNext(selected, eligibleItems(40), 15), false);
});

test('respeita exatamente o filtro e a ordem visual informados', () => {
  const items = [eligibleItem(1), eligibleItem(2), eligibleItem(3), eligibleItem(4)];
  const visibleLinkIds = [1004, 1002];
  const ordered = plain(core.orderedEligibleItems(items, visibleLinkIds));
  const result = plain(core.selectNext([], ordered, 15));
  assert.deepEqual(ordered.map(item => item.auditoria_item_id), [4, 2]);
  assert.deepEqual(result.selectedIds, [4, 2]);
});

test('ignora inelegíveis, aplicados, incertos, desabilitados e duplicados', () => {
  const items = [
    eligibleItem(1),
    eligibleItem(1, { vinculo_id: 1002 }),
    eligibleItem(3, { vinculo_id: 1001 }),
    eligibleItem(4, { disabled: true }),
    eligibleItem(5, { aplicado: true }),
    eligibleItem(6, { incerto: true }),
    eligibleItem(7, { resultado: 'concluido' }),
    eligibleItem(8, { status: 'igual' }),
    eligibleItem(9)
  ];
  const ordered = plain(core.orderedEligibleItems(
    items,
    [1002, 1001, 1003, 1004, 1005, 1006, 1007, 1008, 1009]
  ));
  assert.deepEqual(ordered.map(item => item.auditoria_item_id), [1, 9]);
});

test('seleciona todos quando há menos de 15 itens elegíveis', () => {
  const result = plain(core.selectNext([], eligibleItems(6), 15));
  assert.deepEqual(result.selectedIds, [1, 2, 3, 4, 5, 6]);
  assert.equal(result.eligibleRemaining, 0);
});

test('um único elegível não cria lote inválido e orienta fluxo individual', () => {
  const result = plain(core.selectNext([], eligibleItems(1), 15));
  assert.deepEqual(result.selectedIds, []);
  assert.deepEqual(result.addedIds, []);
  assert.equal(result.requiresIndividual, true);
  assert.match(adminSource, /Há somente 1 item elegível neste filtro\. Use o fluxo individual “Verificar piloto”\./);
});

test('controle desabilita durante operações, no máximo e sem elegíveis adicionais', () => {
  assert.equal(core.canSelectNext([], eligibleItems(6), 15, true), false);
  assert.equal(core.canSelectNext(Array.from({ length: 15 }, (_, index) => index + 1), eligibleItems(20), 15), false);
  assert.equal(core.canSelectNext([1, 2], eligibleItems(2), 15), false);
  assert.equal(core.canSelectNext([], eligibleItems(1), 15), true);
  assert.match(
    adminSource,
    /const busy = nuvemshopPilotVerifying \|\|[\s\S]*nuvemshopPilotApplying \|\|[\s\S]*nuvemshopPilotWindowBusy/
  );
});

test('ação de seleção apenas altera caixas locais, sem verificação ou escrita', () => {
  const match = adminSource.match(
    /function selectNextNuvemshopBatchItems\(\) \{([\s\S]*?)\r?\n\}\r?\n\r?\nfunction renderNuvemshopPilotApplication/
  );
  assert.ok(match, 'ação Selecionar próximos 15 deve existir');
  assert.doesNotMatch(
    match[1],
    /\bsb\b|functions\.invoke|\.rpc\s*\(|\bfetch\s*\(|sessionStorage|localStorage|runNuvemshopPilot(?:Readiness|Window|Application)\s*\(/
  );
  assert.match(match[1], /nuvemshopBatchSelectedItemIds = selection\.selectedIds/);
});

test('interface expõe botão, contador acessível e cache atualizado', () => {
  assert.match(adminHtml, /id="nuvemshop-batch-select-next"[^>]*>Selecionar próximos 15<\/button>/);
  assert.match(adminHtml, /id="nuvemshop-batch-selection-count"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(adminSource, /selecionados de \$\{NUVEMSHOP_BATCH_MAX_ITEMS\} · \$\{summary\.eligibleRemaining\} elegíveis restantes/);
  assert.match(adminHtml, /css\/admin\.css\?v=20260831-selecionar-15-1/);
  assert.match(adminHtml, /js\/admin\.js\?v=20260901-futura-xls-2/);
});

test('limites mínimo 2 e máximo 15 permanecem no frontend, Function e migration', () => {
  assert.match(adminSource, /const NUVEMSHOP_BATCH_MAX_ITEMS = 15;/);
  assert.match(functionSource, /const BATCH_MAX_ITEMS = 15;/);
  assert.match(functionSource, /batchSize < 2[\s\S]*batchSize > BATCH_MAX_ITEMS/);
  assert.match(migrationSource, /p_limite not between 2 and 15/);
  assert.match(migrationSource, /v_total not between 2 and 15/);
  assert.match(migrationSource, /total_itens not between 2 and 15/);
});

test('fluxos existentes de verificação, janela e aplicação continuam presentes', () => {
  for (const mode of ['verificar_lote', 'habilitar_lote', 'aplicar_lote']) {
    assert.ok(adminSource.includes(`'${mode}'`), `Admin deve preservar ${mode}`);
    assert.ok(functionSource.includes(`"${mode}"`), `Function deve preservar ${mode}`);
  }
  assert.match(adminHtml, /id="nuvemshop-pilot-run"[^>]*runNuvemshopPilotReadiness\(\)/);
  assert.match(adminHtml, /id="nuvemshop-pilot-apply"[^>]*runNuvemshopPilotApplication\(\)/);
  assert.match(adminSource, /APLICAR LOTE DE \$\{total\} ITENS/);
  assert.match(adminSource, /LIBERAR LOTE DE \$\{total\} ITENS POR 5 MINUTOS/);
});

function extractFunctionBetween(source, startName, nextName) {
  const match = source.match(new RegExp(
    `(?:async\\s+)?function ${startName}\\(\\)[\\s\\S]*?\\r?\\n\\}\\r?\\n\\r?\\n(?:async\\s+)?function ${nextName}`
  ));
  assert.ok(match, `função ${startName} não encontrada`);
  return match[0].replace(new RegExp(`\\r?\\n\\r?\\n(?:async\\s+)?function ${nextName}[\\s\\S]*$`), '');
}

function mockElement(id) {
  return {
    id,
    value: '',
    placeholder: '',
    textContent: '',
    innerHTML: '',
    className: '',
    disabled: false,
    classList: {
      add(...names) {
        this.owner.className = [...new Set(`${this.owner.className} ${names.join(' ')}`.trim().split(/\s+/))].join(' ');
      },
      owner: null
    }
  };
}

test('re-render pós-verificação reabilita elegíveis, preserva seleção e mantém inelegíveis fora', () => {
  const renderSource = extractFunctionBetween(
    adminSource,
    'renderNuvemshopPilotApplication',
    'selectNuvemshopPilotItem'
  );
  const renderItems = [
    eligibleItem(1),
    eligibleItem(2),
    eligibleItem(3, { status: 'igual' })
  ];
  const ids = [
    'nuvemshop-pilot-application',
    'nuvemshop-pilot-items',
    'nuvemshop-pilot-confirmation',
    'nuvemshop-pilot-application-note',
    'nuvemshop-pilot-application-result',
    'nuvemshop-batch-selection-tools',
    'nuvemshop-batch-select-next',
    'nuvemshop-batch-selection-count',
    'nuvemshop-pilot-result',
    'nuvemshop-pilot-window',
    'nuvemshop-pilot-window-confirmation',
    'nuvemshop-pilot-error'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, mockElement(id)]));
  for (const element of Object.values(elements)) element.classList.owner = element;
  const renderContext = {
    NuvemshopBatchSelectionCore: core,
    renderItems,
    elements,
    document: { getElementById(id) { return this.elements[id]; }, elements },
    nuvemshopServerSimulation: {},
    nuvemshopPilotMode: 'batch',
    nuvemshopPilotReadiness: null,
    nuvemshopPilotSelectedItemId: null,
    nuvemshopBatchSelectedItemIds: [1, 2],
    nuvemshopPilotVerifying: true,
    nuvemshopPilotApplying: false,
    nuvemshopPilotWindowBusy: false,
    nuvemshopPilotApplicationLocked: false,
    NUVEMSHOP_BATCH_MAX_ITEMS: 15,
    isNuvemshopBatchMode() { return true; },
    nuvemshopPilotCandidates: () => renderItems.filter(item => core.isEligibleItem(item)),
    selectedNuvemshopApplicationItemIds: () => [...renderContext.nuvemshopBatchSelectedItemIds],
    expectedNuvemshopApplicationConfirmation() { return 'APLICAR LOTE DE 2 ITENS'; },
    validUnitsPerSale() { return 1; },
    escapeHtml(value) { return String(value); },
    updateNuvemshopBatchSelectionControls() {},
    updateNuvemshopPilotApplyButton() {}
  };
  vm.createContext(renderContext);
  vm.runInContext(`${renderSource}\nthis.renderFn = renderNuvemshopPilotApplication;`, renderContext);
  vm.runInContext('renderFn();', renderContext);
  assert.match(renderContext.elements['nuvemshop-pilot-items'].innerHTML, /class="nuvemshop-pilot-item selected"[^>]*disabled/);
  assert.doesNotMatch(renderContext.elements['nuvemshop-pilot-items'].innerHTML, /Item auditado 3/);

  renderContext.nuvemshopPilotVerifying = false;
  vm.runInContext('renderFn();', renderContext);
  const html = renderContext.elements['nuvemshop-pilot-items'].innerHTML;
  assert.doesNotMatch(html, /nuvemshop-pilot-item selected"[^>]*disabled/);
  assert.equal((html.match(/checked/g) || []).length, 2, 'os dois itens já selecionados permanecem marcados');
  assert.doesNotMatch(html, /Item auditado 3/);
  assert.doesNotMatch(renderSource, /\bsb\b|functions\.invoke|\.rpc\s*\(|\bfetch\s*\(/);
});

test('finally re-renderiza após sucesso e erro sem nova chamada externa ou perda da seleção', async () => {
  const readinessSource = extractFunctionBetween(
    adminSource,
    'runNuvemshopPilotReadiness',
    'runNuvemshopPilotApplication'
  );
  const runContext = {
    console: { error() {} },
    pendingResponse: null,
    runState: { invokeCount: 0, renderStates: [] },
    elements: {
      'nuvemshop-pilot-run': { disabled: false, textContent: '' },
      'nuvemshop-pilot-error': { textContent: '' }
    },
    nuvemshopStoreId: 123,
    nuvemshopServerSimulation: { auditoria_id: 'audit-offline' },
    nuvemshopPilotMode: 'batch',
    nuvemshopPilotReadiness: null,
    nuvemshopBatchSelectedItemIds: [11, 12],
    nuvemshopPilotVerifying: false,
    nuvemshopPilotApplying: false,
    NUVEMSHOP_BATCH_MAX_ITEMS: 15,
    isNuvemshopBatchMode: () => true,
    selectedNuvemshopApplicationItemIds: () => [...runContext.nuvemshopBatchSelectedItemIds],
    updateNuvemshopBatchSelectionControls() {},
    renderNuvemshopPilotReadiness() {},
    renderNuvemshopPilotApplication: () => runContext.runState.renderStates.push(runContext.nuvemshopPilotVerifying),
    showToast: () => {},
    document: { getElementById(id) { return this.elements[id]; }, elements: null },
    sb: {
      functions: {
        async invoke() {
          runContext.runState.invokeCount += 1;
          return runContext.pendingResponse;
        }
      }
    }
  };
  runContext.document.elements = runContext.elements;
  vm.createContext(runContext);
  vm.runInContext(`${readinessSource}\nthis.runReadiness = runNuvemshopPilotReadiness;\nthis.readSelection = () => [...nuvemshopBatchSelectedItemIds];`, runContext);

  runContext.pendingResponse = {
    data: { modo: 'verificacao_lote', escrita_executada: false },
    error: null
  };
  await vm.runInContext('(async () => runReadiness())()', runContext);
  assert.deepEqual(runContext.runState.renderStates, [true, false]);
  assert.deepEqual([...runContext.readSelection()], [11, 12]);
  assert.equal(runContext.runState.invokeCount, 1);

  runContext.runState.renderStates = [];
  runContext.runState.invokeCount = 0;
  runContext.pendingResponse = { data: null, error: new Error('falha de rede') };
  await vm.runInContext('(async () => runReadiness())()', runContext);
  assert.deepEqual(runContext.runState.renderStates, [false], 'erro também reabilita a lista no finally');
  assert.deepEqual([...runContext.readSelection()], [11, 12]);
  assert.equal(runContext.runState.invokeCount, 1, 're-renderização não chama a Function novamente');
  assert.equal(runContext.nuvemshopPilotVerifying, false);
});
