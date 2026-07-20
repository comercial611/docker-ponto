let products = [];
let historyRows = [];
let csvLots = [];
let attentionLists = {};
let activePriority = 'urgent';
let selectedPurchaseIds = new Set();
let visiblePurchaseIds = [];

async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await enterReportsArea();
}

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
  }
});

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-pass').value;
  document.getElementById('login-error').textContent = '';

  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    document.getElementById('login-error').textContent = 'E-mail ou senha incorretos.';
    return;
  }

  await enterReportsArea();
}

async function doLogout() {
  await sb.auth.signOut();
}

async function enterReportsArea() {
  const { data: tipo, error } = await sb.rpc('usuario_tipo');
  if (error || tipo !== 'admin') {
    await sb.auth.signOut();
    document.getElementById('login-error').textContent = 'Acesso permitido apenas para administradores.';
    return false;
  }

  showApp();
  await loadData();
  return true;
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
}

async function loadData() {
  setLoadingState();

  const [productsRes, historyRes, csvRes] = await Promise.all([
    sb.from('produtos').select('*').order('nome'),
    sb.from('historico').select('*, produtos(id,nome,imagem_url,categoria)').order('created_at', { ascending: false }).limit(500),
    sb.from('baixas_csv_lotes').select('*, baixas_csv_itens(*)').order('created_at', { ascending: false }).limit(12)
  ]);

  products = productsRes.data || [];
  historyRows = historyRes.data || [];
  csvLots = csvRes.data || [];

  if (productsRes.error) showLoadError(productsRes.error.message);
  if (historyRes.error) historyRows = [];
  if (csvRes.error) csvLots = [];

  renderAll();
  updateTimestamp();
}

function setLoadingState() {
  ['stat-baixo', 'stat-zerado', 'stat-sugerido', 'stat-saude'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = '-';
  });
  ['machine-stat-total', 'machine-stat-units', 'machine-stat-low', 'machine-stat-out', 'machine-stat-sales'].forEach(id => {
    document.getElementById(id).textContent = '-';
  });
  document.getElementById('purchase-tbody').innerHTML = '<tr><td colspan="8" class="empty-state">Carregando relatório...</td></tr>';
  document.getElementById('top-products-list').innerHTML = '<div class="empty-state">Carregando...</div>';
  document.getElementById('attention-grid').innerHTML = '';
  document.getElementById('machine-purchase-tbody').innerHTML = '<tr><td colspan="8" class="empty-state">Carregando relatorio...</td></tr>';
  document.getElementById('top-machines-list').innerHTML = '<div class="empty-state">Carregando...</div>';
  document.getElementById('machine-sales-list').innerHTML = '<div class="empty-state">Carregando...</div>';
  document.getElementById('machine-attention-grid').innerHTML = '';
}

function showLoadError(message) {
  document.getElementById('purchase-tbody').innerHTML = `<tr><td colspan="8" class="empty-state">${escapeHtml(message)}</td></tr>`;
}

function renderAll() {
  populateCategoryFilter();
  renderStats();
  renderPurchaseSuggestions();
  renderTopProducts();
  renderAttention();
  renderMachineReport();
}

function switchReportTab(tab, navKey = tab === 'maquinas' ? 'machines' : 'products') {
  ['produtos', 'maquinas'].forEach(name => {
    const active = name === tab;
    const tabButton = document.getElementById(`report-tab-${name}`);
    tabButton.classList.toggle('active', active);
    tabButton.setAttribute('aria-selected', String(active));
    document.getElementById(`report-panel-${name}`).classList.toggle('active', active);
  });
  setActiveSideNav(navKey);
}

function setActiveSideNav(navKey) {
  document.querySelectorAll('[data-report-nav]').forEach(item => {
    const active = item.dataset.reportNav === navKey;
    item.classList.toggle('active', active);
    if (active) item.setAttribute('aria-current', 'page'); else item.removeAttribute('aria-current');
  });
}

function scrollToReportTarget(id) {
  const target = document.getElementById(id);
  if (!target) return;
  requestAnimationFrame(() => {
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target.focus({ preventScroll: true });
  });
}

function navigateReport(destination) {
  if (destination === 'machines') {
    switchReportTab('maquinas', 'machines');
    scrollToReportTarget('report-panel-maquinas');
  } else if (destination === 'imports') {
    switchReportTab('produtos', 'imports');
    scrollToReportTarget('csv-imports-section');
  } else if (destination === 'products') {
    switchReportTab('produtos', 'products');
    scrollToReportTarget('purchase-section');
  } else {
    switchReportTab('produtos', 'overview');
    scrollToReportTarget('reports-top');
  }
  toggleSidebar(false);
}

function populateCategoryFilter() {
  const select = document.getElementById('filter-category');
  if (!select) return;
  const current = select.value;
  const categories = [...new Set(products.filter(p => productCategory(p) === 'produto').map(p => String(p.categoria_nome || p.subcategoria || p.categoria || '').trim()).filter(Boolean))].sort();
  select.innerHTML = '<option value="all">Todas</option>' + categories.map(category => `<option value="${escapeHtml(category)}">${escapeHtml(category)}</option>`).join('');
  if ([...select.options].some(option => option.value === current)) select.value = current;
}

function getFilterState() {
  return {
    search: normalizeText(document.getElementById('filter-search')?.value),
    status: document.getElementById('filter-status')?.value || 'all',
    category: document.getElementById('filter-category')?.value || 'all',
    period: document.getElementById('filter-period')?.value || '30'
  };
}

function filteredProductItems() {
  const filters = getFilterState();
  return products.filter(product => {
    if (productCategory(product) !== 'produto') return false;
    const status = getStatus(product).cls;
    const searchable = normalizeText([product.nome, product.codigo_interno, product.codigo_referencia, product.sku].filter(Boolean).join(' '));
    const category = String(product.categoria_nome || product.subcategoria || product.categoria || '').trim();
    return (!filters.search || searchable.includes(filters.search))
      && (filters.status === 'all' || status === filters.status)
      && (filters.category === 'all' || category === filters.category);
  });
}

function applyFilters() {
  updateSalesPeriodLabel();
  renderPurchaseSuggestions();
  renderTopProducts();
}

function updateSalesPeriodLabel() {
  const period = document.getElementById('filter-period')?.value || '30';
  const label = document.getElementById('sales-period-label');
  if (label) label.textContent = period === 'all' ? 'Saída total' : `Saída ${period} dias`;
}

function clearFilters() {
  document.getElementById('filter-search').value = '';
  document.getElementById('filter-status').value = 'all';
  document.getElementById('filter-category').value = 'all';
  document.getElementById('filter-period').value = '30';
  applyFilters();
}

function setStatusFilter(status) {
  document.getElementById('filter-status').value = status;
  applyFilters();
  document.querySelector('.filter-panel')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setPriorityFilter(priority) {
  activePriority = priority;
  document.querySelectorAll('.priority-tab').forEach(button => button.classList.toggle('active', button.dataset.priority === priority));
  renderPurchaseSuggestions();
}

function focusPurchaseList() {
  setPriorityFilter('urgent');
  document.getElementById('purchase-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function productCategory(product) {
  return product.categoria || 'maquina';
}

function totalQty(product) {
  return product.tem_voltagem
    ? (Number(product.quantidade_110v) || 0) + (Number(product.quantidade_220v) || 0)
    : Number(product.quantidade) || 0;
}

function getVoltageIssues(product) {
  if (!product.tem_voltagem) return [];

  const issues = [];
  if ((Number(product.quantidade_110v) || 0) === 0) issues.push('110V');
  if ((Number(product.quantidade_220v) || 0) === 0) issues.push('220V');
  return issues;
}

function getStatus(product) {
  const qty = totalQty(product);
  const minimo = Number(product.minimo) || 0;
  if (qty === 0) return { cls: 'out', label: 'Sem estoque' };
  if (qty <= minimo) return { cls: 'low', label: 'Estoque baixo' };
  return { cls: 'ok', label: 'OK' };
}

function renderStats() {
  const productItems = products.filter(p => productCategory(p) === 'produto');
  const lowItems = productItems.filter(p => getStatus(p).cls === 'low');
  const outItems = productItems.filter(p => getStatus(p).cls === 'out');
  const suggested = [...lowItems, ...outItems].reduce((sum, product) => sum + Math.max((Number(product.minimo) || 0) - totalQty(product), 0), 0);
  const configured = productItems.filter(p => (Number(p.minimo) || 0) > 0);
  const healthy = configured.filter(p => getStatus(p).cls === 'ok').length;
  const health = configured.length ? Math.round((healthy / configured.length) * 100) : 100;
  document.getElementById('stat-baixo').textContent = lowItems.length;
  document.getElementById('stat-zerado').textContent = outItems.length;
  document.getElementById('stat-sugerido').textContent = formatNumber(suggested);
  document.getElementById('stat-saude').textContent = `${health}%`;
  document.getElementById('stat-saude-label').textContent = health >= 75 ? 'adequado' : health >= 50 ? 'atenção' : 'crítico';
}

function renderPurchaseSuggestions() {
  const candidateRows = filteredProductItems()
    .map(p => {
      const qty = totalQty(p);
      const minimo = Number(p.minimo) || 0;
      const sales = getProductSales(p.id, p.nome);
      return { product: p, qty, minimo, sales, suggested: Math.max(minimo - qty, sales > 0 ? Math.ceil(sales * .25) : 0), status: getStatus(p) };
    })
    .sort((a, b) => {
      if (a.status.cls !== b.status.cls) return a.status.cls === 'out' ? -1 : 1;
      return b.suggested - a.suggested;
    });

  const urgent = candidateRows.filter(item => item.status.cls === 'out');
  const soon = candidateRows.filter(item => item.status.cls === 'low');
  const monitor = candidateRows.filter(item => item.status.cls === 'ok');
  document.getElementById('urgent-count').textContent = urgent.length;
  document.getElementById('soon-count').textContent = soon.length;
  document.getElementById('monitor-count').textContent = monitor.length;
  const rows = activePriority === 'urgent' ? urgent : activePriority === 'soon' ? soon : monitor;
  visiblePurchaseIds = rows.map(item => purchaseSelectionId(item.product.id));
  const selectedVisible = visiblePurchaseIds.filter(id => selectedPurchaseIds.has(id)).length;
  const selectedTotal = selectedPurchaseIds.size;
  document.getElementById('purchase-count').textContent = `${selectedTotal} ${selectedTotal === 1 ? 'item selecionado' : 'itens selecionados'}`;
  document.getElementById('purchase-export-button').disabled = selectedTotal === 0;
  document.getElementById('purchase-subtitle').textContent = `${rows.length} ${rows.length === 1 ? 'produto exibido' : 'produtos exibidos'} conforme os filtros`;
  document.getElementById('table-summary').textContent = rows.length ? `Exibindo 1 a ${rows.length} de ${rows.length} itens` : 'Exibindo 0 de 0 itens';
  const selectAll = document.getElementById('select-all');
  selectAll.checked = visiblePurchaseIds.length > 0 && selectedVisible === visiblePurchaseIds.length;
  selectAll.indeterminate = selectedVisible > 0 && selectedVisible < visiblePurchaseIds.length;
  selectAll.disabled = visiblePurchaseIds.length === 0;

  const tbody = document.getElementById('purchase-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Nenhum produto encontrado para estes filtros.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(({ product, qty, minimo, sales, suggested, status }) => `
    <tr>
      <td><input type="checkbox" class="purchase-check" data-id="${escapeHtml(purchaseSelectionId(product.id))}" ${selectedPurchaseIds.has(purchaseSelectionId(product.id)) ? 'checked' : ''} onchange="togglePurchaseItem(this.dataset.id, this.checked)" aria-label="Selecionar ${escapeHtml(product.nome)}"></td>
      <td>${productIdentityHTML(product, true)}</td>
      <td>${codesHTML(product)}</td>
      <td><span class="strong-number ${status.cls === 'out' ? 'stock-out' : ''}">${formatNumber(qty)}</span></td>
      <td>${formatNumber(minimo)}</td>
      <td>${formatNumber(sales)}</td>
      <td><span class="strong-number suggested">${formatNumber(suggested)}</span></td>
      <td><span class="badge ${status.cls}">${status.cls === 'out' ? 'Urgente' : status.cls === 'low' ? 'Em breve' : 'Monitorar'}</span></td>
    </tr>
  `).join('');
}

function togglePurchaseItem(id, checked) {
  const selectionId = purchaseSelectionId(id);
  if (checked) selectedPurchaseIds.add(selectionId); else selectedPurchaseIds.delete(selectionId);
  renderPurchaseSuggestions();
}

function toggleSelectAll(checked) {
  visiblePurchaseIds.forEach(id => {
    if (checked) selectedPurchaseIds.add(id); else selectedPurchaseIds.delete(id);
  });
  renderPurchaseSuggestions();
}

function purchaseSelectionId(id) {
  return String(id ?? '');
}

function getProductSales(id, name) {
  const days = Number(document.getElementById('filter-period')?.value || 30);
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  let total = 0;
  csvLots.forEach(lot => {
    if (cutoff && new Date(lot.created_at).getTime() < cutoff) return;
    (lot.baixas_csv_itens || []).filter(item => item.produto_id === id || normalizeText(item.produto_nome) === normalizeText(name)).forEach(item => total += Number(item.quantidade_csv) || 0);
  });
  historyRows.filter(row => (!cutoff || new Date(row.created_at).getTime() >= cutoff) && String(row.tipo || '').startsWith('baixa') && row.tipo !== 'baixa_csv_produto' && (row.produto_id === id || normalizeText(row.produtos?.nome) === normalizeText(name))).forEach(row => total += Math.abs((Number(row.quantidade_nova) || 0) - (Number(row.quantidade_anterior) || 0)));
  return total;
}

function renderTopProducts() {
  const totals = new Map();

  const days = Number(document.getElementById('ranking-period')?.value || 30);
  const cutoff = days ? Date.now() - days * 86400000 : 0;
  csvLots.forEach(lot => {
    if (cutoff && new Date(lot.created_at).getTime() < cutoff) return;
    (lot.baixas_csv_itens || []).forEach(item => {
      const product = findProduct(item.produto_id, item.produto_nome);
      const name = product?.nome || item.produto_nome;
      addTopProduct(totals, item.produto_id, name, Number(item.quantidade_csv) || 0);
    });
  });

  historyRows
    .filter(row => String(row.tipo || '').startsWith('baixa') && row.tipo !== 'baixa_csv_produto' && (!cutoff || new Date(row.created_at).getTime() >= cutoff))
    .forEach(row => {
      const product = findProduct(row.produto_id, row.produtos?.nome);
      if (product && productCategory(product) !== 'produto') return;
      if (!product && !row.produtos?.nome) return;
      addTopProduct(totals, row.produto_id, product?.nome || row.produtos.nome, Math.abs((row.quantidade_nova || 0) - (row.quantidade_anterior || 0)));
    });

  const rows = Array.from(totals.values())
    .filter(item => item.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const el = document.getElementById('top-products-list');
  if (!rows.length) {
    el.innerHTML = '<div class="empty-state">Ainda nao ha baixas suficientes para montar o ranking.</div>';
    return;
  }

  const max = rows[0].total || 1;
  el.innerHTML = rows.map(item => {
    const width = Math.max(4, Math.round((item.total / max) * 100));
    return `<div class="bar-row">
      <div class="bar-row-top">
        ${rankingIdentityHTML(item)}
        <div class="bar-value">${formatNumber(item.total)}</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
    </div>`;
  }).join('');
}

function addTopProduct(map, id, name, qty) {
  const normalizedName = normalizeText(name);
  if (!qty || !normalizedName || normalizedName === 'produto') return;
  const key = id || normalizedName;
  const current = map.get(key) || { id, name: String(name).trim(), total: 0 };
  current.total += qty;
  map.set(key, current);
}

function renderAttention() {
  const productItems = products.filter(p => productCategory(p) === 'produto');
  const outItems = productItems.filter(p => getStatus(p).cls === 'out');
  const lowItems = productItems.filter(p => getStatus(p).cls === 'low');
  const withoutMinItems = productItems.filter(p => (Number(p.minimo) || 0) === 0);
  const withoutCodesItems = productItems.filter(p => !p.codigo_referencia && !p.codigo_interno && !p.sku);
  const csvProblems = csvLots.reduce((sum, lot) => sum + (Number(lot.nao_encontrados) || 0) + (Number(lot.estoque_insuficiente) || 0), 0);
  const lastCsv = csvLots[0] ? formatDate(csvLots[0].created_at) : 'Sem importacao';

  attentionLists.productOut = outItems;
  attentionLists.productLow = lowItems;
  attentionLists.productWithoutCodes = withoutCodesItems;
  attentionLists.productWithoutMin = withoutMinItems;

  document.getElementById('attention-grid').innerHTML = qualityCard('red', 'code', 'Sem código', withoutCodesItems.length, 'produtos sem código cadastrado', 'productWithoutCodes', 'Produtos sem código') + qualityCard('yellow', 'alert', 'Sem mínimo', withoutMinItems.length, 'produtos sem estoque mínimo', 'productWithoutMin', 'Produtos sem mínimo') + qualityCard('', 'file', 'CSV com alerta', csvProblems, 'linhas com inconsistências', '', '', 'ocorrências') + `<div class="quality-card last-close"><span class="quality-icon">${iconSVG('clock')}</span><div><strong>Último fechamento</strong><p>${escapeHtml(lastCsv)}</p></div><span class="quality-count"><svg class="icon"><use href="#icon-chevron-right"></use></svg></span></div>`;
}

function qualityCard(color, icon, title, count, description, key, modalTitle, unit = '') {
  const tag = key ? 'button' : 'div';
  const action = key ? ` type="button" onclick="openAttentionModal('${key}', '${modalTitle}')"` : '';
  return `<${tag} class="quality-card ${color}"${action}><span class="quality-icon">${iconSVG(icon)}</span><div><strong>${title}</strong><p>${description}</p></div><span class="quality-count"><strong>${formatNumber(count)}</strong>${unit ? `<small>${unit}</small>` : ''}<svg class="icon"><use href="#icon-chevron-right"></use></svg></span></${tag}>`;
}

function iconSVG(name) {
  return `<svg class="icon" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
}

function exportPurchaseList() {
  const rows = [...selectedPurchaseIds].map(id => products.find(product => purchaseSelectionId(product.id) === id)).filter(Boolean);
  if (!rows.length) { alert('Selecione ao menos um produto para gerar a lista de compra.'); return; }
  downloadCsv('lista-de-compra.csv', [['Produto', 'Código', 'Estoque atual', 'Mínimo', 'Sugerido'], ...rows.map(product => [product.nome, product.codigo_interno || product.codigo_referencia || product.sku || '', totalQty(product), Number(product.minimo) || 0, Math.max((Number(product.minimo) || 0) - totalQty(product), 0)])]);
}

function exportReport() {
  const rows = filteredProductItems();
  downloadCsv('relatorio-estoque.csv', [['Produto', 'Código', 'Estoque atual', 'Mínimo', 'Status'], ...rows.map(product => [product.nome, product.codigo_interno || product.codigo_referencia || product.sku || '', totalQty(product), Number(product.minimo) || 0, getStatus(product).label])]);
}

function downloadCsv(filename, rows) {
  const csv = rows.map(row => row.map(value => `"${String(value ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

function toggleSidebar(forceOpen) {
  const sidebar = document.getElementById('sidebar');
  const button = document.getElementById('menu-toggle');
  const shouldOpen = typeof forceOpen === 'boolean' ? forceOpen : !sidebar.classList.contains('open');
  sidebar.classList.toggle('open', shouldOpen);
  if (button) button.setAttribute('aria-expanded', String(shouldOpen));
}

function renderMachineReport() {
  const machineItems = products.filter(p => productCategory(p) !== 'produto');
  const machineSales = getMachineSales();
  const low = machineItems.filter(p => getStatus(p).cls === 'low');
  const out = machineItems.filter(p => getStatus(p).cls === 'out');

  document.getElementById('machine-stat-total').textContent = formatNumber(machineItems.length);
  document.getElementById('machine-stat-units').textContent = formatNumber(machineItems.reduce((sum, p) => sum + totalQty(p), 0));
  document.getElementById('machine-stat-low').textContent = formatNumber(low.length);
  document.getElementById('machine-stat-out').textContent = formatNumber(out.length);
  document.getElementById('machine-stat-sales').textContent = formatNumber(machineSales.reduce((sum, row) => sum + row.qty, 0));

  renderMachinePurchaseSuggestions(machineItems);
  renderTopMachines(machineSales);
  renderMachineSales(machineSales);
  renderMachineAttention(machineItems, machineSales);
}

function getMachineSales() {
  return historyRows
    .filter(row => {
      if (!String(row.tipo || '').startsWith('baixa') || row.tipo === 'baixa_csv_produto') return false;
      const product = findProduct(row.produto_id, row.produtos?.nome);
      return product && productCategory(product) !== 'produto';
    })
    .map(row => ({
      row,
      product: findProduct(row.produto_id, row.produtos?.nome),
      qty: Math.abs((Number(row.quantidade_nova) || 0) - (Number(row.quantidade_anterior) || 0))
    }))
    .filter(item => item.qty > 0);
}

function renderMachinePurchaseSuggestions(machineItems) {
  const rows = machineItems
    .map(product => {
      const qty = totalQty(product);
      const minimo = Number(product.minimo) || 0;
      const voltageIssues = getVoltageIssues(product);
      const generalStatus = getStatus(product);
      const status = voltageIssues.length
        ? { cls: qty === 0 ? 'out' : 'low', label: `${voltageIssues.join(' e ')} sem estoque` }
        : generalStatus;
      return {
        product,
        qty,
        minimo,
        suggested: Math.max(minimo - qty, 0),
        generalStatus,
        status,
        voltageIssues
      };
    })
    .filter(item => item.generalStatus.cls !== 'ok' || item.voltageIssues.length)
    .sort((a, b) => {
      if (a.status.cls !== b.status.cls) return a.status.cls === 'out' ? -1 : 1;
      if (a.voltageIssues.length !== b.voltageIssues.length) return b.voltageIssues.length - a.voltageIssues.length;
      return b.suggested - a.suggested;
    });

  document.getElementById('machine-purchase-count').textContent = `${rows.length} ${rows.length === 1 ? 'item' : 'itens'}`;
  const tbody = document.getElementById('machine-purchase-tbody');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Nenhuma maquina ou prensa abaixo do minimo.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(({ product, qty, minimo, suggested, status, voltageIssues }) => `
    <tr>
      <td>${productIdentityHTML(product, true)}</td>
      <td>${codesHTML(product)}</td>
      <td>${product.tem_voltagem ? formatNumber(product.quantidade_110v) : '-'}</td>
      <td>${product.tem_voltagem ? formatNumber(product.quantidade_220v) : '-'}</td>
      <td><span class="strong-number">${formatNumber(qty)}</span></td>
      <td>${formatNumber(minimo)}</td>
      <td>${machineSuggestionHTML(suggested, voltageIssues)}</td>
      <td><span class="badge ${status.cls}">${status.label}</span></td>
    </tr>
  `).join('');
}

function machineSuggestionHTML(suggested, voltageIssues) {
  if (!voltageIssues.length) return `<span class="strong-number">${formatNumber(suggested)}</span>`;

  if (voltageIssues.length > 1) {
    return '<span class="voltage-restock">A definir</span><div class="muted">110V e 220V zeradas</div>';
  }

  const voltageText = voltageIssues.join(' e ');
  if (suggested > 0) {
    return `<span class="strong-number">${formatNumber(suggested)}</span><div class="muted">Repor em ${voltageText}</div>`;
  }
  return `<span class="voltage-restock">Repor ${voltageText}</span><div class="muted">Quantidade a definir</div>`;
}

function renderTopMachines(machineSales) {
  const totals = new Map();
  machineSales.forEach(item => addTopProduct(totals, item.product.id, item.product.nome, item.qty));

  const rows = Array.from(totals.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  const el = document.getElementById('top-machines-list');

  if (!rows.length) {
    el.innerHTML = '<div class="empty-state">Ainda nao ha baixas de maquinas para montar o ranking.</div>';
    return;
  }

  const max = rows[0].total || 1;
  el.innerHTML = rows.map(item => `
    <div class="bar-row">
      <div class="bar-row-top">
        ${rankingIdentityHTML(item)}
        <div class="bar-value">${formatNumber(item.total)}</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, Math.round((item.total / max) * 100))}%"></div></div>
    </div>
  `).join('');
}

function renderMachineSales(machineSales) {
  const el = document.getElementById('machine-sales-list');
  if (!machineSales.length) {
    el.innerHTML = '<div class="empty-state">Nenhuma baixa de maquina encontrada.</div>';
    return;
  }

  el.innerHTML = machineSales.slice(0, 8).map(({ row, product, qty }) => {
    const voltage = row.voltagem ? ` - ${escapeHtml(row.voltagem)}` : '';
    const seller = row.vendedor || row.usuario || 'Vendedor';
    return `<div class="sale-card">
      <div class="sale-product">
        ${productPhotoHTML(product, 'small')}
        <div class="sale-product-text">
          <div class="sale-name" title="${escapeHtml(product.nome)}">${escapeHtml(product.nome)}</div>
          <div class="sale-meta">${escapeHtml(seller)}${voltage} - ${formatDate(row.created_at)}</div>
        </div>
      </div>
      <div class="sale-qty">${formatNumber(qty)}<span>unidades</span></div>
    </div>`;
  }).join('');
}

function renderMachineAttention(machineItems, machineSales) {
  const outItems = machineItems.filter(p => getStatus(p).cls === 'out');
  const lowItems = machineItems.filter(p => getStatus(p).cls === 'low');
  const withoutMinItems = machineItems.filter(p => (Number(p.minimo) || 0) === 0);
  const withoutCodesItems = machineItems.filter(p => !p.codigo_referencia && !p.codigo_interno && !p.sku);
  const voltageOutItems = machineItems.filter(p => getVoltageIssues(p).length > 0);
  const lastSale = machineSales[0] ? formatDate(machineSales[0].row.created_at) : 'Sem baixas';

  attentionLists.machineOut = outItems;
  attentionLists.machineLow = lowItems;
  attentionLists.machineVoltageOut = voltageOutItems;
  attentionLists.machineWithoutCodes = withoutCodesItems;
  attentionLists.machineWithoutMin = withoutMinItems;

  document.getElementById('machine-attention-grid').innerHTML = `
    <div class="attention-card red">
      <span>Reposicao urgente</span>
      <strong>${formatNumber(outItems.length)}</strong>
      <p>Maquinas e prensas sem nenhuma unidade em estoque.</p>
      ${attentionButton('machineOut', 'Maquinas para reposicao urgente', outItems.length)}
    </div>
    <div class="attention-card yellow">
      <span>Comprar em breve</span>
      <strong>${formatNumber(lowItems.length)}</strong>
      <p>Maquinas e prensas abaixo ou no minimo cadastrado.</p>
      ${attentionButton('machineLow', 'Maquinas para comprar em breve', lowItems.length)}
    </div>
    <div class="attention-card yellow">
      <span>Voltagem zerada</span>
      <strong>${formatNumber(voltageOutItems.length)}</strong>
      <p>Maquinas com estoque zerado em 110V ou 220V.</p>
      ${attentionButton('machineVoltageOut', 'Maquinas com voltagem zerada', voltageOutItems.length)}
    </div>
    <div class="attention-card">
      <span>Cadastro incompleto</span>
      <strong>${formatNumber(withoutCodesItems.length)}</strong>
      <p>Maquinas sem codigo interno, referencia ou barras.</p>
      ${attentionButton('machineWithoutCodes', 'Maquinas com cadastro incompleto', withoutCodesItems.length)}
    </div>
    <div class="attention-card">
      <span>Sem minimo</span>
      <strong>${formatNumber(withoutMinItems.length)}</strong>
      <p>Maquinas sem alerta minimo configurado.</p>
      ${attentionButton('machineWithoutMin', 'Maquinas sem minimo configurado', withoutMinItems.length)}
    </div>
    <div class="attention-card green">
      <span>Ultima venda</span>
      <strong>${escapeHtml(lastSale)}</strong>
      <p>Ultima baixa manual de maquina registrada.</p>
    </div>
  `;
}

function attentionButton(key, title, count) {
  if (!count) return '';
  return `<button class="attention-card-action" type="button" onclick="openAttentionModal('${key}', '${title}')">Ver produtos</button>`;
}

function openAttentionModal(key, title) {
  const items = attentionLists[key] || [];
  document.getElementById('attention-modal-title').textContent = title;
  document.getElementById('attention-modal-subtitle').textContent = `${items.length} ${items.length === 1 ? 'item encontrado' : 'itens encontrados'}`;
  document.getElementById('attention-modal-list').innerHTML = items.length
    ? items.map(attentionProductHTML).join('')
    : '<div class="empty-state">Nenhum item encontrado.</div>';
  document.getElementById('attention-modal').classList.add('open');
  document.body.classList.add('modal-open');
}

function attentionProductHTML(product) {
  const qty = totalQty(product);
  const stockDetails = product.tem_voltagem
    ? `<div class="modal-stock-item"><span>110V</span><strong>${formatNumber(product.quantidade_110v)}</strong></div>
       <div class="modal-stock-item"><span>220V</span><strong>${formatNumber(product.quantidade_220v)}</strong></div>`
    : '';

  return `<div class="modal-product">
    <div class="modal-product-identity">
      ${productPhotoHTML(product)}
      <div>
        <div class="modal-product-name">${escapeHtml(product.nome)}</div>
        <div class="modal-product-codes">${plainCodes(product)}</div>
      </div>
    </div>
    <div class="modal-product-stock">
      ${stockDetails}
      <div class="modal-stock-item"><span>Atual</span><strong>${formatNumber(qty)}</strong></div>
      <div class="modal-stock-item"><span>Minimo</span><strong>${formatNumber(product.minimo)}</strong></div>
    </div>
  </div>`;
}

function plainCodes(product) {
  const codes = [
    product.codigo_interno ? `Int: ${product.codigo_interno}` : '',
    product.codigo_referencia ? `Ref: ${product.codigo_referencia}` : '',
    product.sku ? `Barras: ${product.sku}` : ''
  ].filter(Boolean);
  return codes.length ? escapeHtml(codes.join(' - ')) : 'Sem codigos cadastrados';
}

function productIdentityHTML(product, showNotes = false) {
  const notes = showNotes && product.observacoes
    ? `<div class="muted product-notes">${escapeHtml(product.observacoes)}</div>`
    : '';

  return `<div class="product-identity">
    ${productPhotoHTML(product)}
    <div class="product-identity-text">
      <strong title="${escapeHtml(product.nome)}">${escapeHtml(product.nome)}</strong>
      ${notes}
    </div>
  </div>`;
}

function rankingIdentityHTML(item) {
  const product = findProduct(item.id, item.name);
  return `<div class="bar-product">
    ${product ? productPhotoHTML(product, 'small') : ''}
    <div class="bar-name" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</div>
  </div>`;
}

function productPhotoHTML(product, size = '') {
  const name = String(product.nome || 'Produto').trim();
  const initial = escapeHtml(name.charAt(0).toUpperCase() || '?');
  const sizeClass = size ? ` ${size}` : '';

  if (!product.imagem_url) {
    return `<div class="product-thumb${sizeClass}"><span class="product-thumb-fallback visible">${initial}</span></div>`;
  }

  return `<div class="product-thumb${sizeClass}">
    <img src="${escapeHtml(product.imagem_url)}" alt="" loading="lazy" onload="this.style.display='block';this.nextElementSibling.classList.remove('visible')" onerror="this.style.display='none';this.nextElementSibling.classList.add('visible')">
    <span class="product-thumb-fallback">${initial}</span>
  </div>`;
}

function closeAttentionModal() {
  document.getElementById('attention-modal').classList.remove('open');
  document.body.classList.remove('modal-open');
}

function closeAttentionModalOnOverlay(event) {
  if (event.target === event.currentTarget) closeAttentionModal();
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    closeAttentionModal();
    toggleSidebar(false);
  }
});

function codesHTML(product) {
  const codes = [
    product.codigo_interno ? `Int: ${product.codigo_interno}` : '',
    product.codigo_referencia ? `Ref: ${product.codigo_referencia}` : '',
    product.sku ? `Barras: ${product.sku}` : ''
  ].filter(Boolean);

  if (!codes.length) return '<span class="muted">Sem códigos</span>';
  const fullCodes = codes.join(' · ');
  return `<div class="code-tags" title="${escapeHtml(fullCodes)}">${codes.map(code => `<span class="code-tag">${escapeHtml(code)}</span>`).join('')}</div>`;
}

function findProduct(id, name) {
  if (id) {
    const byId = products.find(p => p.id === id);
    if (byId) return byId;
  }
  const normalized = normalizeText(name || '');
  return products.find(p => normalizeText(p.nome) === normalized);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('pt-BR');
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function updateTimestamp() {
  const el = document.getElementById('updated-at');
  if (el) el.textContent = `Última atualização: ${formatDate(new Date())}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

checkSession();
