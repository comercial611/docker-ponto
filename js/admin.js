let products = [];
let vendedores = [];
let deleteTargetId = null;
let deleteVendedorId = null;
let csvPreviewRows = [];
let csvPreviewApplied = false;
let csvPreviewFileName = null;
let csvPreviewHash = null;
let csvDuplicateLot = null;
let csvDuplicateCheckPending = false;
let csvLots = [];
let csvLotsPage = 1;
const csvLotsPageSize = 5;
let csvLotsTotal = 0;
const csvExpandedLots = new Set();
let dashboardLatestCsvLot = null;
let dashboardFirstCsvPage = [];
let dashboardResolverFilter = null;

const DASHBOARD_RESOLVER_FILTERS = Object.freeze({
  incomplete: {
    label: 'Cadastro incompleto',
    matches: (product) => !product.codigo_referencia && !product.codigo_interno && !product.sku
  },
  without_min: {
    label: 'Produtos sem mínimo configurado',
    matches: (product) => (Number(product.minimo) || 0) === 0
  }
});
let nuvemshopCatalogRows = [];
let nuvemshopRemoteProducts = [];
let nuvemshopActiveLinks = [];
let nuvemshopBrokenLinks = [];
let nuvemshopCatalogLoaded = false;
let nuvemshopCatalogLoading = false;
let nuvemshopCatalogError = false;
let nuvemshopCatalogPage = 1;
let nuvemshopCatalogPageSize = 50;
let nuvemshopStoreId = null;
let nuvemshopStockLocation = null;
let nuvemshopCatalogRequestId = 0;
const NUVEMSHOP_STORES = Object.freeze([
  Object.freeze({ id: 3514029, label: 'loja atual' }),
  Object.freeze({ id: 6696910, label: 'loja nova' })
]);
const NUVEMSHOP_DEFAULT_STORE_ID = 3514029;
let nuvemshopManualRow = null;
let nuvemshopManualVoltage = null;
let nuvemshopPreviewGenerated = false;
let nuvemshopPreviewGeneratedAt = null;
let nuvemshopServerSimulation = null;
let nuvemshopPilotReadiness = null;
let nuvemshopPilotSelectedItemId = null;
let nuvemshopPilotMode = 'pilot';
let nuvemshopBatchSelectedItemIds = [];
const NUVEMSHOP_BATCH_MAX_ITEMS = 15;
let nuvemshopPilotApplying = false;
let nuvemshopPilotApplicationLocked = false;
let nuvemshopPilotWindowBusy = false;
let nuvemshopPilotWindowTimer = null;
let nuvemshopOAuthStartBusy = false;
let nuvemshopLinkDeactivationTarget = null;
let nuvemshopLinkDeactivationBusy = false;
let nuvemshopLinkDeactivationPreviousFocus = null;
const NUVEMSHOP_OAUTH_FINAL_PARAM = 'nuvemshop_oauth';
const NUVEMSHOP_OAUTH_FINAL_VALUE = 'finalizado';
const NUVEMSHOP_OAUTH_FINAL_MESSAGE = 'O retorno da autorizacao da Nuvemshop foi processado. Verifique o estado da conexao no painel.';
let productTags = [];
let productStatusTarget = null;
let productStatusBusy = false;
let productStatusPreviousFocus = null;
const PRODUCT_TAG_LIMIT = 10;
const SUPPLIER_STATUS_CONFIG = Object.freeze({
  normal: { label: 'Normal', className: 'supplier-status-normal' },
  atencao: { label: 'Atenção', className: 'supplier-status-atencao' },
  em_falta: { label: 'Em falta', className: 'supplier-status-em-falta' }
});
const PRODUCT_ACTIVE_STATUS_CONFIG = Object.freeze({
  active: Object.freeze({ label: 'Ativo', className: 'product-status-active' }),
  inactive: Object.freeze({ label: 'Inativo', className: 'product-status-inactive' })
});
const PRODUCT_STATUS_FOCUS_TARGETS = Object.freeze({
  dashboard: 'filter-product-active-dash',
  products: 'filter-product-active-products'
});


// Estado do painel de baixa
let baixaProduto = null;
let baixaVoltagemSelecionada = null; // 'v110' | 'v220' | null

function showToast(color, text) {
  const safeColor = normalizeNotificationColor(color);
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = `toast ${safeColor}`;
  el.innerHTML = `<div class="toast-dot ${safeColor}"></div><div class="toast-text">${sanitizeNotificationText(text)}</div>`;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4500);
}

// ─── AUTH ────────────────────────────────────────────────
function isBaixaTipo(tipo) {
  return String(tipo || '').startsWith('baixa');
}

async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await enterAdminArea();
}
sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
  }
});
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  document.getElementById('login-error').textContent = '';
  const { error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) { document.getElementById('login-error').textContent = 'E-mail ou senha incorretos.'; return; }
  await enterAdminArea();
}
async function doLogout() { await sb.auth.signOut(); }

async function enterAdminArea() {
  const { data: tipo, error } = await sb.rpc('usuario_tipo');
  if (error || tipo !== 'admin') {
    await sb.auth.signOut();
    document.getElementById('login-error').textContent = 'Acesso permitido apenas para administradores.';
    return false;
  }

  showApp();
  await init();
  return true;
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  showNuvemshopOAuthFinalMessage();
}

function showNuvemshopOAuthFinalMessage() {
  const url = new URL(window.location.href);
  const values = url.searchParams.getAll(NUVEMSHOP_OAUTH_FINAL_PARAM);
  const queryKeys = Array.from(url.searchParams.keys());
  if (
    values.length !== 1
    || values[0] !== NUVEMSHOP_OAUTH_FINAL_VALUE
    || queryKeys.length !== 1
    || queryKeys[0] !== NUVEMSHOP_OAUTH_FINAL_PARAM
  ) return;

  const errorElement = document.getElementById('nuvemshop-connect-error');
  if (errorElement) {
    errorElement.classList.add('nuvemshop-connect-notice');
    errorElement.textContent = NUVEMSHOP_OAUTH_FINAL_MESSAGE;
  }

  url.searchParams.delete(NUVEMSHOP_OAUTH_FINAL_PARAM);
  history.replaceState(history.state, document.title, `${url.pathname}${url.search}${url.hash}`);
}

async function init() {
  initProductTagsInput();
  loadSavedNotifications();
  setDefaultCsvMovementDate();
  await loadProducts();
  await loadVendedores();
  await loadHistory();
  restoreRecentHistoryNotifications(historyRows.filter(shouldNotifyHistoryRecord).slice(0, 50));
  await loadCsvLots();
  subscribeRealtime();
}

// ─── PRODUTOS ────────────────────────────────────────────
async function loadProducts({ throwOnError = false } = {}) {
  const { data, error } = await sb.from('produtos').select('*').order('nome');
  if (error && throwOnError) throw error;
  const newList = data || [];

  if (Object.keys(productsSnapshot).length > 0) {
    detectStockChanges(newList);
  } else {
    productsSnapshot = snapshotProducts(newList);
  }

  products = newList;
  renderDashTable();
  renderProdTable();
  updateStats();
  renderDashboardResolverToday();
  return { data: newList, error: error || null };
}

function thumbHTML(p, size) {
  size = size || 44;
  const safeName = escapeHtml(p.nome || '');
  if (p.imagem_url) {
    return `<img class="prod-thumb" style="width:${size}px;height:${size}px" src="${p.imagem_url}" alt="${safeName}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
            <div class="prod-thumb-placeholder" style="width:${size}px;height:${size}px;display:none">📦</div>`;
  }
  return `<div class="prod-thumb-placeholder" style="width:${size}px;height:${size}px">📦</div>`;
}

function categoryHTML(p) {
  const category = p.categoria || 'maquina';
  const label = category === 'produto' ? 'Produto' : 'Máquina';
  return `<span class="category-badge ${category}">${label}</span>`;
}
function codesHTML(p) {
  const tags = [];
  if (p.codigo_fabricante) tags.push(`Fab: ${p.codigo_fabricante}`);
  if (p.codigo_interno) tags.push(`Int: ${p.codigo_interno}`);
  if (p.codigo_referencia) tags.push(`Ref: ${p.codigo_referencia}`);
  if (p.sku) tags.push(`Barras: ${p.sku}`);
  if (!tags.length) return '<span style="color:var(--muted)">—</span>';
  return `<div class="code-tags">${tags.map(t => `<span class="code-tag">${t}</span>`).join('')}</div>`;
}

function supplierStatusConfig(status) {
  if (!isValidSupplierStatus(status)) return null;
  return SUPPLIER_STATUS_CONFIG[status];
}

function isValidSupplierStatus(status) {
  return Object.prototype.hasOwnProperty.call(SUPPLIER_STATUS_CONFIG, status);
}

function createSupplierBadge(product) {
  const config = supplierStatusConfig(product.fornecedor_status);
  if (!config || product.fornecedor_status === 'normal') return null;

  const wrapper = document.createElement('div');
  wrapper.className = 'supplier-meta';

  const badge = document.createElement('span');
  badge.className = `supplier-status ${config.className}`;
  badge.textContent = config.label;
  wrapper.appendChild(badge);

  const observation = String(product.fornecedor_observacao || '').trim();
  if (observation) {
    const note = document.createElement('div');
    note.className = 'supplier-observation';
    note.textContent = observation;
    wrapper.appendChild(note);
  }

  return wrapper;
}

function renderProductMetadata(tableBody, list) {
  const productsById = new Map(list.map(product => [String(product.id), product]));
  tableBody.querySelectorAll('.admin-product-meta').forEach(slot => {
    const product = productsById.get(slot.dataset.productId);
    if (!product) return;

    const tags = Array.isArray(product.tags) ? product.tags : [];
    if (tags.length) {
      const tagsWrap = document.createElement('div');
      tagsWrap.className = 'product-tags';
      tags.forEach(tag => {
        const chip = document.createElement('span');
        chip.className = 'product-tag';
        chip.textContent = tag;
        tagsWrap.appendChild(chip);
      });
      slot.appendChild(tagsWrap);
    }

    const supplierBadge = createSupplierBadge(product);
    if (supplierBadge) slot.appendChild(supplierBadge);
  });
}

function totalQty(p) { return p.tem_voltagem ? (p.quantidade_110v + p.quantidade_220v) : p.quantidade; }

function isProductActive(product) {
  return product?.ativo === true;
}

function productMatchesActiveFilter(product, filter) {
  if (filter === 'inactive') return !isProductActive(product);
  if (filter === 'all') return true;
  return isProductActive(product);
}

function productActiveStatusHTML(product) {
  const key = isProductActive(product) ? 'active' : 'inactive';
  const config = PRODUCT_ACTIVE_STATUS_CONFIG[key];
  return `<span class="product-status-badge ${config.className}">${config.label}</span>`;
}

function getStatus(p) {
  const qty = totalQty(p);
  if (qty === 0) return { cls: 'out', label: 'Sem estoque' };
  if (qty <= (p.minimo || 0)) return { cls: 'low', label: 'Estoque baixo' };
  return { cls: 'ok', label: 'OK' };
}

function isDashboardResolverIncomplete(product) {
  return !product?.codigo_referencia && !product?.codigo_interno && !product?.sku;
}

function dashboardResolverQuantity(product) {
  const quantity = Number(totalQty(product));
  return Number.isFinite(quantity) ? quantity : 0;
}

function buildDashboardResolverData(productList = products, historyList = historyRows, lotList = csvLots, now = new Date()) {
  const allProducts = Array.isArray(productList) ? productList : [];
  const activeProducts = allProducts.filter(isProductActive);
  const latestCsvLot = Array.isArray(lotList) ? lotList[0] || null : null;
  const sevenDaysAgo = now.getTime() - (7 * 24 * 60 * 60 * 1000);

  const purchaseSuggestions = activeProducts
    .filter(product => (product.categoria || 'maquina') === 'produto')
    .map(product => {
      const quantity = dashboardResolverQuantity(product);
      const minimum = Number(product.minimo) || 0;
      return {
        product,
        quantity,
        minimum,
        suggested: Math.max(minimum - quantity, 0),
        status: getStatus(product)
      };
    })
    .filter(item => item.minimum > 0 && item.suggested > 0)
    .sort((a, b) => {
      if (a.status.cls !== b.status.cls) return a.status.cls === 'out' ? -1 : 1;
      if (a.suggested !== b.suggested) return b.suggested - a.suggested;
      return String(a.product.nome || '').localeCompare(String(b.product.nome || ''), 'pt-BR');
    });

  return {
    outOfStock: activeProducts.filter(product => getStatus(product).cls === 'out'),
    belowMinimum: activeProducts.filter(product => getStatus(product).cls === 'low'),
    incomplete: activeProducts.filter(isDashboardResolverIncomplete),
    withoutMinimum: activeProducts.filter(product => (Number(product.minimo) || 0) === 0),
    inactive: allProducts.filter(product => product?.ativo === false),
    recentManual: (Array.isArray(historyList) ? historyList : []).filter(row => {
      const date = new Date(row?.created_at).getTime();
      return historyRowType(row) === 'manual' && Number.isFinite(date) && date >= sevenDaysAgo;
    }),
    latestCsvLot,
    csvNotFound: Math.max(0, Number(latestCsvLot?.nao_encontrados) || 0),
    csvInsufficient: Math.max(0, Number(latestCsvLot?.estoque_insuficiente) || 0),
    purchaseSuggestions
  };
}

function dashboardResolverNumber(value) {
  return Number(value || 0).toLocaleString('pt-BR');
}

function createDashboardResolverCard({ priority, tone, title, count, description, actionLabel, onAction }) {
  const card = document.createElement('article');
  card.className = `resolver-card ${tone}`;

  const priorityElement = document.createElement('span');
  priorityElement.className = 'resolver-card-priority';
  priorityElement.textContent = priority;

  const titleElement = document.createElement('h3');
  titleElement.textContent = title;

  const countElement = document.createElement('strong');
  countElement.className = 'resolver-card-count';
  countElement.textContent = dashboardResolverNumber(count);

  const descriptionElement = document.createElement('p');
  descriptionElement.textContent = description;

  const action = document.createElement('button');
  action.type = 'button';
  action.textContent = actionLabel;
  action.addEventListener('click', onAction);

  card.append(priorityElement, titleElement, countElement, descriptionElement, action);
  return card;
}

function renderDashboardResolverToday() {
  const grid = document.getElementById('resolver-today-grid');
  const csvStatus = document.getElementById('resolver-today-csv-status');
  const purchaseList = document.getElementById('resolver-purchase-list');
  const purchaseCount = document.getElementById('resolver-purchase-count');
  if (!grid || !csvStatus || !purchaseList || !purchaseCount) return;

  const data = buildDashboardResolverData(
    products,
    historyRows,
    dashboardLatestCsvLot ? [dashboardLatestCsvLot] : csvLots
  );
  grid.replaceChildren();

  const cards = [
    createDashboardResolverCard({
      priority: 'Crítico',
      tone: 'critical',
      title: 'Produtos sem estoque',
      count: data.outOfStock.length,
      description: 'Produtos ativos que exigem reposição ou conferência imediata.',
      actionLabel: 'Ver no Dashboard',
      onAction: () => applyDashboardResolverStockFilter('out')
    }),
    createDashboardResolverCard({
      priority: 'Alto',
      tone: 'high',
      title: 'Abaixo do mínimo',
      count: data.belowMinimum.length,
      description: 'Produtos ativos com estoque acima de zero, mas abaixo do mínimo.',
      actionLabel: 'Ver no Dashboard',
      onAction: () => applyDashboardResolverStockFilter('low')
    })
  ];

  if (data.csvNotFound || data.csvInsufficient) {
    const pending = [];
    if (data.csvNotFound) pending.push(`${dashboardResolverNumber(data.csvNotFound)} não encontrados`);
    if (data.csvInsufficient) pending.push(`${dashboardResolverNumber(data.csvInsufficient)} com estoque insuficiente`);
    cards.push(createDashboardResolverCard({
      priority: 'Alto',
      tone: 'high',
      title: 'Pendências do último CSV',
      count: data.csvNotFound + data.csvInsufficient,
      description: pending.join(' · '),
      actionLabel: 'Abrir Histórico',
      onAction: openLatestCsvLotFromDashboard
    }));
    csvStatus.hidden = true;
  } else {
    csvStatus.hidden = false;
    csvStatus.textContent = data.latestCsvLot
      ? 'Último CSV sem pendências registradas.'
      : 'Ainda não há importação CSV carregada.';
  }

  cards.push(
    createDashboardResolverCard({
      priority: 'Médio',
      tone: 'medium',
      title: 'Cadastro incompleto',
      count: data.incomplete.length,
      description: 'Produtos ativos sem referência, código interno e SKU.',
      actionLabel: 'Filtrar cadastro',
      onAction: () => setDashboardResolverFilter('incomplete')
    }),
    createDashboardResolverCard({
      priority: 'Médio',
      tone: 'medium',
      title: 'Definir mínimos',
      count: data.withoutMinimum.length,
      description: 'Produtos ativos sem mínimo configurado não entram na sugestão de compra.',
      actionLabel: 'Filtrar produtos',
      onAction: () => setDashboardResolverFilter('without_min')
    }),
    createDashboardResolverCard({
      priority: 'Acompanhar',
      tone: 'follow',
      title: 'Produtos inativos',
      count: data.inactive.length,
      description: 'Itens preservados no cadastro, fora da operação ativa.',
      actionLabel: 'Ver inativos',
      onAction: () => applyDashboardResolverActiveFilter('inactive')
    }),
    createDashboardResolverCard({
      priority: 'Acompanhar',
      tone: 'follow',
      title: 'Baixas manuais recentes',
      count: data.recentManual.length,
      description: 'Baixas manuais registradas nos últimos 7 dias.',
      actionLabel: 'Abrir Histórico',
      onAction: openRecentManualHistory
    })
  );

  cards.forEach(card => grid.appendChild(card));
  purchaseList.replaceChildren();
  purchaseCount.textContent = `${dashboardResolverNumber(data.purchaseSuggestions.length)} ${data.purchaseSuggestions.length === 1 ? 'item' : 'itens'}`;

  if (!data.purchaseSuggestions.length) {
    const empty = document.createElement('p');
    empty.className = 'resolver-purchase-empty';
    empty.textContent = 'Nenhum produto ativo precisa ser reposto até o mínimo cadastrado.';
    purchaseList.appendChild(empty);
    return;
  }

  data.purchaseSuggestions.slice(0, 5).forEach(item => {
    const row = document.createElement('article');
    row.className = 'resolver-purchase-item';
    const details = document.createElement('div');
    const name = document.createElement('strong');
    name.className = 'resolver-purchase-name';
    name.textContent = item.product.nome || 'Produto sem nome';
    details.append(name);
    const stock = document.createElement('span');
    stock.className = 'resolver-purchase-stock';
    stock.textContent = `Estoque ${dashboardResolverNumber(item.quantity)} · Mínimo ${dashboardResolverNumber(item.minimum)}`;
    const amount = document.createElement('span');
    amount.className = 'resolver-purchase-suggestion';
    amount.textContent = `Repor ${dashboardResolverNumber(item.suggested)}`;
    row.append(details, stock, amount);
    purchaseList.appendChild(row);
  });
}

function resetDashboardResolverFilters() {
  const search = document.getElementById('search-dash');
  const status = document.getElementById('filter-status');
  const vendor = document.getElementById('filter-vendedor');
  if (search) search.value = '';
  if (status) status.value = '';
  if (vendor) vendor.value = '';
}

function focusDashboardTable() {
  const table = document.getElementById('dash-table-wrap');
  if (!table) return;
  table.scrollIntoView({ behavior: 'smooth', block: 'start' });
  table.focus({ preventScroll: true });
}

function applyDashboardResolverStockFilter(status) {
  if (status !== 'out' && status !== 'low') return;
  dashboardResolverFilter = null;
  resetDashboardResolverFilters();
  const active = document.getElementById('filter-product-active-dash');
  const statusFilter = document.getElementById('filter-status');
  if (active) active.value = 'active';
  if (statusFilter) statusFilter.value = status;
  renderDashTable();
  focusDashboardTable();
}

function applyDashboardResolverActiveFilter(filter) {
  if (filter !== 'active' && filter !== 'inactive' && filter !== 'all') return;
  dashboardResolverFilter = null;
  resetDashboardResolverFilters();
  const active = document.getElementById('filter-product-active-dash');
  if (active) active.value = filter;
  renderDashTable();
  focusDashboardTable();
}

function setDashboardResolverFilter(filter) {
  if (!Object.prototype.hasOwnProperty.call(DASHBOARD_RESOLVER_FILTERS, filter)) return;
  dashboardResolverFilter = filter;
  resetDashboardResolverFilters();
  const active = document.getElementById('filter-product-active-dash');
  if (active) active.value = 'active';
  renderDashTable();
  focusDashboardTable();
}

function clearDashboardResolverFilter() {
  dashboardResolverFilter = null;
  renderDashTable();
  focusDashboardTable();
}

function renderDashboardResolverFilterState() {
  const container = document.getElementById('dashboard-resolver-filter');
  const label = document.getElementById('dashboard-resolver-filter-label');
  if (!container || !label) return;
  const filter = DASHBOARD_RESOLVER_FILTERS[dashboardResolverFilter];
  container.hidden = !filter;
  label.textContent = filter ? `Filtro de prioridade: ${filter.label}.` : '';
}

function openLatestCsvLotFromDashboard() {
  const latest = dashboardLatestCsvLot;
  switchTab('historico');
  if (latest && dashboardFirstCsvPage.length) {
    csvLots = dashboardFirstCsvPage.slice();
    csvLotsPage = 1;
    csvExpandedLots.clear();
    csvExpandedLots.add(String(latest.id));
    renderCsvLots();
  }
  const heading = document.querySelector('#tab-historico .section-title');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }
}

function openRecentManualHistory() {
  const type = document.getElementById('filter-historico-tipo');
  const period = document.getElementById('filter-historico-periodo');
  if (type) type.value = 'manual';
  if (period) period.value = '7';
  switchTab('historico');
  renderHistory();
  const heading = document.querySelector('#tab-historico .section-title');
  if (heading) {
    heading.setAttribute('tabindex', '-1');
    heading.focus();
  }
}

function qtyCellHTML(p) {
  if (!p.tem_voltagem) {
    const status = getStatus(p);
    return `<span class="qty-highlight qty-${status.cls}">${p.quantidade}</span>`;
  }
  return `<div class="volt-line"><span class="volt-tag v110">110V</span> <strong>${p.quantidade_110v}</strong></div>
          <div class="volt-line"><span class="volt-tag v220">220V</span> <strong>${p.quantidade_220v}</strong></div>`;
}

function lastBaixaHTML(p) {
  if (!p.ultima_baixa_em) return '<span class="last-baixa-none">Nenhuma baixa ainda</span>';
  const dt = new Date(p.ultima_baixa_em);
  const dateStr = dt.toLocaleDateString('pt-BR');
  const timeStr = dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const volt = p.ultima_baixa_voltagem ? ` (${p.ultima_baixa_voltagem})` : '';
  return `<div class="last-baixa"><strong>${p.ultima_baixa_vendedor || '—'}</strong>${volt}<br>${dateStr} às ${timeStr}</div>`;
}

function renderDashTable() {
  const q = document.getElementById('search-dash').value;
  const statusFilter = document.getElementById('filter-status').value;
  const vendedorFilter = document.getElementById('filter-vendedor').value;
  const activeFilter = document.getElementById('filter-product-active-dash').value;

  const filtered = products.filter(p => {
    const matchesSearch = productMatchesSearch(p, q);
    const matchesStatus = !statusFilter || getStatus(p).cls === statusFilter;
    const matchesVendedor = !vendedorFilter || p.ultima_baixa_vendedor === vendedorFilter;
    const matchesActive = productMatchesActiveFilter(p, activeFilter);
    const resolverConfig = DASHBOARD_RESOLVER_FILTERS[dashboardResolverFilter];
    const matchesResolver = !resolverConfig || (isProductActive(p) && resolverConfig.matches(p));
    return matchesSearch && matchesStatus && matchesVendedor && matchesActive && matchesResolver;
  });

  const tbody = document.getElementById('dash-tbody');
  renderDashboardResolverFilterState();
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="9" class="empty-state">Nenhum produto encontrado.</td></tr>'; return; }
  tbody.innerHTML = filtered.map(p => {
    const status = getStatus(p);
    const active = isProductActive(p);
    const safeName = escapeHtml(p.nome || 'Produto');
    return `<tr id="row-${p.id}" class="${active ? '' : 'product-row-inactive'}">
      <td>${thumbHTML(p)}</td>
      <td><strong>${safeName}</strong>${p.observacoes ? `<br><span style="color:var(--muted);font-size:11px">${p.observacoes}</span>` : ''}<div class="admin-product-meta" data-product-id="${p.id}"></div></td>
      <td>${productActiveStatusHTML(p)}</td>
      <td>${codesHTML(p)}</td>
      <td>${qtyCellHTML(p)}</td>
      <td style="color:var(--muted)">${p.minimo || 0}</td>
      <td><span class="badge ${status.cls}">${status.label}</span></td>
      <td>${lastBaixaHTML(p)}</td>
      <td>${active ? `<button class="btn-baixa" onclick="openBaixaPanel(${p.id})">Baixa</button>` : '<button class="btn-baixa" disabled title="Produto inativo">Baixa</button>'}</td>
    </tr>`;
  }).join('');
  renderProductMetadata(tbody, filtered);
}

function renderProdTable() {
  const q = document.getElementById('search-prod')?.value || '';
  const categoryFilter = document.getElementById('filter-prod-categoria')?.value || '';
  const activeFilter = document.getElementById('filter-product-active-products')?.value || 'all';
  const filtered = products.filter(p => {
    const matchesSearch = productMatchesSearch(p, q);
    const matchesCategory = !categoryFilter || (p.categoria || 'maquina') === categoryFilter;
    const matchesActive = productMatchesActiveFilter(p, activeFilter);
    return matchesSearch && matchesCategory && matchesActive;
  });
  const tbody = document.getElementById('prod-tbody');
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Nenhum produto encontrado.</td></tr>'; return; }
  tbody.innerHTML = filtered.map(p => {
    const active = isProductActive(p);
    const safeName = escapeHtml(p.nome || 'Produto');
    return `<tr class="${active ? '' : 'product-row-inactive'}">
    <td>${thumbHTML(p)}</td>
    <td><strong>${safeName}</strong><div class="admin-product-meta" data-product-id="${p.id}"></div></td>
    <td>${categoryHTML(p)}</td>
    <td>${productActiveStatusHTML(p)}</td>
    <td>${codesHTML(p)}</td>
    <td>${qtyCellHTML(p)}</td>
    <td>${p.minimo || 0}</td>
    <td><div class="action-cell">
      ${active ? `<button class="btn-baixa" onclick="openBaixaPanel(${p.id})">Baixa</button>` : '<button class="btn-baixa" disabled title="Produto inativo">Baixa</button>'}
      <button class="btn-product-status ${active ? 'deactivate' : 'reactivate'}" onclick="openProductStatusModal(${p.id}, ${!active}, 'products')">${active ? 'Inativar' : 'Reativar'}</button>
      <button class="btn-edit" onclick="editProduct(${p.id})">Editar</button>
      <button class="btn-delete" onclick="openDeleteModal(${p.id})">Excluir</button>
    </div></td>
  </tr>`;
  }).join('');
  renderProductMetadata(tbody, filtered);
}
function updateStats() {
  const activeProducts = products.filter(isProductActive);
  document.getElementById('stat-total').textContent = activeProducts.length;
  document.getElementById('stat-ok').textContent = activeProducts.filter(p => getStatus(p).cls === 'ok').length;
  document.getElementById('stat-low').textContent = activeProducts.filter(p => getStatus(p).cls === 'low').length;
  document.getElementById('stat-out').textContent = activeProducts.filter(p => getStatus(p).cls === 'out').length;
  document.getElementById('stat-inactive').textContent = products.length - activeProducts.length;
}

function toggleVoltagem(e) {
  const checked = e.target.checked;
  document.getElementById('codes-simple-wrap').classList.toggle('visible', !checked);
  document.getElementById('codes-voltage-wrap').classList.toggle('visible', checked);
  document.getElementById('qty-simple-wrap').classList.toggle('visible', !checked);
  document.getElementById('qty-voltage-wrap').classList.toggle('visible', checked);
  document.getElementById('p-futura-voltage-target').hidden = !checked;
  document.querySelectorAll('input[name="p-futura-voltage"]').forEach(input => { input.checked = false; });
  setFuturaFeedback('');
}

function inputText(id) {
  return document.getElementById(id).value.trim();
}

function formatVoltageCodes(code110, code220) {
  return [
    code110 ? `${code110} (110V)` : '',
    code220 ? `${code220} (220V)` : ''
  ].filter(Boolean).join(' - ') || null;
}

function extractVoltageCode(value, voltage) {
  const text = String(value || '');
  const beforeMarker = new RegExp(`([a-z0-9][a-z0-9./-]*)\\s*\\(\\s*${voltage}\\s*v?\\s*\\)`, 'i');
  const afterMarker = new RegExp(`${voltage}\\s*v?\\s*[:=-]?\\s*([a-z0-9][a-z0-9./-]*)`, 'i');
  return text.match(beforeMarker)?.[1] || text.match(afterMarker)?.[1] || '';
}

const FUTURA_HEADER_NAMES = {
  codigoInterno: new Set(['codinterno', 'codigointerno']),
  referencia: new Set(['ref', 'referencia', 'codreferencia', 'coddereferencia', 'codigoreferencia', 'codigodereferencia']),
  codigoBarras: new Set(['codbarra', 'codbarras', 'coddebarra', 'coddebarras', 'codigobarra', 'codigobarras', 'codigodebarra', 'codigodebarras'])
};

function futuraHeaderInfo(row) {
  const normalized = row.map(normalizeHeader);
  const indexes = {};
  let recognizedColumns = 0;

  Object.entries(FUTURA_HEADER_NAMES).forEach(([field, acceptedNames]) => {
    indexes[field] = normalized
      .map((value, index) => acceptedNames.has(value) ? index : -1)
      .filter(index => index >= 0);
    recognizedColumns += indexes[field].length;
  });

  if (!recognizedColumns) return { status: 'none' };
  const hasDuplicate = Object.values(indexes).some(matches => matches.length > 1);
  if (hasDuplicate || indexes.codigoInterno.length !== 1 || indexes.codigoBarras.length !== 1 || indexes.referencia.length > 1) {
    return { status: 'invalid' };
  }

  return {
    status: 'valid',
    format: indexes.referencia.length === 1 ? 'grade' : 'simple',
    codigoInternoIndex: indexes.codigoInterno[0],
    referenciaIndex: indexes.referencia[0] ?? -1,
    codigoBarrasIndex: indexes.codigoBarras[0]
  };
}

function isHeaderlessGridRow(row) {
  return row.length >= 3 && /^\d+$/.test(row[2]);
}

function parseFuturaCodes(value) {
  const text = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  const lines = text.split('\n').filter(line => line.trim() !== '');

  if (!lines.length) throw new Error('Cole uma linha do Futura antes de preencher.');
  if (lines.length > 2) throw new Error('Cole somente uma linha de dados, com cabeçalho opcional.');

  const rows = lines.map(line => line.split('\t').map(cell => cell.trim()));
  const header = futuraHeaderInfo(rows[0]);
  let format = 'grade';
  let codigoInternoIndex = 0;
  let referenciaIndex = 1;
  let codigoBarrasIndex = 2;
  let dataRow = rows[0];

  if (lines.length === 2) {
    if (header.status === 'invalid') throw new Error('O cabeçalho do Futura está inválido, ambíguo ou incompleto.');
    if (header.status !== 'valid') throw new Error('Cole somente uma linha de dados, precedida opcionalmente pelo cabeçalho do Futura.');
    format = header.format;
    codigoInternoIndex = header.codigoInternoIndex;
    referenciaIndex = header.referenciaIndex;
    codigoBarrasIndex = header.codigoBarrasIndex;
    dataRow = rows[1];
  } else {
    if (header.status === 'valid') throw new Error('O cabeçalho foi informado sem uma linha de dados.');
    if (header.status === 'invalid') throw new Error('O cabeçalho do Futura está inválido, ambíguo ou incompleto.');
    if (!isHeaderlessGridRow(dataRow)) {
      throw new Error('Para produto simples, cole também o cabeçalho do Futura.');
    }
  }

  const requiredIndexes = [codigoInternoIndex, codigoBarrasIndex];
  if (format === 'grade') requiredIndexes.push(referenciaIndex);
  if (requiredIndexes.some(index => index < 0 || index >= dataRow.length)) {
    throw new Error('A linha de dados não contém todas as colunas exigidas pelo cabeçalho.');
  }

  const codigoInterno = dataRow[codigoInternoIndex];
  const referenciaOriginal = format === 'grade' ? dataRow[referenciaIndex] : '';
  const codigoBarras = dataRow[codigoBarrasIndex];
  if (!codigoInterno || !codigoBarras || (format === 'grade' && !referenciaOriginal)) {
    throw new Error(format === 'grade'
      ? 'Código interno, referência e código de barras devem estar preenchidos.'
      : 'Código interno e código de barras devem estar preenchidos.');
  }

  let referencia = referenciaOriginal;
  const separatorIndex = referenciaOriginal.indexOf('-');
  if (separatorIndex > 0) {
    const prefix = referenciaOriginal.slice(0, separatorIndex).trim();
    const suffix = referenciaOriginal.slice(separatorIndex + 1).trim();
    if (prefix === codigoInterno && suffix) referencia = suffix;
  }

  return { format, codigoInterno, referencia, codigoBarras };
}

function setFuturaFeedback(message, type = '') {
  const feedback = document.getElementById('p-futura-feedback');
  feedback.textContent = message;
  feedback.classList.toggle('error', type === 'error');
  feedback.classList.toggle('success', type === 'success');
}

function fillFuturaCodes() {
  const hasVoltage = document.getElementById('p-tem-voltagem').checked;
  const voltage = hasVoltage
    ? document.querySelector('input[name="p-futura-voltage"]:checked')?.value
    : null;

  if (hasVoltage && !voltage) {
    setFuturaFeedback('Escolha 110V ou 220V antes de preencher os códigos.', 'error');
    return;
  }

  let codes;
  try {
    codes = parseFuturaCodes(document.getElementById('p-futura-line').value);
  } catch (error) {
    setFuturaFeedback(error.message, 'error');
    return;
  }

  const suffix = hasVoltage ? `-${voltage}` : '';
  const fields = {
    codigoInterno: document.getElementById(`p-cod-interno${suffix}`),
    referencia: document.getElementById(`p-cod-ref${suffix}`),
    codigoBarras: document.getElementById(`p-cod-barras${suffix}`)
  };

  fields.codigoInterno.value = codes.codigoInterno;
  fields.referencia.value = codes.referencia;
  fields.codigoBarras.value = codes.codigoBarras;
  setFuturaFeedback(`Códigos ${hasVoltage ? `${voltage}V ` : ''}preenchidos. Revise antes de salvar.`, 'success');
  fields.codigoInterno.focus();
}

function resetFuturaImportHelper() {
  const input = document.getElementById('p-futura-line');
  if (input) input.value = '';
  document.querySelectorAll('input[name="p-futura-voltage"]').forEach(option => { option.checked = false; });
  setFuturaFeedback('');
  const helper = document.getElementById('p-futura-helper');
  if (helper) helper.open = false;
}

function previewImg() {
  const url = document.getElementById('p-img-url').value.trim();
  const img = document.getElementById('img-preview');
  const hint = document.getElementById('img-hint');
  if (url) { img.src = url; img.classList.add('visible'); hint.textContent = ''; }
  else { img.classList.remove('visible'); hint.textContent = 'Cole a URL de uma imagem para visualizar'; }
}

function normalizeTagLabel(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeTagKey(value) {
  return normalizeProductSearch(normalizeTagLabel(value));
}

function setTagsFeedback(message, isError) {
  const feedback = document.getElementById('p-tags-feedback');
  feedback.textContent = message;
  feedback.classList.toggle('error', !!isError);
}

function renderProductTagsInput() {
  const list = document.getElementById('p-tags-list');
  const input = document.getElementById('p-tags-input');
  list.replaceChildren();

  productTags.forEach((tag, index) => {
    const chip = document.createElement('span');
    chip.className = 'tag-chip';

    const label = document.createElement('span');
    label.textContent = tag;

    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'tag-chip-remove';
    removeButton.setAttribute('aria-label', `Remover tag ${tag}`);
    removeButton.textContent = '×';
    removeButton.addEventListener('click', () => {
      productTags.splice(index, 1);
      renderProductTagsInput();
      input.focus();
    });

    chip.append(label, removeButton);
    list.appendChild(chip);
  });
}

function addProductTags(value) {
  const input = document.getElementById('p-tags-input');
  const candidates = String(value || '').split(',');
  const existingKeys = new Set(productTags.map(normalizeTagKey));
  let rejectedHtml = false;
  let reachedLimit = false;

  candidates.forEach(candidate => {
    const tag = normalizeTagLabel(candidate);
    if (!tag) return;
    if (/[<>]/.test(tag)) {
      rejectedHtml = true;
      return;
    }
    const key = normalizeTagKey(tag);
    if (existingKeys.has(key)) return;
    if (productTags.length >= PRODUCT_TAG_LIMIT) {
      reachedLimit = true;
      return;
    }
    existingKeys.add(key);
    productTags.push(tag);
  });

  input.value = '';
  renderProductTagsInput();
  if (rejectedHtml) setTagsFeedback('Tags não podem conter < ou >.', true);
  else if (reachedLimit) setTagsFeedback('Limite de 10 tags por produto.', true);
  else setTagsFeedback('Até 10 tags. Separe por vírgula ou Enter.', false);
}

function setProductTags(tags) {
  productTags = [];
  const input = document.getElementById('p-tags-input');
  if (Array.isArray(tags)) {
    const existingKeys = new Set();
    tags.forEach(value => {
      const tag = normalizeTagLabel(value);
      const key = normalizeTagKey(tag);
      if (!tag || /[<>]/.test(tag) || existingKeys.has(key) || productTags.length >= PRODUCT_TAG_LIMIT) return;
      existingKeys.add(key);
      productTags.push(tag);
    });
  }
  input.value = '';
  renderProductTagsInput();
  setTagsFeedback('Até 10 tags. Separe por vírgula ou Enter.', false);
}

function initProductTagsInput() {
  const input = document.getElementById('p-tags-input');
  if (!input || input.dataset.ready === 'true') return;
  input.dataset.ready = 'true';

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addProductTags(input.value);
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) addProductTags(input.value);
  });
  input.addEventListener('paste', event => {
    const pastedText = event.clipboardData?.getData('text') || '';
    if (!pastedText.includes(',')) return;
    event.preventDefault();
    addProductTags(pastedText);
  });
  renderProductTagsInput();
}

async function saveProduct() {
  const nome = document.getElementById('p-nome').value.trim();
  if (!nome) { alert('Nome do produto é obrigatório.'); return; }
  const temVoltagem = document.getElementById('p-tem-voltagem').checked;
  const fornecedorStatus = document.getElementById('p-fornecedor-status').value;
  const fornecedorObservacao = document.getElementById('p-fornecedor-obs').value.trim();
  if (!isValidSupplierStatus(fornecedorStatus)) {
    alert('Situação do fornecedor inválida.');
    return;
  }
  if (fornecedorStatus !== 'normal' && !fornecedorObservacao) {
    alert('Informe a observação do fornecedor para atenção ou em falta.');
    document.getElementById('p-fornecedor-obs').focus();
    return;
  }

  const legacyCodes = {
    fabricante: inputText('p-cod-fab'),
    interno: inputText('p-cod-interno'),
    referencia: inputText('p-cod-ref'),
    barras: inputText('p-cod-barras')
  };
  const voltageCodes = {
    fabricante110: inputText('p-cod-fab-110'),
    fabricante220: inputText('p-cod-fab-220'),
    interno110: inputText('p-cod-interno-110'),
    interno220: inputText('p-cod-interno-220'),
    referencia110: inputText('p-cod-ref-110'),
    referencia220: inputText('p-cod-ref-220'),
    barras110: inputText('p-cod-barras-110'),
    barras220: inputText('p-cod-barras-220')
  };

  const body = {
    nome,
    categoria: document.getElementById('p-categoria').value || 'maquina',
    tem_voltagem: temVoltagem,
    observacoes: document.getElementById('p-obs').value.trim() || null,
    tags: productTags.slice(),
    fornecedor_status: fornecedorStatus,
    fornecedor_observacao: fornecedorStatus === 'normal' ? null : fornecedorObservacao,
    imagem_url: document.getElementById('p-img-url').value.trim() || null
  };

  if (temVoltagem) {
    body.codigo_fabricante_110v = voltageCodes.fabricante110 || null;
    body.codigo_fabricante_220v = voltageCodes.fabricante220 || null;
    body.codigo_interno_110v = voltageCodes.interno110 || null;
    body.codigo_interno_220v = voltageCodes.interno220 || null;
    body.codigo_referencia_110v = voltageCodes.referencia110 || null;
    body.codigo_referencia_220v = voltageCodes.referencia220 || null;
    body.codigo_barras_110v = voltageCodes.barras110 || null;
    body.codigo_barras_220v = voltageCodes.barras220 || null;
    body.codigo_fabricante = formatVoltageCodes(voltageCodes.fabricante110, voltageCodes.fabricante220);
    body.codigo_interno = formatVoltageCodes(voltageCodes.interno110, voltageCodes.interno220) || legacyCodes.interno || null;
    body.codigo_referencia = formatVoltageCodes(voltageCodes.referencia110, voltageCodes.referencia220) || legacyCodes.referencia || null;
    body.sku = formatVoltageCodes(voltageCodes.barras110, voltageCodes.barras220) || legacyCodes.barras || null;
    body.quantidade_110v = parseInt(document.getElementById('p-qty-110').value) || 0;
    body.quantidade_220v = parseInt(document.getElementById('p-qty-220').value) || 0;
    body.quantidade = 0;
    body.minimo = parseInt(document.getElementById('p-min-volt').value) || 0;
  } else {
    body.codigo_fabricante = legacyCodes.fabricante || null;
    body.codigo_interno = legacyCodes.interno || null;
    body.codigo_referencia = legacyCodes.referencia || null;
    body.sku = legacyCodes.barras || null;
    body.codigo_fabricante_110v = null;
    body.codigo_fabricante_220v = null;
    body.codigo_interno_110v = null;
    body.codigo_interno_220v = null;
    body.codigo_referencia_110v = null;
    body.codigo_referencia_220v = null;
    body.codigo_barras_110v = null;
    body.codigo_barras_220v = null;
    body.quantidade = parseInt(document.getElementById('p-qty').value) || 0;
    body.minimo = parseInt(document.getElementById('p-min').value) || 0;
    body.quantidade_110v = 0;
    body.quantidade_220v = 0;
  }

  const editId = document.getElementById('p-edit-id').value;
  const { error } = editId
    ? await sb.from('produtos').update(body).eq('id', editId)
    : await sb.from('produtos').insert(body);
  if (error) {
    console.error('Falha ao salvar produto', error);
    alert(`Não foi possível salvar o produto: ${error.message}`);
    return;
  }
  clearForm();
  showSuccess('Produto salvo com sucesso!');
  await loadProducts();
}

function editProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  resetFuturaImportHelper();
  document.getElementById('p-nome').value = p.nome;
  document.getElementById('p-categoria').value = p.categoria || 'maquina';
  document.getElementById('p-cod-fab').value = p.codigo_fabricante || '';
  document.getElementById('p-cod-interno').value = p.codigo_interno || '';
  document.getElementById('p-cod-ref').value = p.codigo_referencia || '';
  document.getElementById('p-cod-barras').value = p.sku || '';
  document.getElementById('p-obs').value = p.observacoes || '';
  setProductTags(p.tags);
  document.getElementById('p-fornecedor-status').value = isValidSupplierStatus(p.fornecedor_status) ? p.fornecedor_status : 'normal';
  document.getElementById('p-fornecedor-obs').value = p.fornecedor_observacao || '';
  document.getElementById('p-img-url').value = p.imagem_url || '';

  const cb = document.getElementById('p-tem-voltagem');
  cb.checked = !!p.tem_voltagem;
  toggleVoltagem({ target: cb });

  if (p.tem_voltagem) {
    document.getElementById('p-cod-fab-110').value = p.codigo_fabricante_110v || extractVoltageCode(p.codigo_fabricante, '110');
    document.getElementById('p-cod-fab-220').value = p.codigo_fabricante_220v || extractVoltageCode(p.codigo_fabricante, '220');
    document.getElementById('p-cod-interno-110').value = p.codigo_interno_110v || extractVoltageCode(p.codigo_interno, '110');
    document.getElementById('p-cod-interno-220').value = p.codigo_interno_220v || extractVoltageCode(p.codigo_interno, '220');
    document.getElementById('p-cod-ref-110').value = p.codigo_referencia_110v || extractVoltageCode(p.codigo_referencia, '110');
    document.getElementById('p-cod-ref-220').value = p.codigo_referencia_220v || extractVoltageCode(p.codigo_referencia, '220');
    document.getElementById('p-cod-barras-110').value = p.codigo_barras_110v || extractVoltageCode(p.sku, '110');
    document.getElementById('p-cod-barras-220').value = p.codigo_barras_220v || extractVoltageCode(p.sku, '220');
    document.getElementById('p-qty-110').value = p.quantidade_110v || 0;
    document.getElementById('p-qty-220').value = p.quantidade_220v || 0;
    document.getElementById('p-min-volt').value = p.minimo || 0;
  } else {
    document.getElementById('p-qty').value = p.quantidade;
    document.getElementById('p-min').value = p.minimo || 0;
  }

  document.getElementById('p-edit-id').value = id;
  document.getElementById('form-title').textContent = 'Editar produto';
  document.getElementById('btn-cancel-edit').style.display = 'inline-block';
  previewImg();
  switchTab('produtos');
  document.getElementById('p-nome').focus();
}

function cancelEdit() { clearForm(); }
function clearForm() {
  ['p-nome','p-cod-fab','p-cod-interno','p-cod-ref','p-cod-barras',
    'p-cod-fab-110','p-cod-fab-220','p-cod-interno-110','p-cod-interno-220',
    'p-cod-ref-110','p-cod-ref-220','p-cod-barras-110','p-cod-barras-220',
    'p-qty','p-min','p-qty-110','p-qty-220','p-min-volt','p-obs','p-fornecedor-obs','p-img-url','p-edit-id'
  ].forEach(id => document.getElementById(id).value = '');
  document.getElementById('p-categoria').value = 'maquina';
  document.getElementById('p-fornecedor-status').value = 'normal';
  setProductTags([]);
  resetFuturaImportHelper();
  const cb = document.getElementById('p-tem-voltagem');
  cb.checked = false;
  toggleVoltagem({ target: cb });
  document.getElementById('form-title').textContent = 'Cadastrar produto';
  document.getElementById('btn-cancel-edit').style.display = 'none';
  document.getElementById('img-preview').classList.remove('visible');
  document.getElementById('img-hint').textContent = 'Cole a URL de uma imagem para visualizar';
}
function showSuccess(msg) {
  const el = document.getElementById('form-success');
  el.textContent = msg;
  setTimeout(() => el.textContent = '', 3000);
}

function openProductStatusModal(id, targetActive, origin) {
  const productId = id;
  const validOrigin = Object.prototype.hasOwnProperty.call(PRODUCT_STATUS_FOCUS_TARGETS, origin);
  if (!Number.isInteger(productId) || productId <= 0 || typeof targetActive !== 'boolean' || !validOrigin) return;

  const product = products.find(item => Number(item.id) === productId);
  if (!product || isProductActive(product) === targetActive) return;

  productStatusTarget = { productId, targetActive, origin };
  const modal = document.getElementById('product-status-modal');
  const reasonWrap = document.getElementById('product-status-reason-wrap');
  const reason = document.getElementById('product-status-reason');
  const confirmButton = document.getElementById('product-status-confirm');

  productStatusPreviousFocus = document.activeElement;
  document.getElementById('product-status-name').textContent = product.nome || 'Produto';
  document.getElementById('product-status-destination').textContent = targetActive ? 'reativar' : 'inativar';
  document.getElementById('product-status-error').textContent = '';
  reason.value = '';
  reasonWrap.hidden = targetActive;
  reason.required = !targetActive;
  reason.setAttribute('aria-required', String(!targetActive));
  confirmButton.textContent = targetActive ? 'Reativar produto' : 'Inativar produto';
  confirmButton.classList.toggle('product-status-confirm-reactivate', targetActive);
  confirmButton.classList.toggle('product-status-confirm-deactivate', !targetActive);
  modal.classList.add('open');

  requestAnimationFrame(() => {
    (targetActive ? confirmButton : reason).focus();
  });
}

function closeProductStatusModal(restorePreviousFocus = true) {
  if (productStatusBusy) return;
  document.getElementById('product-status-modal').classList.remove('open');
  document.getElementById('product-status-error').textContent = '';
  document.getElementById('product-status-reason').value = '';
  productStatusTarget = null;
  if (restorePreviousFocus && productStatusPreviousFocus instanceof HTMLElement && productStatusPreviousFocus.isConnected) {
    productStatusPreviousFocus.focus();
  }
  productStatusPreviousFocus = null;
}

function focusProductStatusOrigin(origin) {
  if (!Object.prototype.hasOwnProperty.call(PRODUCT_STATUS_FOCUS_TARGETS, origin)) return;
  document.getElementById(PRODUCT_STATUS_FOCUS_TARGETS[origin])?.focus();
}

function getProductStatusModalFocusableElements() {
  const modal = document.querySelector('#product-status-modal .product-status-modal');
  if (!modal) return [];
  return Array.from(modal.querySelectorAll('button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter(element => element.offsetParent !== null);
}

async function confirmProductStatusChange() {
  if (productStatusBusy || !productStatusTarget) return;

  const { productId, targetActive, origin } = productStatusTarget;
  const errorElement = document.getElementById('product-status-error');
  const confirmButton = document.getElementById('product-status-confirm');
  const cancelButton = document.getElementById('product-status-cancel');
  const motivo = document.getElementById('product-status-reason').value.trim();

  if (
    !Number.isInteger(productId) ||
    productId <= 0 ||
    typeof targetActive !== 'boolean' ||
    !Object.prototype.hasOwnProperty.call(PRODUCT_STATUS_FOCUS_TARGETS, origin)
  ) {
    errorElement.textContent = 'Não foi possível validar o produto selecionado.';
    return;
  }
  if (!targetActive && !motivo) {
    errorElement.textContent = 'Informe o motivo da inativação.';
    document.getElementById('product-status-reason').focus();
    return;
  }

  productStatusBusy = true;
  confirmButton.disabled = true;
  cancelButton.disabled = true;
  errorElement.textContent = '';

  let rpcData;
  let statusProcessed = false;
  try {
    const { data, error } = await sb.rpc('alterar_status_produto', {
      p_produto_id: productId,
      p_ativo: targetActive,
      p_motivo: targetActive ? null : motivo
    });

    if (error) {
      errorElement.textContent = error.message || 'Não foi possível alterar o status do produto.';
      return;
    }

    rpcData = data;
    statusProcessed = true;
    await loadProducts({ throwOnError: true });
  } catch (error) {
    errorElement.textContent = statusProcessed
      ? 'O status foi processado, mas não foi possível atualizar a lista. Verifique a conexão e tente recarregar.'
      : (error?.message || 'Não foi possível alterar o status do produto.');
    return;
  } finally {
    productStatusBusy = false;
    confirmButton.disabled = false;
    cancelButton.disabled = false;
  }

  const destination = targetActive ? 'reativado' : 'inativado';
  closeProductStatusModal(false);
  focusProductStatusOrigin(origin);
  showToast(rpcData === false ? 'blue' : 'green', rpcData === false
    ? `O produto já estava ${destination}.`
    : `Produto ${destination} com sucesso.`);
}

document.addEventListener('keydown', event => {
  const modal = document.getElementById('product-status-modal');
  if (!modal?.classList.contains('open')) return;

  if (event.key === 'Escape') {
    if (!productStatusBusy) closeProductStatusModal();
    return;
  }

  if (event.key === 'Tab') {
    const focusableElements = getProductStatusModalFocusableElements();
    if (!focusableElements.length) {
      event.preventDefault();
      return;
    }

    const first = focusableElements[0];
    const last = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && (document.activeElement === first || !modal.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !modal.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }
});

function openDeleteModal(id) { deleteTargetId = id; document.getElementById('delete-modal').classList.add('open'); }
function closeDeleteModal() { deleteTargetId = null; document.getElementById('delete-modal').classList.remove('open'); }
async function confirmDelete() {
  if (!deleteTargetId) return;
  await sb.from('produtos').delete().eq('id', deleteTargetId);
  closeDeleteModal();
  await loadProducts();
}

function flattenNuvemshopCatalog(remoteProducts, links) {
  const rows = [];
  remoteProducts.forEach(remoteProduct => {
    const variants = Array.isArray(remoteProduct.variants) && remoteProduct.variants.length
      ? remoteProduct.variants
      : [{ id: null, product_id: remoteProduct.id, sku: remoteProduct.sku, barcode: remoteProduct.barcode, stock: remoteProduct.stock, stock_management: remoteProduct.stock_management, values: [] }];

    variants.forEach(variant => {
      const productId = Number(remoteProduct.id);
      const variantId = variant.id == null ? null : Number(variant.id);
      const savedLink = links.find(link => {
        if (Number(link.nuvemshop_produto_id) !== productId) return false;
        if (link.nuvemshop_variante_id != null) {
          return Number(link.nuvemshop_variante_id) === variantId;
        }
        return variants.length === 1;
      });
      const linkedProduct = savedLink ? products.find(product => product.id === savedLink.produto_id) : null;
      const candidates = savedLink ? [] : findExactLocalCandidates(variant);
      const localProduct = linkedProduct || (candidates.length === 1 ? candidates[0] : null);
      const status = linkedProduct ? 'linked' : candidates.length === 1 ? 'matched' : candidates.length > 1 ? 'ambiguous' : 'unmatched';
      const variantLabel = remoteVariantLabel(variant);
      const remoteName = translatedValue(remoteProduct.name) || `Produto ${productId}`;
      const inferredVoltage = inferVoltage(variantLabel) || inferVoltage(remoteName);
      const localVoltage = localProduct?.tem_voltagem ? (savedLink?.voltagem || inferredVoltage) : null;
      const image = Array.isArray(remoteProduct.images) ? remoteProduct.images[0]?.src : null;
      const unitsSuggestion = inferUnitsPerSale({
        variantLabel,
        remoteName,
        sku: variant.sku || ''
      });
      const unitsPerSale = validUnitsPerSale(savedLink?.unidades_por_venda) || unitsSuggestion.value;

      rows.push({
        status,
        productId,
        variantId,
        remoteName,
        variantLabel,
        sku: variant.sku || '',
        barcode: variant.barcode || '',
        remoteStock: remoteVariantStock(variant),
        image,
        localProduct,
        candidates,
        localStock: mappedLocalStock(localProduct, localVoltage),
        linkVoltage: localVoltage,
        savedLinkId: savedLink?.id || null,
        unitsPerSale,
        unitsSuggestion
      });
    });
  });
  return rows;
}

function setNuvemshopConnectionState(state, text) {
  const connectionText = document.getElementById('nuvemshop-connection-text');
  const connectionDot = document.querySelector('.nuvemshop-connection-dot');
  if (connectionText) connectionText.textContent = text;
  if (connectionDot) {
    connectionDot.className = `nuvemshop-connection-dot${state && state !== 'ready' ? ` ${state}` : ''}`;
  }
}

function isPositiveNuvemshopId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function buildNuvemshopBrokenLinks(remoteProducts, links) {
  const remoteProductsById = new Map();
  (Array.isArray(remoteProducts) ? remoteProducts : []).forEach(product => {
    const productId = Number(product?.id);
    if (isPositiveNuvemshopId(productId)) remoteProductsById.set(productId, product);
  });

  return (Array.isArray(links) ? links : []).flatMap(link => {
    const linkId = Number(link?.id);
    const storeId = Number(link?.store_id);
    const externalProductId = Number(link?.nuvemshop_produto_id);
    const externalVariantId = link?.nuvemshop_variante_id == null
      ? null
      : Number(link.nuvemshop_variante_id);
    if (
      !isPositiveNuvemshopId(linkId)
      || !isPositiveNuvemshopId(storeId)
      || !isPositiveNuvemshopId(externalProductId)
      || (externalVariantId !== null && !isPositiveNuvemshopId(externalVariantId))
    ) return [];

    const remoteProduct = remoteProductsById.get(externalProductId);
    if (!remoteProduct) {
      return [{
        linkId,
        storeId,
        produtoId: Number(link.produto_id),
        externalProductId,
        externalVariantId,
        reason: 'Produto externo nao localizado no catalogo.',
      }];
    }
    if (externalVariantId === null) return [];

    const variants = Array.isArray(remoteProduct.variants) ? remoteProduct.variants : [];
    const variantExists = variants.some(variant => Number(variant?.id) === externalVariantId);
    return variantExists ? [] : [{
      linkId,
      storeId,
      produtoId: Number(link.produto_id),
      externalProductId,
      externalVariantId,
      reason: 'Variante externa nao localizada no catalogo.',
    }];
  });
}

function rebuildNuvemshopCatalogRows() {
  nuvemshopCatalogRows = flattenNuvemshopCatalog(nuvemshopRemoteProducts, nuvemshopActiveLinks);
  nuvemshopBrokenLinks = buildNuvemshopBrokenLinks(nuvemshopRemoteProducts, nuvemshopActiveLinks);
}

function clearNuvemshopPreviewAfterLinkChange() {
  nuvemshopPreviewGenerated = false;
  nuvemshopPreviewGeneratedAt = null;
  nuvemshopServerSimulation = null;
  nuvemshopPilotReadiness = null;
  nuvemshopPilotSelectedItemId = null;
  nuvemshopBatchSelectedItemIds = [];
  nuvemshopPilotApplicationLocked = false;
  const preview = document.getElementById('nuvemshop-sync-preview');
  if (preview) preview.style.display = 'none';
}

function selectedNuvemshopStoreId() {
  const selectedStoreId = Number(document.getElementById('nuvemshop-store-select')?.value);
  return NUVEMSHOP_STORES.some(store => store.id === selectedStoreId)
    ? selectedStoreId
    : null;
}

function hasConfirmedNuvemshopStockLocation() {
  const localId = nuvemshopStockLocation?.local?.id;
  return nuvemshopStockLocation?.status === 'unico' &&
    localId != null &&
    String(localId).trim() !== '';
}

function updateNuvemshopPreviewAvailability() {
  const previewButton = document.getElementById('nuvemshop-preview-btn');
  if (!previewButton) return;

  const canGeneratePreview = nuvemshopCatalogLoaded &&
    !nuvemshopCatalogLoading &&
    hasConfirmedNuvemshopStockLocation();
  previewButton.disabled = !canGeneratePreview;
  previewButton.title = canGeneratePreview
    ? ''
    : 'Confirme o local de estoque desta loja antes de gerar a previa.';
}

function resetNuvemshopCatalogForStoreChange() {
  nuvemshopCatalogRequestId += 1;
  nuvemshopCatalogRows = [];
  nuvemshopRemoteProducts = [];
  nuvemshopActiveLinks = [];
  nuvemshopBrokenLinks = [];
  nuvemshopCatalogLoaded = false;
  nuvemshopCatalogLoading = false;
  nuvemshopCatalogError = false;
  nuvemshopCatalogPage = 1;
  nuvemshopStoreId = null;
  nuvemshopStockLocation = null;
  nuvemshopPreviewGenerated = false;
  nuvemshopPreviewGeneratedAt = null;
  nuvemshopServerSimulation = null;
  nuvemshopPilotReadiness = null;
  nuvemshopPilotSelectedItemId = null;
  nuvemshopBatchSelectedItemIds = [];
  nuvemshopPilotApplicationLocked = false;

  const preview = document.getElementById('nuvemshop-sync-preview');
  const tableWrap = document.getElementById('nuvemshop-table-wrap');
  const pagination = document.getElementById('nuvemshop-pagination');
  const brokenLinks = document.getElementById('nuvemshop-broken-links');
  const message = document.getElementById('nuvemshop-message');
  if (preview) preview.style.display = 'none';
  if (tableWrap) tableWrap.style.display = 'none';
  if (pagination) pagination.style.display = 'none';
  if (brokenLinks) brokenLinks.style.display = 'none';
  if (message) {
    message.className = 'nuvemshop-message loading';
    message.textContent = 'Selecione uma loja para consultar o catalogo.';
    message.style.display = 'flex';
  }
  ['nuvemshop-stat-local', 'nuvemshop-stat-remote', 'nuvemshop-stat-matched', 'nuvemshop-stat-review']
    .forEach(id => {
      const element = document.getElementById(id);
      if (element) element.textContent = '-';
    });
  const listTitle = document.getElementById('nuvemshop-list-title');
  if (listTitle) listTitle.textContent = 'Catalogo externo';
  updateNuvemshopPreviewAvailability();
  renderNuvemshopWorkflow();
}

function handleNuvemshopStoreChange() {
  const select = document.getElementById('nuvemshop-store-select');
  const storeId = selectedNuvemshopStoreId();
  if (!storeId) {
    if (select) select.value = String(NUVEMSHOP_DEFAULT_STORE_ID);
    return;
  }

  resetNuvemshopCatalogForStoreChange();
  loadNuvemshopCatalog(true);
}

async function connectNewNuvemshopStore() {
  const button = document.getElementById('nuvemshop-connect-btn');
  const errorElement = document.getElementById('nuvemshop-connect-error');
  if (nuvemshopOAuthStartBusy || !button || !errorElement) return;

  nuvemshopOAuthStartBusy = true;
  button.disabled = true;
  button.textContent = 'Preparando conexao...';
  errorElement.classList.remove('nuvemshop-connect-notice');
  errorElement.textContent = '';

  try {
    const { data, error } = await sb.functions.invoke('nuvemshop-oauth-iniciar', {
      method: 'POST'
    });
    if (error || typeof data?.url !== 'string') {
      throw new Error('oauth_start_failed');
    }

    const authorizationUrl = new URL(data.url);
    const stateValues = authorizationUrl.searchParams.getAll('state');
    const queryKeys = Array.from(authorizationUrl.searchParams.keys());
    const validUrl = authorizationUrl.protocol === 'https:'
      && authorizationUrl.hostname === 'www.nuvemshop.com.br'
      && authorizationUrl.port === ''
      && authorizationUrl.username === ''
      && authorizationUrl.password === ''
      && authorizationUrl.pathname === '/apps/36716/authorize'
      && authorizationUrl.hash === ''
      && stateValues.length === 1
      && queryKeys.length === 1
      && queryKeys[0] === 'state'
      && /^[A-Za-z0-9_-]{43}$/.test(stateValues[0]);
    if (!validUrl) throw new Error('oauth_start_invalid_url');

    window.location.assign(authorizationUrl.toString());
  } catch {
    errorElement.textContent = 'Nao foi possivel iniciar a conexao. Tente novamente.';
  } finally {
    nuvemshopOAuthStartBusy = false;
    button.disabled = false;
    button.textContent = 'Conectar nova loja';
  }
}

function setNuvemshopWorkflowStep(id, state, status) {
  const step = document.getElementById(`nuvemshop-flow-${id}`);
  const statusElement = document.getElementById(`nuvemshop-flow-${id}-status`);
  if (!step || !statusElement) return;
  step.className = `nuvemshop-workflow-step ${state}`;
  statusElement.textContent = status;
  if (state === 'current') step.setAttribute('aria-current', 'step');
  else step.removeAttribute('aria-current');
}

function renderNuvemshopWorkflow() {
  const catalogReady = nuvemshopCatalogLoaded;
  const locationConfirmed = catalogReady && hasConfirmedNuvemshopStockLocation();
  const previewReady = locationConfirmed && nuvemshopPreviewGenerated;
  const validationReady = previewReady && Boolean(nuvemshopServerSimulation?.auditoria_id);
  const pilotChecked = validationReady && Boolean(nuvemshopPilotReadiness);
  const previewCount = previewReady ? buildNuvemshopSyncPreviewRows().length : 0;

  const catalogState = nuvemshopCatalogError
    ? 'error'
    : catalogReady && !nuvemshopCatalogLoading ? 'complete' : 'current';
  const catalogStatus = nuvemshopCatalogError
    ? 'Falha na consulta'
    : nuvemshopCatalogLoading
      ? 'Consultando...'
      : catalogReady ? `${nuvemshopCatalogRows.length} variantes` : 'Aguardando consulta';
  setNuvemshopWorkflowStep('catalog', catalogState, catalogStatus);

  setNuvemshopWorkflowStep(
    'preview',
    previewReady ? 'complete' : locationConfirmed ? 'current' : 'pending',
    previewReady
      ? `${previewCount} vinculos`
      : locationConfirmed
        ? 'Pronta para gerar'
        : catalogReady ? 'Aguardando local confirmado' : 'Pendente'
  );
  setNuvemshopWorkflowStep(
    'validation',
    validationReady ? 'complete' : previewReady ? 'current' : 'pending',
    validationReady ? 'Concluida com seguranca' : previewReady ? 'Aguardando validacao' : 'Pendente'
  );

  let pilotState = validationReady ? 'current' : 'pending';
  let pilotStatus = validationReady ? 'Aguardando verificacao' : 'Pendente';
  if (pilotChecked) {
    const protectionsReady = nuvemshopPilotReadiness?.requisitos_atendidos === true;
    pilotState = protectionsReady ? 'complete' : 'warning';
    pilotStatus = protectionsReady ? 'Protecoes conferidas' : 'Protecoes pendentes';
  }
  setNuvemshopWorkflowStep('pilot', pilotState, pilotStatus);
}

async function loadNuvemshopCatalog(force = false) {
  const selectedStoreId = selectedNuvemshopStoreId();
  if (!selectedStoreId) {
    const message = document.getElementById('nuvemshop-message');
    if (message) {
      message.className = 'nuvemshop-message error';
      message.textContent = 'Selecione uma loja Nuvemshop valida para consultar o catalogo.';
      message.style.display = 'flex';
    }
    return;
  }
  if (nuvemshopCatalogLoaded && nuvemshopStoreId === selectedStoreId && !force) return;

  const requestId = ++nuvemshopCatalogRequestId;
  const button = document.getElementById('nuvemshop-refresh-btn');
  const message = document.getElementById('nuvemshop-message');
  const tableWrap = document.getElementById('nuvemshop-table-wrap');
  const pagination = document.getElementById('nuvemshop-pagination');
  nuvemshopCatalogLoading = true;
  nuvemshopCatalogError = false;
  button.disabled = true;
  button.textContent = 'Consultando...';
  message.className = 'nuvemshop-message loading';
  message.textContent = 'Consultando catalogo da Nuvemshop...';
  message.style.display = 'flex';
  tableWrap.style.display = 'none';
  pagination.style.display = 'none';
  setNuvemshopConnectionState('loading', 'Consultando catalogo e local de estoque...');
  nuvemshopServerSimulation = null;
  nuvemshopPilotReadiness = null;
  nuvemshopPilotSelectedItemId = null;
  updateNuvemshopPreviewAvailability();
  renderNuvemshopWorkflow();

  try {
    const { data, error } = await sb.functions.invoke(`nuvemshop-catalogo?store_id=${selectedStoreId}`, { method: 'GET' });
    if (requestId !== nuvemshopCatalogRequestId) return;
    if (error) throw error;
    if (Number(data?.store_id) !== selectedStoreId) {
      throw new Error('A consulta retornou uma loja Nuvemshop inesperada.');
    }
    const linksResult = await sb.from('nuvemshop_vinculos')
      .select('*')
      .eq('store_id', selectedStoreId)
      .eq('ativo', true);
    if (requestId !== nuvemshopCatalogRequestId) return;
    if (linksResult.error) throw linksResult.error;
    if (!Array.isArray(data?.produtos)) throw new Error('Catalogo em formato inesperado.');

    nuvemshopStoreId = selectedStoreId;
    nuvemshopStockLocation = data.estoque_local || null;
    nuvemshopRemoteProducts = data.produtos;
    nuvemshopActiveLinks = linksResult.data || [];
    rebuildNuvemshopCatalogRows();
    nuvemshopCatalogLoaded = true;
    if (nuvemshopPreviewGenerated) nuvemshopPreviewGeneratedAt = new Date();
    renderNuvemshopCatalog();
  } catch (error) {
    if (requestId !== nuvemshopCatalogRequestId) return;
    console.error('Falha ao consultar Nuvemshop', error);
    nuvemshopCatalogError = true;
    setNuvemshopConnectionState('error', 'Falha ao consultar a Nuvemshop');
    message.className = 'nuvemshop-message error';
    message.textContent = 'Nao foi possivel consultar o catalogo. Confira os logs da funcao nuvemshop-catalogo.';
    message.style.display = 'flex';
  } finally {
    if (requestId !== nuvemshopCatalogRequestId) return;
    nuvemshopCatalogLoading = false;
    button.disabled = false;
    button.textContent = 'Atualizar catalogo';
    updateNuvemshopPreviewAvailability();
    renderNuvemshopWorkflow();
  }
}

function renderNuvemshopCatalog() {
  const statusFilter = document.getElementById('nuvemshop-filter-status')?.value || '';
  const search = normalizeCode(document.getElementById('nuvemshop-search')?.value || '');
  const filtered = nuvemshopCatalogRows.filter(row => {
    const matchesStatus = !statusFilter || row.status === statusFilter;
    const haystack = normalizeCode([
      row.remoteName,
      row.variantLabel,
      row.sku,
      row.barcode,
      row.localProduct?.nome,
      ...row.candidates.map(candidate => candidate.nome)
    ].filter(Boolean).join(' '));
    return matchesStatus && (!search || haystack.includes(search));
  });

  const identified = nuvemshopCatalogRows.filter(row => row.status === 'linked' || row.status === 'matched').length;
  const review = nuvemshopCatalogRows.length - identified;
  document.getElementById('nuvemshop-stat-local').textContent = products.length;
  document.getElementById('nuvemshop-stat-remote').textContent = nuvemshopCatalogRows.length;
  document.getElementById('nuvemshop-stat-matched').textContent = identified;
  document.getElementById('nuvemshop-stat-review').textContent = review;
  document.getElementById('nuvemshop-list-title').textContent = `Catalogo externo - loja ${nuvemshopStoreId || ''}`;
  if (nuvemshopStockLocation?.status === 'unico') {
    setNuvemshopConnectionState('ready', `Somente leitura | Local confirmado: ${nuvemshopStockLocation.local.nome}`);
  } else if (nuvemshopStockLocation?.status === 'multiplo') {
    setNuvemshopConnectionState('warning', `${nuvemshopStockLocation.total} locais encontrados | Sincronizacao bloqueada`);
  } else if (nuvemshopStockLocation?.status === 'nao_encontrado') {
    setNuvemshopConnectionState('warning', 'Somente leitura | Nenhum local separado informado pela Nuvemshop');
  } else if (nuvemshopStockLocation?.status === 'indisponivel') {
    const httpStatus = nuvemshopStockLocation.http_status ? ` (HTTP ${nuvemshopStockLocation.http_status})` : '';
    setNuvemshopConnectionState('warning', `Somente leitura | Consulta de local indisponivel${httpStatus}`);
  } else {
    setNuvemshopConnectionState('warning', 'Somente leitura | Local de estoque ainda nao confirmado');
  }
  updateNuvemshopPreviewAvailability();
  renderNuvemshopWorkflow();
  if (nuvemshopPreviewGenerated) renderNuvemshopSyncPreview();

  const message = document.getElementById('nuvemshop-message');
  const tableWrap = document.getElementById('nuvemshop-table-wrap');
  const tbody = document.getElementById('nuvemshop-tbody');
  const pagination = document.getElementById('nuvemshop-pagination');
  message.style.display = 'none';
  tableWrap.style.display = 'block';
  renderNuvemshopBrokenLinks();

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Nenhum item encontrado para este filtro.</td></tr>';
    pagination.style.display = 'none';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / nuvemshopCatalogPageSize));
  nuvemshopCatalogPage = Math.min(Math.max(1, nuvemshopCatalogPage), totalPages);
  const startIndex = (nuvemshopCatalogPage - 1) * nuvemshopCatalogPageSize;
  const endIndex = Math.min(startIndex + nuvemshopCatalogPageSize, filtered.length);
  const visibleRows = filtered.slice(startIndex, endIndex);
  renderNuvemshopCatalogPagination(filtered.length, totalPages, startIndex, endIndex);

  const statusLabels = {
    linked: 'Vinculado',
    matched: 'Exato',
    ambiguous: 'Revisar',
    unmatched: 'Nao identificado'
  };

  tbody.innerHTML = visibleRows.map(row => {
    const image = row.image
      ? `<img src="${escapeHtml(row.image)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"><div class="nuvemshop-product-placeholder" style="display:none">Sem foto</div>`
      : '<div class="nuvemshop-product-placeholder">Sem foto</div>';
    const localDescription = row.localProduct
      ? `<div class="nuvemshop-local-name">${escapeHtml(row.localProduct.nome)}</div><div class="nuvemshop-local-meta">ID ${row.localProduct.id}${row.linkVoltage ? ` - ${escapeHtml(row.linkVoltage)}` : ''}</div>`
      : row.candidates.length > 1
        ? `<div class="nuvemshop-local-name">${row.candidates.length} produtos com o mesmo codigo</div><div class="nuvemshop-local-meta">${row.candidates.map(candidate => escapeHtml(candidate.nome)).join(' / ')}</div>`
        : '<span class="csv-muted">-</span>';
    const remoteStock = row.remoteStock == null ? 'Ilimitado' : row.remoteStock;
    const localStock = row.localStock == null ? '-' : row.localStock;
    const needsVoltage = row.localProduct?.tem_voltagem && !row.linkVoltage;
    const savedLinkId = Number(row.savedLinkId);
    const action = row.status === 'linked' && isPositiveNuvemshopId(savedLinkId)
      ? `<div class="nuvemshop-linked-actions"><div><span class="nuvemshop-link-confirmed">Confirmado</span><div class="nuvemshop-link-units">${escapeHtml(row.unitsPerSale)} un. por venda</div></div><button class="nuvemshop-unlink-btn" id="nuvemshop-unlink-${savedLinkId}" onclick="openNuvemshopLinkDeactivationModal(${savedLinkId}, 'manual', this)">Desativar vinculo</button></div>`
      : row.status === 'matched' && !needsVoltage
        ? `<button class="nuvemshop-link-btn" id="nuvemshop-link-${row.productId}-${row.variantId || 'base'}" onclick="confirmNuvemshopLink(${row.productId}, ${row.variantId ?? 'null'})">Confirmar vinculo</button>`
        : `<button class="nuvemshop-manual-btn" onclick="openManualNuvemshopLink(${row.productId}, ${row.variantId ?? 'null'})">Vincular manualmente</button>`;

    return `<tr>
      <td><span class="nuvemshop-status ${row.status}">${statusLabels[row.status]}</span></td>
      <td><div class="nuvemshop-product">${image}<div><div class="nuvemshop-product-name">${escapeHtml(row.remoteName)}</div><div class="nuvemshop-product-id">Produto ${row.productId}</div></div></div></td>
      <td><div>${escapeHtml(row.variantLabel)}</div><div class="nuvemshop-variant">Variante ${row.variantId || '-'}</div></td>
      <td><div class="code-tags">${row.sku ? `<span class="code-tag">SKU: ${escapeHtml(row.sku)}</span>` : ''}${row.barcode ? `<span class="code-tag">Barras: ${escapeHtml(row.barcode)}</span>` : ''}${!row.sku && !row.barcode ? '<span class="csv-muted">Sem codigo</span>' : ''}</div></td>
      <td><span class="nuvemshop-stock">${escapeHtml(remoteStock)}</span></td>
      <td>${localDescription}</td>
      <td><span class="nuvemshop-stock">${escapeHtml(localStock)}</span></td>
      <td>${action}</td>
    </tr>`;
  }).join('');
}

function renderNuvemshopBrokenLinks() {
  const section = document.getElementById('nuvemshop-broken-links');
  const tbody = document.getElementById('nuvemshop-broken-links-tbody');
  if (!section || !tbody) return;

  const selectedStoreId = selectedNuvemshopStoreId();
  const rows = nuvemshopBrokenLinks.filter(link => link.storeId === selectedStoreId);
  section.style.display = rows.length ? 'block' : 'none';
  tbody.replaceChildren();
  if (!rows.length) return;

  rows.forEach(link => {
    const localProduct = products.find(product => Number(product.id) === link.produtoId);
    const store = NUVEMSHOP_STORES.find(item => item.id === link.storeId);
    const tr = document.createElement('tr');
    const storeCell = document.createElement('td');
    const localCell = document.createElement('td');
    const remoteCell = document.createElement('td');
    const reasonCell = document.createElement('td');
    const actionCell = document.createElement('td');
    const button = document.createElement('button');

    storeCell.textContent = `${link.storeId} — ${store?.label || 'loja selecionada'}`;
    localCell.textContent = localProduct
      ? `${localProduct.nome} (ID ${localProduct.id})`
      : `Produto local ID ${link.produtoId}`;
    remoteCell.textContent = `Produto ${link.externalProductId}${link.externalVariantId === null ? '' : ` | Variante ${link.externalVariantId}`}`;
    reasonCell.className = 'nuvemshop-broken-reason';
    reasonCell.textContent = link.reason;
    button.type = 'button';
    button.className = 'nuvemshop-unlink-btn';
    button.textContent = 'Desativar vinculo quebrado';
    button.addEventListener('click', () => openNuvemshopLinkDeactivationModal(link.linkId, 'quebrado', button));
    actionCell.append(button);
    tr.append(storeCell, localCell, remoteCell, reasonCell, actionCell);
    tbody.append(tr);
  });
}

function handleNuvemshopCatalogFilters() {
  nuvemshopCatalogPage = 1;
  renderNuvemshopCatalog();
}

function setNuvemshopCatalogPageSize(value) {
  const pageSize = Number(value);
  if (![25, 50, 100].includes(pageSize)) return;
  nuvemshopCatalogPageSize = pageSize;
  nuvemshopCatalogPage = 1;
  renderNuvemshopCatalog();
}

function changeNuvemshopCatalogPage(direction) {
  setNuvemshopCatalogPage(nuvemshopCatalogPage + Number(direction));
}

function setNuvemshopCatalogPage(page) {
  const statusFilter = document.getElementById('nuvemshop-filter-status')?.value || '';
  const search = normalizeCode(document.getElementById('nuvemshop-search')?.value || '');
  const filteredCount = nuvemshopCatalogRows.filter(row => {
    const matchesStatus = !statusFilter || row.status === statusFilter;
    const haystack = normalizeCode([
      row.remoteName,
      row.variantLabel,
      row.sku,
      row.barcode,
      row.localProduct?.nome,
      ...row.candidates.map(candidate => candidate.nome)
    ].filter(Boolean).join(' '));
    return matchesStatus && (!search || haystack.includes(search));
  }).length;
  const totalPages = Math.max(1, Math.ceil(filteredCount / nuvemshopCatalogPageSize));
  const requestedPage = page === 'last' ? totalPages : Number(page);
  if (!Number.isFinite(requestedPage)) return;
  nuvemshopCatalogPage = Math.min(Math.max(1, requestedPage), totalPages);
  renderNuvemshopCatalog();
  document.getElementById('nuvemshop-list-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderNuvemshopCatalogPagination(totalItems, totalPages, startIndex, endIndex) {
  const pagination = document.getElementById('nuvemshop-pagination');
  const summary = document.getElementById('nuvemshop-pagination-summary');
  const pageInfo = document.getElementById('nuvemshop-page-info');
  const firstButton = document.getElementById('nuvemshop-page-first');
  const previousButton = document.getElementById('nuvemshop-page-prev');
  const nextButton = document.getElementById('nuvemshop-page-next');
  const lastButton = document.getElementById('nuvemshop-page-last');

  pagination.style.display = 'flex';
  summary.textContent = `Exibindo ${startIndex + 1}-${endIndex} de ${totalItems} itens`;
  pageInfo.textContent = `Pagina ${nuvemshopCatalogPage} de ${totalPages}`;
  firstButton.disabled = nuvemshopCatalogPage === 1;
  previousButton.disabled = nuvemshopCatalogPage === 1;
  nextButton.disabled = nuvemshopCatalogPage === totalPages;
  lastButton.disabled = nuvemshopCatalogPage === totalPages;
}

function buildNuvemshopSyncPreviewRows() {
  return nuvemshopCatalogRows
    .filter(row => row.status === 'linked' && row.localProduct)
    .map(row => {
      const destinationStock = packageDestinationStock(row.localStock, row.unitsPerSale);
      const currentStock = row.remoteStock == null ? null : Number(row.remoteStock);
      const difference = currentStock == null || destinationStock == null
        ? null
        : destinationStock - currentStock;
      const previewStatus = currentStock == null || destinationStock == null
        ? 'uncontrolled'
        : difference === 0
          ? 'equal'
          : difference > 0 ? 'increase' : 'decrease';
      return { ...row, destinationStock, currentStock, difference, previewStatus };
    })
    .sort((a, b) => {
      const priority = { increase: 0, decrease: 0, equal: 1, uncontrolled: 2 };
      const priorityDifference = priority[a.previewStatus] - priority[b.previewStatus];
      if (priorityDifference) return priorityDifference;
      const absoluteDifference = Math.abs(b.difference || 0) - Math.abs(a.difference || 0);
      return absoluteDifference || a.remoteName.localeCompare(b.remoteName, 'pt-BR');
    });
}

async function openNuvemshopSyncPreview() {
  const selectedStoreId = selectedNuvemshopStoreId();
  if (!selectedStoreId) return;
  if (!nuvemshopCatalogLoaded || nuvemshopStoreId !== selectedStoreId) await loadNuvemshopCatalog();
  if (!nuvemshopCatalogLoaded || nuvemshopStoreId !== selectedStoreId) return;
  if (!hasConfirmedNuvemshopStockLocation()) {
    alert('O local de estoque precisa estar confirmado antes de gerar a previa.');
    return;
  }

  nuvemshopPreviewGenerated = true;
  nuvemshopPreviewGeneratedAt = new Date();
  renderNuvemshopSyncPreview();
  document.getElementById('nuvemshop-sync-preview').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderNuvemshopSyncPreview() {
  if (!nuvemshopPreviewGenerated) return;
  const section = document.getElementById('nuvemshop-sync-preview');
  const allRows = buildNuvemshopSyncPreviewRows();
  const statusFilter = document.getElementById('nuvemshop-preview-filter').value;
  const search = normalizeCode(document.getElementById('nuvemshop-preview-search').value);
  const filteredRows = allRows.filter(row => {
    const matchesStatus = !statusFilter ||
      (statusFilter === 'different' && ['increase', 'decrease'].includes(row.previewStatus)) ||
      row.previewStatus === statusFilter;
    const haystack = normalizeCode([
      row.remoteName,
      row.variantLabel,
      row.sku,
      row.barcode,
      row.localProduct.nome,
      row.localProduct.id,
      row.linkVoltage
    ].filter(Boolean).join(' '));
    return matchesStatus && (!search || haystack.includes(search));
  });

  section.style.display = 'block';
  document.getElementById('nuvemshop-preview-time').textContent = nuvemshopPreviewGeneratedAt
    ? `Gerada em ${nuvemshopPreviewGeneratedAt.toLocaleString('pt-BR')}`
    : '';
  document.getElementById('nuvemshop-preview-total').textContent = allRows.length;
  document.getElementById('nuvemshop-preview-equal').textContent = allRows.filter(row => row.previewStatus === 'equal').length;
  document.getElementById('nuvemshop-preview-different').textContent = allRows.filter(row => ['increase', 'decrease'].includes(row.previewStatus)).length;
  document.getElementById('nuvemshop-preview-uncontrolled').textContent = allRows.filter(row => row.previewStatus === 'uncontrolled').length;

  const simulationButton = document.getElementById('nuvemshop-simulation-open');
  const pilotButton = document.getElementById('nuvemshop-pilot-open');
  const batchButton = document.getElementById('nuvemshop-batch-open');
  const validationText = document.getElementById('nuvemshop-preview-validation');
  const canSimulate = hasConfirmedNuvemshopStockLocation() && allRows.length > 0;
  simulationButton.disabled = !canSimulate;
  pilotButton.disabled = !nuvemshopServerSimulation;
  batchButton.disabled = !nuvemshopServerSimulation;
  if (nuvemshopServerSimulation) {
    const generatedAt = new Date(nuvemshopServerSimulation.gerado_em).toLocaleString('pt-BR');
    validationText.textContent = `Validada no servidor em ${generatedAt}. Nenhum estoque foi alterado.`;
    validationText.classList.add('valid');
  } else {
    validationText.textContent = canSimulate
      ? 'Previa ainda nao validada no servidor.'
      : 'Confirme o local e os vinculos antes da validacao.';
    validationText.classList.remove('valid');
  }
  renderNuvemshopWorkflow();

  const tbody = document.getElementById('nuvemshop-preview-tbody');
  if (!filteredRows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum produto vinculado encontrado para este filtro.</td></tr>';
    return;
  }

  const statusLabels = {
    equal: 'Sem alteracao',
    increase: 'Aumentaria',
    decrease: 'Reduziria',
    uncontrolled: 'Ignorado'
  };
  tbody.innerHTML = filteredRows.map(row => {
    const localLabel = row.linkVoltage ? `${row.localProduct.nome} - ${row.linkVoltage}` : row.localProduct.nome;
    const currentStock = row.currentStock == null ? 'Ilimitado' : row.currentStock;
    const difference = row.difference == null ? '-' : `${row.difference > 0 ? '+' : ''}${row.difference}`;
    return `<tr>
      <td><div class="nuvemshop-product-name">${escapeHtml(row.remoteName)}</div><div class="nuvemshop-variant">${escapeHtml(row.variantLabel)} | ${escapeHtml(localLabel)}</div></td>
      <td><strong>${escapeHtml(row.unitsPerSale)} un./venda</strong><div class="nuvemshop-local-meta">Base fisica ${escapeHtml(row.localStock)}</div></td>
      <td><span class="nuvemshop-stock">${escapeHtml(currentStock)}</span></td>
      <td><span class="nuvemshop-stock">${escapeHtml(row.destinationStock)}</span></td>
      <td><span class="nuvemshop-preview-diff ${row.previewStatus}">${escapeHtml(difference)}</span></td>
      <td><span class="nuvemshop-preview-status ${row.previewStatus}">${statusLabels[row.previewStatus]}</span></td>
    </tr>`;
  }).join('');
}

function openNuvemshopSimulationModal() {
  const rows = buildNuvemshopSyncPreviewRows();
  if (!nuvemshopPreviewGenerated || !rows.length) {
    alert('Gere uma previa com produtos vinculados antes de validar.');
    return;
  }
  if (!hasConfirmedNuvemshopStockLocation()) {
    alert('O local de estoque precisa estar confirmado antes da validacao.');
    return;
  }

  const different = rows.filter(row => ['increase', 'decrease'].includes(row.previewStatus)).length;
  const uncontrolled = rows.filter(row => row.previewStatus === 'uncontrolled').length;
  document.getElementById('nuvemshop-simulation-summary').innerHTML =
    `<strong>${rows.length} vinculos</strong> serao recalculados diretamente no servidor.<br>` +
    `${different} aparecem com diferenca e ${uncontrolled} estao sem controle externo na previa atual.`;
  document.getElementById('nuvemshop-simulation-result').className = 'nuvemshop-simulation-result';
  document.getElementById('nuvemshop-simulation-result').innerHTML = '';
  document.getElementById('nuvemshop-simulation-error').textContent = '';
  const button = document.getElementById('nuvemshop-simulation-run');
  button.disabled = false;
  button.textContent = 'Executar validacao';
  document.getElementById('nuvemshop-simulation-modal').classList.add('open');
}

function closeNuvemshopSimulationModal() {
  document.getElementById('nuvemshop-simulation-modal').classList.remove('open');
}

function isNuvemshopBatchMode() {
  return nuvemshopPilotMode === 'batch';
}

function selectedNuvemshopApplicationItemIds() {
  return isNuvemshopBatchMode()
    ? [...nuvemshopBatchSelectedItemIds]
    : (nuvemshopPilotSelectedItemId ? [nuvemshopPilotSelectedItemId] : []);
}

function expectedNuvemshopApplicationConfirmation() {
  const total = selectedNuvemshopApplicationItemIds().length;
  return isNuvemshopBatchMode()
    ? `APLICAR LOTE DE ${total} ITENS`
    : 'APLICAR 1 ITEM';
}

function expectedNuvemshopWindowConfirmation() {
  const total = selectedNuvemshopApplicationItemIds().length;
  return isNuvemshopBatchMode()
    ? `LIBERAR LOTE DE ${total} ITENS POR 5 MINUTOS`
    : 'LIBERAR PILOTO POR 5 MINUTOS';
}

function openNuvemshopApplicationModal(mode) {
  if (!nuvemshopServerSimulation?.auditoria_id) {
    alert('Valide a previa no servidor antes de verificar qualquer aplicacao.');
    return;
  }

  nuvemshopPilotMode = mode === 'batch' ? 'batch' : 'pilot';
  nuvemshopPilotReadiness = null;
  nuvemshopPilotSelectedItemId = null;
  nuvemshopBatchSelectedItemIds = [];
  nuvemshopPilotApplying = false;
  nuvemshopPilotApplicationLocked = false;
  nuvemshopPilotWindowBusy = false;
  if (nuvemshopPilotWindowTimer) clearTimeout(nuvemshopPilotWindowTimer);
  nuvemshopPilotWindowTimer = null;
  const batchMode = isNuvemshopBatchMode();
  document.getElementById('nuvemshop-pilot-modal-title').textContent = batchMode
    ? 'Aplicacao controlada em lote'
    : 'Prontidao da aplicacao piloto';
  document.getElementById('nuvemshop-pilot-selection-title').textContent = batchMode
    ? `Selecionar de 2 a ${NUVEMSHOP_BATCH_MAX_ITEMS} itens`
    : 'Selecionar item do piloto';
  document.getElementById('nuvemshop-pilot-summary').innerHTML =
    `A verificacao usara a auditoria <strong>${escapeHtml(nuvemshopServerSimulation.auditoria_id)}</strong> como referencia.<br>` +
    (batchMode
      ? `Escolha de 2 a ${NUVEMSHOP_BATCH_MAX_ITEMS} itens. A validacao nao altera estoques e o lote para no primeiro resultado incerto.`
      : 'A verificacao inicial nao altera estoques. A aplicacao so sera liberada depois de todas as protecoes.');
  const result = document.getElementById('nuvemshop-pilot-result');
  result.className = 'nuvemshop-pilot-result';
  result.innerHTML = '';
  const application = document.getElementById('nuvemshop-pilot-application');
  application.className = 'nuvemshop-pilot-application';
  const windowSection = document.getElementById('nuvemshop-pilot-window');
  windowSection.className = 'nuvemshop-pilot-window';
  document.getElementById('nuvemshop-pilot-window-confirmation').value = '';
  document.getElementById('nuvemshop-pilot-window-status').textContent = '';
  document.getElementById('nuvemshop-pilot-items').innerHTML = '';
  document.getElementById('nuvemshop-pilot-confirmation').value = '';
  document.getElementById('nuvemshop-pilot-application-note').textContent = '';
  const applicationResult = document.getElementById('nuvemshop-pilot-application-result');
  applicationResult.className = 'nuvemshop-pilot-application-result';
  applicationResult.innerHTML = '';
  document.getElementById('nuvemshop-pilot-error').textContent = '';
  const button = document.getElementById('nuvemshop-pilot-run');
  button.disabled = false;
  button.textContent = 'Verificar protecoes';
  const applyButton = document.getElementById('nuvemshop-pilot-apply');
  applyButton.disabled = true;
  applyButton.textContent = batchMode ? 'Aplicar lote' : 'Aplicar 1 item';
  updateNuvemshopPilotWindowButtons();
  document.getElementById('nuvemshop-pilot-modal').classList.add('open');
  renderNuvemshopPilotApplication();
}

function openNuvemshopPilotModal() {
  openNuvemshopApplicationModal('pilot');
}

function openNuvemshopBatchModal() {
  openNuvemshopApplicationModal('batch');
}

async function closeNuvemshopPilotModal() {
  if (nuvemshopPilotApplying || nuvemshopPilotWindowBusy) return;
  if (nuvemshopPilotReadiness?.janela_ativa) {
    const disabled = await runNuvemshopPilotWindow(false);
    if (!disabled) return;
  }
  if (nuvemshopPilotWindowTimer) clearTimeout(nuvemshopPilotWindowTimer);
  nuvemshopPilotWindowTimer = null;
  document.getElementById('nuvemshop-pilot-modal').classList.remove('open');
}

function nuvemshopPilotCandidates() {
  if (!Array.isArray(nuvemshopServerSimulation?.itens)) return [];
  return nuvemshopServerSimulation.itens.filter(item =>
    item?.status === 'alteraria' &&
    Number.isSafeInteger(Number(item.auditoria_item_id)) &&
    Number(item.auditoria_item_id) > 0
  );
}

function renderNuvemshopPilotApplication() {
  const section = document.getElementById('nuvemshop-pilot-application');
  const itemsElement = document.getElementById('nuvemshop-pilot-items');
  const input = document.getElementById('nuvemshop-pilot-confirmation');
  const note = document.getElementById('nuvemshop-pilot-application-note');
  const candidates = nuvemshopPilotCandidates();
  const batchMode = isNuvemshopBatchMode();
  const selectedIds = selectedNuvemshopApplicationItemIds();
  const confirmation = nuvemshopPilotReadiness?.confirmacao_exigida ||
    expectedNuvemshopApplicationConfirmation();

  section.classList.add('visible');
  input.placeholder = batchMode && selectedIds.length < 2
    ? `Selecione de 2 a ${NUVEMSHOP_BATCH_MAX_ITEMS} itens primeiro`
    : confirmation;
  if (!candidates.length) {
    itemsElement.innerHTML = '<div class="nuvemshop-audit-empty">Esta validacao nao possui item que alteraria o estoque.</div>';
    note.textContent = 'Gere uma nova validacao depois de conferir os vinculos e estoques.';
    updateNuvemshopPilotApplyButton();
    return;
  }

  itemsElement.innerHTML = candidates.map(item => {
    const itemId = Number(item.auditoria_item_id);
    const voltage = item.voltagem || 'Unica';
    const unitsPerSale = validUnitsPerSale(item.unidades_por_venda) || 1;
    const physicalStock = Number.isSafeInteger(Number(item.estoque_local_base))
      ? Number(item.estoque_local_base)
      : null;
    const packageRule = `${unitsPerSale} un./venda`;
    const physicalBase = physicalStock == null ? '' : ` | Base fisica ${physicalStock}`;
    const selected = batchMode
      ? nuvemshopBatchSelectedItemIds.includes(itemId)
      : itemId === nuvemshopPilotSelectedItemId;
    return `<button type="button" class="nuvemshop-pilot-item${selected ? ' selected' : ''}" onclick="selectNuvemshopPilotItem(${itemId})">
      <input type="${batchMode ? 'checkbox' : 'radio'}" name="nuvemshop-pilot-item" tabindex="-1"${selected ? ' checked' : ''}>
      <span>
        <span class="nuvemshop-pilot-item-name">${escapeHtml(item.produto_nome)}</span>
        <span class="nuvemshop-pilot-item-meta">${escapeHtml(voltage)} | ${escapeHtml(packageRule)}${escapeHtml(physicalBase)} | Item auditado ${escapeHtml(itemId)}</span>
      </span>
      <span class="nuvemshop-pilot-item-stock">${escapeHtml(item.estoque_atual)} para <strong>${escapeHtml(item.estoque_destino)}</strong></span>
    </button>`;
  }).join('');

  note.className = `nuvemshop-pilot-application-note${nuvemshopPilotReadiness?.pronto_para_aplicar ? ' ready' : ''}`;
  if (nuvemshopPilotReadiness?.pronto_para_aplicar) {
    note.textContent = batchMode
      ? `Confira os ${selectedIds.length} itens e digite exatamente "${confirmation}". O servidor processara um por vez e interrompera o restante diante de qualquer falha.`
      : `Escolha um item e digite exatamente "${confirmation}". O servidor ainda repetira todas as verificacoes antes da escrita.`;
  } else if (nuvemshopPilotReadiness?.pode_habilitar) {
    note.textContent = batchMode
      ? 'Itens conferidos. Libere a janela temporaria e depois confirme a aplicacao do lote.'
      : 'Selecione o item, libere a janela temporaria e depois confirme a aplicacao.';
  } else if (batchMode && selectedIds.length < 2) {
    note.textContent = `Selecione no minimo 2 e no maximo ${NUVEMSHOP_BATCH_MAX_ITEMS} itens. Depois execute a verificacao das protecoes.`;
  } else if (batchMode && !nuvemshopPilotReadiness) {
    note.textContent = `${selectedIds.length} itens selecionados. Execute a verificacao das protecoes antes de liberar a escrita.`;
  } else {
    note.textContent = 'A selecao pode ser conferida, mas a aplicacao permanece desativada enquanto houver protecoes bloqueadas.';
  }
  updateNuvemshopPilotApplyButton();
}

function selectNuvemshopPilotItem(itemId) {
  const normalizedItemId = Number(itemId);
  if (
    nuvemshopPilotApplicationLocked ||
    nuvemshopPilotApplying ||
    nuvemshopPilotReadiness?.janela_ativa
  ) return;
  if (!nuvemshopPilotCandidates().some(item => Number(item.auditoria_item_id) === normalizedItemId)) return;
  if (isNuvemshopBatchMode()) {
    if (nuvemshopBatchSelectedItemIds.includes(normalizedItemId)) {
      nuvemshopBatchSelectedItemIds = nuvemshopBatchSelectedItemIds.filter(id => id !== normalizedItemId);
    } else if (nuvemshopBatchSelectedItemIds.length < NUVEMSHOP_BATCH_MAX_ITEMS) {
      nuvemshopBatchSelectedItemIds = [...nuvemshopBatchSelectedItemIds, normalizedItemId];
    } else {
      document.getElementById('nuvemshop-pilot-error').textContent = `O lote controlado aceita no maximo ${NUVEMSHOP_BATCH_MAX_ITEMS} itens.`;
      return;
    }
    nuvemshopPilotReadiness = null;
    document.getElementById('nuvemshop-pilot-result').className = 'nuvemshop-pilot-result';
    document.getElementById('nuvemshop-pilot-window').className = 'nuvemshop-pilot-window';
    document.getElementById('nuvemshop-pilot-confirmation').value = '';
    document.getElementById('nuvemshop-pilot-window-confirmation').value = '';
    document.getElementById('nuvemshop-pilot-error').textContent = '';
  } else {
    nuvemshopPilotSelectedItemId = normalizedItemId;
  }
  renderNuvemshopPilotApplication();
  document.getElementById('nuvemshop-pilot-application-result').className = 'nuvemshop-pilot-application-result';
}

function updateNuvemshopPilotApplyButton() {
  const button = document.getElementById('nuvemshop-pilot-apply');
  if (!button) return;
  const input = document.getElementById('nuvemshop-pilot-confirmation');
  const confirmation = nuvemshopPilotReadiness?.confirmacao_exigida ||
    expectedNuvemshopApplicationConfirmation();
  const selectedIds = selectedNuvemshopApplicationItemIds();
  const candidateIds = new Set(nuvemshopPilotCandidates().map(item => Number(item.auditoria_item_id)));
  const selectionIsValid = isNuvemshopBatchMode()
    ? selectedIds.length >= 2 && selectedIds.length <= NUVEMSHOP_BATCH_MAX_ITEMS && selectedIds.every(id => candidateIds.has(id))
    : selectedIds.length === 1 && candidateIds.has(selectedIds[0]);
  button.disabled = !nuvemshopPilotReadiness?.pronto_para_aplicar ||
    !selectionIsValid ||
    input?.value !== confirmation ||
    nuvemshopPilotApplying ||
    nuvemshopPilotApplicationLocked;
}

async function readNuvemshopFunctionFailure(error, fallbackMessage) {
  let payload = null;
  const response = error?.context;
  if (response && typeof response.json === 'function') {
    try {
      payload = await (typeof response.clone === 'function' ? response.clone() : response).json();
    } catch {
      payload = null;
    }
  }
  return {
    message: payload?.error || error?.message || fallbackMessage,
    payload
  };
}

function updateNuvemshopPilotWindowButtons() {
  const enableButton = document.getElementById('nuvemshop-pilot-window-enable');
  const disableButton = document.getElementById('nuvemshop-pilot-window-disable');
  const input = document.getElementById('nuvemshop-pilot-window-confirmation');
  if (!enableButton || !disableButton || !input) return;

  const active = nuvemshopPilotReadiness?.janela_ativa === true;
  const confirmation = nuvemshopPilotReadiness?.confirmacao_liberacao_exigida ||
    expectedNuvemshopWindowConfirmation();
  input.disabled = active || nuvemshopPilotWindowBusy || nuvemshopPilotApplying;
  enableButton.disabled = active ||
    !nuvemshopPilotReadiness?.pode_habilitar ||
    input.value !== confirmation ||
    nuvemshopPilotWindowBusy ||
    nuvemshopPilotApplying;
  disableButton.disabled = !active || nuvemshopPilotWindowBusy || nuvemshopPilotApplying;
}

function renderNuvemshopPilotWindow(data) {
  const section = document.getElementById('nuvemshop-pilot-window');
  const input = document.getElementById('nuvemshop-pilot-window-confirmation');
  const status = document.getElementById('nuvemshop-pilot-window-status');
  const confirmation = data?.confirmacao_liberacao_exigida ||
    expectedNuvemshopWindowConfirmation();
  const active = data?.janela_ativa === true;

  section.classList.add('visible');
  input.placeholder = confirmation;
  if (active && data.escrita_habilitada_ate) {
    const expiresAt = new Date(data.escrita_habilitada_ate);
    status.className = 'nuvemshop-pilot-window-status active';
    status.textContent = `Janela ativa ate ${expiresAt.toLocaleTimeString('pt-BR')}. Ela sera fechada automaticamente depois da tentativa autorizada.`;

    if (nuvemshopPilotWindowTimer) clearTimeout(nuvemshopPilotWindowTimer);
    const remaining = expiresAt.getTime() - Date.now();
    if (remaining > 0) {
      nuvemshopPilotWindowTimer = setTimeout(() => {
        nuvemshopPilotWindowTimer = null;
        if (document.getElementById('nuvemshop-pilot-modal').classList.contains('open')) {
          runNuvemshopPilotReadiness();
        }
      }, Math.min(remaining + 300, 5 * 60 * 1000));
    }
  } else {
    if (nuvemshopPilotWindowTimer) clearTimeout(nuvemshopPilotWindowTimer);
    nuvemshopPilotWindowTimer = null;
    status.className = `nuvemshop-pilot-window-status${data?.pode_habilitar ? ' ready' : ''}`;
    status.textContent = data?.pode_habilitar
      ? `Todas as protecoes anteriores foram atendidas. Digite exatamente "${confirmation}" para abrir a janela.`
      : 'A janela so podera ser liberada depois que os demais requisitos estiverem atendidos.';
  }
  updateNuvemshopPilotWindowButtons();
}

async function runNuvemshopPilotWindow(enableWindow) {
  const errorElement = document.getElementById('nuvemshop-pilot-error');
  const input = document.getElementById('nuvemshop-pilot-window-confirmation');
  const confirmation = nuvemshopPilotReadiness?.confirmacao_liberacao_exigida ||
    expectedNuvemshopWindowConfirmation();
  const batchMode = isNuvemshopBatchMode();
  const selectedIds = selectedNuvemshopApplicationItemIds();

  if (nuvemshopPilotWindowBusy || nuvemshopPilotApplying) return false;
  if (enableWindow) {
    if (!nuvemshopPilotReadiness?.pode_habilitar) {
      errorElement.textContent = 'Verifique novamente as protecoes antes de liberar a janela.';
      return false;
    }
    if (input.value !== confirmation) {
      errorElement.textContent = `Digite exatamente "${confirmation}".`;
      return false;
    }
  }

  nuvemshopPilotWindowBusy = true;
  errorElement.textContent = '';
  updateNuvemshopPilotWindowButtons();

  try {
    const { data, error } = await sb.functions.invoke('nuvemshop-sincronizacao', {
      body: {
        modo: enableWindow
          ? (batchMode ? 'habilitar_lote' : 'habilitar_piloto')
          : (batchMode ? 'desabilitar_lote' : 'desabilitar_piloto'),
        store_id: nuvemshopStoreId,
        auditoria_id: nuvemshopServerSimulation?.auditoria_id,
        itens_auditoria_ids: batchMode ? selectedIds : undefined,
        confirmacao: enableWindow ? confirmation : ''
      }
    });
    if (error) {
      const failure = await readNuvemshopFunctionFailure(
        error,
        enableWindow
          ? 'Nao foi possivel liberar a janela temporaria.'
          : 'Nao foi possivel desligar a janela temporaria.'
      );
      throw new Error(failure.message);
    }
    const expectedMode = enableWindow
      ? (batchMode ? 'janela_lote_habilitada' : 'janela_piloto_habilitada')
      : (batchMode ? 'janela_lote_desabilitada' : 'janela_piloto_desabilitada');
    if (
      data?.modo !== expectedMode ||
      data?.escrita_executada !== false ||
      data?.escrita_habilitada !== enableWindow
    ) {
      throw new Error('O servidor retornou um estado inesperado para a janela.');
    }

    input.value = '';
    if (nuvemshopPilotReadiness) {
      nuvemshopPilotReadiness.janela_ativa = enableWindow;
      nuvemshopPilotReadiness.escrita_habilitada = enableWindow;
      nuvemshopPilotReadiness.escrita_habilitada_ate =
        enableWindow ? data.escrita_habilitada_ate : null;
      nuvemshopPilotReadiness.pode_habilitar =
        !enableWindow && nuvemshopPilotReadiness.requisitos_atendidos === true;
      nuvemshopPilotReadiness.pronto_para_aplicar =
        enableWindow && nuvemshopPilotReadiness.requisitos_atendidos === true;
      const blockers = Array.isArray(nuvemshopPilotReadiness.bloqueios)
        ? nuvemshopPilotReadiness.bloqueios.filter(
          blocker => !String(blocker).toLowerCase().includes('janela temporaria')
        )
        : [];
      if (!enableWindow) {
        blockers.push('A janela temporaria de escrita permanece fechada ou expirada.');
      }
      nuvemshopPilotReadiness.bloqueios = blockers;
    }
    showToast(
      'green',
      enableWindow
        ? 'Janela de escrita liberada por ate cinco minutos.'
        : 'Janela de escrita desligada.'
    );
    if (nuvemshopPilotReadiness) {
      renderNuvemshopPilotReadiness(nuvemshopPilotReadiness);
      renderNuvemshopPilotApplication();
    }
    return true;
  } catch (error) {
    console.error('Falha ao configurar janela do piloto', error);
    errorElement.textContent = error?.message || 'Nao foi possivel configurar a janela do piloto.';
    return false;
  } finally {
    nuvemshopPilotWindowBusy = false;
    updateNuvemshopPilotWindowButtons();
  }
}

function renderNuvemshopPilotReadiness(data) {
  const batchMode = isNuvemshopBatchMode();
  const selectedTotal = selectedNuvemshopApplicationItemIds().length;
  const windowExpiresAt = data.escrita_habilitada_ate
    ? new Date(data.escrita_habilitada_ate).toLocaleTimeString('pt-BR')
    : null;
  const checks = [
    { label: 'Simulacao recente', ok: data.simulacao_valida, value: data.simulacao_valida ? 'Valida' : 'Invalida' },
    { label: 'Escopo de escrita', ok: data.escopo_escrita, value: data.escopo_escrita ? 'Autorizado' : 'Ausente' },
    { label: 'Local de estoque', ok: data.local_confirmado, value: data.local_confirmado ? 'Confirmado' : 'Pendente' },
    { label: 'Vinculos ativos', ok: data.vinculos_dentro_limite, value: String(data.vinculos_ativos ?? 0) },
    {
      label: batchMode ? 'Limite do lote' : 'Limite do piloto',
      ok: data.limite_seguro,
      value: batchMode
        ? `${selectedTotal} selecionados`
        : `${data.limite_itens ?? '-'} item`
    },
    {
      label: 'Janela de escrita',
      ok: data.escrita_habilitada,
      value: data.escrita_habilitada ? `Ate ${windowExpiresAt}` : 'Fechada'
    }
  ];
  const blockers = Array.isArray(data.bloqueios) ? data.bloqueios : [];
  const result = document.getElementById('nuvemshop-pilot-result');
  result.innerHTML = `<div class="nuvemshop-pilot-grid">
    ${checks.map(check => `<div class="nuvemshop-pilot-check ${check.ok ? 'ok' : 'blocked'}">
      <span>${escapeHtml(check.label)}</span>
      <strong>${escapeHtml(check.value)}</strong>
    </div>`).join('')}
  </div>
  <div class="nuvemshop-pilot-status ${data.pronto_para_aplicar ? 'ready' : 'blocked'}">
    ${data.pronto_para_aplicar
      ? (batchMode
        ? `Protecoes atendidas para o lote de ${selectedTotal} itens.`
        : 'Protecoes atendidas. Selecione somente um item para o piloto.')
      : `${batchMode ? 'Lote' : 'Piloto'} bloqueado com seguranca. Nenhuma escrita foi executada.`}
  </div>
  ${blockers.length ? `<div class="nuvemshop-pilot-blockers">${blockers.map(blocker => `<div>${escapeHtml(blocker)}</div>`).join('')}</div>` : ''}`;
  result.classList.add('visible');
  renderNuvemshopPilotWindow(data);
  renderNuvemshopWorkflow();
}

async function runNuvemshopPilotReadiness() {
  const button = document.getElementById('nuvemshop-pilot-run');
  const errorElement = document.getElementById('nuvemshop-pilot-error');
  button.disabled = true;
  button.textContent = 'Verificando...';
  errorElement.textContent = '';
  const batchMode = isNuvemshopBatchMode();
  const selectedIds = selectedNuvemshopApplicationItemIds();
  if (batchMode && (selectedIds.length < 2 || selectedIds.length > NUVEMSHOP_BATCH_MAX_ITEMS)) {
    errorElement.textContent = `Selecione de 2 a ${NUVEMSHOP_BATCH_MAX_ITEMS} itens antes de verificar as protecoes do lote.`;
    button.disabled = false;
    button.textContent = 'Verificar protecoes';
    return;
  }

  try {
    const { data, error } = await sb.functions.invoke('nuvemshop-sincronizacao', {
      body: {
        modo: batchMode ? 'verificar_lote' : 'verificar_piloto',
        store_id: nuvemshopStoreId,
        auditoria_id: nuvemshopServerSimulation?.auditoria_id,
        itens_auditoria_ids: batchMode ? selectedIds : undefined
      }
    });
    if (error) throw error;
    const expectedMode = batchMode ? 'verificacao_lote' : 'verificacao_piloto';
    if (data?.modo !== expectedMode || data?.escrita_executada !== false) {
      throw new Error('O servidor retornou uma verificacao inesperada.');
    }

    nuvemshopPilotReadiness = data;
    renderNuvemshopPilotReadiness(data);
    renderNuvemshopPilotApplication();
    showToast(
      'green',
      batchMode
        ? 'Protecoes do lote verificadas sem alterar estoques.'
        : 'Protecoes do piloto verificadas sem alterar estoques.'
    );
  } catch (error) {
    console.error('Falha na verificacao do piloto Nuvemshop', error);
    errorElement.textContent = error?.message || 'Nao foi possivel verificar as protecoes do piloto.';
  } finally {
    button.disabled = false;
    button.textContent = 'Executar novamente';
  }
}

async function runNuvemshopPilotApplication() {
  const button = document.getElementById('nuvemshop-pilot-apply');
  const errorElement = document.getElementById('nuvemshop-pilot-error');
  const resultElement = document.getElementById('nuvemshop-pilot-application-result');
  const batchMode = isNuvemshopBatchMode();
  const selectedIds = selectedNuvemshopApplicationItemIds();
  const confirmation = nuvemshopPilotReadiness?.confirmacao_exigida ||
    expectedNuvemshopApplicationConfirmation();
  const selectedItem = batchMode
    ? null
    : nuvemshopPilotCandidates()
      .find(item => Number(item.auditoria_item_id) === nuvemshopPilotSelectedItemId);

  if (!nuvemshopPilotReadiness?.pronto_para_aplicar) {
    errorElement.textContent = 'Verifique novamente as protecoes antes de qualquer aplicacao.';
    return;
  }
  if (
    (batchMode && (selectedIds.length < 2 || selectedIds.length > NUVEMSHOP_BATCH_MAX_ITEMS)) ||
    (!batchMode && !selectedItem)
  ) {
    errorElement.textContent = batchMode
      ? `Selecione de 2 a ${NUVEMSHOP_BATCH_MAX_ITEMS} itens auditados.`
      : 'Selecione exatamente um item auditado.';
    return;
  }
  if (document.getElementById('nuvemshop-pilot-confirmation').value !== confirmation) {
    errorElement.textContent = `Digite exatamente "${confirmation}".`;
    return;
  }

  nuvemshopPilotApplying = true;
  errorElement.textContent = '';
  resultElement.className = 'nuvemshop-pilot-application-result';
  resultElement.innerHTML = '';
  button.textContent = 'Aplicando...';
  updateNuvemshopPilotApplyButton();

  try {
    const { data, error } = await sb.functions.invoke('nuvemshop-sincronizacao', {
      body: {
        modo: batchMode ? 'aplicar_lote' : 'aplicar_piloto',
        store_id: nuvemshopStoreId,
        auditoria_id: nuvemshopServerSimulation.auditoria_id,
        item_auditoria_id: batchMode ? undefined : Number(selectedItem.auditoria_item_id),
        itens_auditoria_ids: batchMode ? selectedIds : undefined,
        confirmacao: confirmation
      }
    });
    if (error) {
      const failure = await readNuvemshopFunctionFailure(
        error,
        batchMode
          ? 'Nao foi possivel concluir a aplicacao em lote.'
          : 'Nao foi possivel concluir a aplicacao piloto.'
      );
      const terminalAttempt = Boolean(failure.payload?.aplicacao_id);
      const failedItems = Array.isArray(failure.payload?.itens) ? failure.payload.itens : [];
      nuvemshopPilotApplicationLocked = true;
      if (nuvemshopPilotReadiness) {
        nuvemshopPilotReadiness.janela_ativa = false;
        nuvemshopPilotReadiness.escrita_habilitada = false;
        nuvemshopPilotReadiness.escrita_habilitada_ate = null;
        nuvemshopPilotReadiness.pode_habilitar = false;
        renderNuvemshopPilotReadiness(nuvemshopPilotReadiness);
      }
      const blockers = Array.isArray(failure.payload?.bloqueios) ? failure.payload.bloqueios : [];
      resultElement.className = `nuvemshop-pilot-application-result visible ${terminalAttempt ? 'warning' : 'error'}`;
      resultElement.innerHTML = `${escapeHtml(failure.message)}` +
        `${blockers.length ? `<br>${blockers.map(item => escapeHtml(item)).join('<br>')}` : ''}` +
        `${batchMode && failedItems.length
          ? `<br><strong>Resultado antes da interrupcao:</strong><br>${failedItems.map(item => {
              const confirmed = item?.resultado === 'concluido';
              const detail = confirmed
                ? `confirmado em ${escapeHtml(item.estoque_confirmado)}`
                : `nao confirmado${item?.erro ? `: ${escapeHtml(item.erro)}` : ''}`;
              return `Item ${escapeHtml(item?.item_auditoria_id)}: ${detail}.`;
            }).join('<br>')}`
          : ''}` +
        `${batchMode && terminalAttempt
          ? `<br>${escapeHtml(failure.payload?.total_processado || 0)} de ${escapeHtml(failure.payload?.total_reservado || selectedIds.length)} itens chegaram a ser processados.`
          : ''}` +
        '<br>A janela foi encerrada. Nao repita a tentativa; confira a auditoria e gere uma nova validacao.';
      nuvemshopServerSimulation = null;
      nuvemshopPilotReadiness = null;
      renderNuvemshopSyncPreview();
      return;
    }
    const expectedMode = batchMode ? 'aplicacao_lote' : 'aplicacao_piloto';
    if (
      data?.modo !== expectedMode ||
      data?.resultado !== 'concluida' ||
      data?.escrita_executada !== true
    ) {
      throw new Error('O servidor retornou um resultado inesperado. Nao tente novamente antes de conferir a auditoria.');
    }

    nuvemshopPilotApplicationLocked = true;
    if (nuvemshopPilotReadiness) {
      nuvemshopPilotReadiness.janela_ativa = false;
      nuvemshopPilotReadiness.escrita_habilitada = false;
      nuvemshopPilotReadiness.escrita_habilitada_ate = null;
      nuvemshopPilotReadiness.pode_habilitar = false;
      renderNuvemshopPilotReadiness(nuvemshopPilotReadiness);
    }
    resultElement.className = 'nuvemshop-pilot-application-result visible success';
    if (batchMode) {
      const items = Array.isArray(data.itens) ? data.itens : [];
      resultElement.innerHTML =
        `<strong>Lote confirmado.</strong><br>` +
        `${escapeHtml(data.total_processado)} de ${escapeHtml(data.total_reservado)} itens processados e confirmados.<br>` +
        `${items.map(item =>
          `Item ${escapeHtml(item.item_auditoria_id)}: estoque confirmado em ${escapeHtml(item.estoque_confirmado)}.`
        ).join('<br>')}<br>` +
        `Auditoria: ${escapeHtml(data.aplicacao_id)}`;
    } else {
      resultElement.innerHTML =
        `<strong>Aplicacao confirmada.</strong><br>` +
        `Estoque Nuvemshop: ${escapeHtml(data.estoque_anterior)} para ${escapeHtml(data.estoque_confirmado)}.<br>` +
        `Auditoria: ${escapeHtml(data.aplicacao_id)}`;
    }
    button.textContent = 'Aplicacao concluida';
    showToast(
      'green',
      batchMode
        ? `${data.total_processado} itens foram aplicados e confirmados na Nuvemshop.`
        : 'Um item foi aplicado e confirmado na Nuvemshop.'
    );
    nuvemshopAuditPage = 1;
    loadNuvemshopAuditHistory(true);
    await loadNuvemshopCatalog(true);
  } catch (error) {
    console.error('Falha inesperada na aplicacao piloto Nuvemshop', error);
    nuvemshopPilotApplicationLocked = true;
    if (nuvemshopPilotReadiness) {
      nuvemshopPilotReadiness.janela_ativa = false;
      nuvemshopPilotReadiness.escrita_habilitada = false;
      nuvemshopPilotReadiness.escrita_habilitada_ate = null;
      nuvemshopPilotReadiness.pode_habilitar = false;
      renderNuvemshopPilotReadiness(nuvemshopPilotReadiness);
    }
    nuvemshopServerSimulation = null;
    nuvemshopPilotReadiness = null;
    renderNuvemshopSyncPreview();
    resultElement.className = 'nuvemshop-pilot-application-result visible warning';
    resultElement.textContent = error?.message || 'Resultado inesperado. Confira a auditoria antes de qualquer nova acao.';
  } finally {
    nuvemshopPilotApplying = false;
    button.textContent = nuvemshopPilotApplicationLocked
      ? 'Nova validacao necessaria'
      : (batchMode ? 'Aplicar lote' : 'Aplicar 1 item');
    updateNuvemshopPilotApplyButton();
  }
}

function renderNuvemshopSimulationResult(data) {
  const summary = data.resumo;
  const result = document.getElementById('nuvemshop-simulation-result');
  result.innerHTML = `<div class="nuvemshop-simulation-result-grid">
    <div class="nuvemshop-simulation-result-item"><span>Vinculados</span><strong>${escapeHtml(summary.vinculados)}</strong></div>
    <div class="nuvemshop-simulation-result-item"><span>Iguais</span><strong>${escapeHtml(summary.iguais)}</strong></div>
    <div class="nuvemshop-simulation-result-item"><span>Alterariam</span><strong>${escapeHtml(summary.alterariam)}</strong></div>
    <div class="nuvemshop-simulation-result-item"><span>Sem controle</span><strong>${escapeHtml(summary.sem_controle)}</strong></div>
    <div class="nuvemshop-simulation-result-item"><span>Erros</span><strong>${escapeHtml(summary.erros)}</strong></div>
  </div>
  <div class="nuvemshop-simulation-safe">Validacao concluida em modo seguro. Nenhum estoque foi alterado.</div>
  <div class="nuvemshop-simulation-audit">Auditoria registrada: ${escapeHtml(data.auditoria_id)}</div>`;
  result.classList.add('visible');
}

async function runNuvemshopSimulation() {
  const button = document.getElementById('nuvemshop-simulation-run');
  const errorElement = document.getElementById('nuvemshop-simulation-error');
  button.disabled = true;
  button.textContent = 'Validando...';
  errorElement.textContent = '';

  try {
    const { data, error } = await sb.functions.invoke('nuvemshop-sincronizacao', {
      body: { modo: 'simular', store_id: nuvemshopStoreId }
    });
    if (error) throw error;
    if (
      data?.modo !== 'simulacao' ||
      data?.escrita_habilitada !== false ||
      !data?.resumo ||
      !data?.auditoria_id ||
      !Array.isArray(data?.itens) ||
      data.itens.some(item => !Number.isSafeInteger(Number(item?.auditoria_item_id)))
    ) {
      throw new Error('O servidor retornou uma validacao inesperada.');
    }

    nuvemshopServerSimulation = data;
    nuvemshopPilotReadiness = null;
    nuvemshopPilotSelectedItemId = null;
    nuvemshopBatchSelectedItemIds = [];
    nuvemshopPilotApplicationLocked = false;
    renderNuvemshopSimulationResult(data);
    renderNuvemshopSyncPreview();
    nuvemshopAuditPage = 1;
    loadNuvemshopAuditHistory(true);
    showToast('green', 'Previa validada no servidor sem alterar estoques.');
  } catch (error) {
    console.error('Falha na validacao segura da Nuvemshop', error);
    errorElement.textContent = error?.message || 'Nao foi possivel validar a previa no servidor.';
  } finally {
    button.disabled = false;
    button.textContent = 'Executar novamente';
  }
}

async function confirmNuvemshopLink(productId, variantId) {
  const row = findNuvemshopCatalogRow(productId, variantId);
  if (!row || row.status !== 'matched' || !row.localProduct) {
    alert('Esta correspondencia nao esta disponivel para confirmacao.');
    return;
  }
  if (row.localProduct.tem_voltagem && !row.linkVoltage) {
    alert('Nao foi possivel identificar a voltagem. Este item devera ser vinculado manualmente.');
    return;
  }

  openNuvemshopLinkModal(row, row.localProduct, row.linkVoltage);
}

function findNuvemshopCatalogRow(productId, variantId) {
  const normalizedVariantId = variantId == null ? null : Number(variantId);
  return nuvemshopCatalogRows.find(item =>
    item.productId === Number(productId) && item.variantId === normalizedVariantId
  );
}

function findActiveNuvemshopLink(linkId, storeId) {
  const normalizedLinkId = Number(linkId);
  const normalizedStoreId = Number(storeId);
  if (!isPositiveNuvemshopId(normalizedLinkId) || !isPositiveNuvemshopId(normalizedStoreId)) return null;
  return nuvemshopActiveLinks.find(link =>
    Number(link.id) === normalizedLinkId &&
    Number(link.store_id) === normalizedStoreId &&
    link.ativo === true
  ) || null;
}

function updateNuvemshopLinkDeactivationButton() {
  const button = document.getElementById('nuvemshop-unlink-confirm');
  const reason = document.getElementById('nuvemshop-unlink-reason');
  if (!button) return;
  const manual = nuvemshopLinkDeactivationTarget?.action === 'manual';
  button.disabled = nuvemshopLinkDeactivationBusy || (manual && !reason?.value.trim());
}

function openNuvemshopLinkDeactivationModal(linkId, action, sourceButton = null) {
  if (nuvemshopLinkDeactivationBusy || !['manual', 'quebrado'].includes(action)) return;
  const storeId = selectedNuvemshopStoreId();
  const link = findActiveNuvemshopLink(linkId, storeId);
  const remoteProductId = Number(link?.nuvemshop_produto_id);
  const remoteVariantId = link?.nuvemshop_variante_id == null ? null : Number(link.nuvemshop_variante_id);
  if (
    !link ||
    !isPositiveNuvemshopId(remoteProductId) ||
    (remoteVariantId !== null && !isPositiveNuvemshopId(remoteVariantId))
  ) {
    alert('Este vinculo ativo da loja selecionada nao esta mais disponivel. Consulte o catalogo novamente.');
    return;
  }

  const modal = document.getElementById('nuvemshop-unlink-modal');
  const title = document.getElementById('nuvemshop-unlink-title');
  const description = document.getElementById('nuvemshop-unlink-description');
  const details = document.getElementById('nuvemshop-unlink-details');
  const reasonWrap = document.getElementById('nuvemshop-unlink-reason-wrap');
  const reason = document.getElementById('nuvemshop-unlink-reason');
  const errorElement = document.getElementById('nuvemshop-unlink-error');
  const localProduct = products.find(product => Number(product.id) === Number(link.produto_id));
  if (!modal || !title || !description || !details || !reasonWrap || !reason || !errorElement) return;

  nuvemshopLinkDeactivationTarget = {
    action,
    linkId: Number(link.id),
    storeId,
    remoteProductId,
    remoteVariantId,
  };
  nuvemshopLinkDeactivationPreviousFocus = sourceButton instanceof HTMLElement ? sourceButton : document.activeElement;
  title.textContent = action === 'quebrado' ? 'Desativar vinculo quebrado' : 'Desativar vinculo manualmente';
  description.textContent = action === 'quebrado'
    ? 'O servidor vai confirmar na loja selecionada que o produto ou a variante externa nao existe mais. Nenhuma alteracao externa sera feita.'
    : 'Esta e uma decisao administrativa. Nenhum estoque, preco, CSV ou cadastro sera alterado.';
  details.textContent = [
    `Loja: ${storeId}`,
    `Produto local: ${localProduct ? `${localProduct.nome} (ID ${localProduct.id})` : `ID ${link.produto_id}`}`,
    `Produto externo: ${remoteProductId}`,
    `Variante externa: ${remoteVariantId === null ? '-' : remoteVariantId}`,
  ].join('\n');
  reason.value = '';
  reasonWrap.style.display = action === 'manual' ? 'block' : 'none';
  errorElement.textContent = '';
  modal.classList.add('open');
  modal.setAttribute('aria-hidden', 'false');
  updateNuvemshopLinkDeactivationButton();
  setTimeout(() => (action === 'manual' ? reason : document.getElementById('nuvemshop-unlink-confirm'))?.focus(), 0);
}

function closeNuvemshopLinkDeactivationModal() {
  if (nuvemshopLinkDeactivationBusy) return;
  const modal = document.getElementById('nuvemshop-unlink-modal');
  if (modal) {
    modal.classList.remove('open');
    modal.setAttribute('aria-hidden', 'true');
  }
  const previousFocus = nuvemshopLinkDeactivationPreviousFocus;
  nuvemshopLinkDeactivationTarget = null;
  nuvemshopLinkDeactivationPreviousFocus = null;
  if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
}

async function confirmNuvemshopLinkDeactivation() {
  const target = nuvemshopLinkDeactivationTarget;
  const errorElement = document.getElementById('nuvemshop-unlink-error');
  const confirmButton = document.getElementById('nuvemshop-unlink-confirm');
  const cancelButton = document.getElementById('nuvemshop-unlink-cancel');
  const reason = document.getElementById('nuvemshop-unlink-reason');
  if (!target || !errorElement || !confirmButton || !cancelButton || nuvemshopLinkDeactivationBusy) return;
  if (!isPositiveNuvemshopId(target.linkId) || !isPositiveNuvemshopId(target.storeId)) return;
  if (selectedNuvemshopStoreId() !== target.storeId || !findActiveNuvemshopLink(target.linkId, target.storeId)) {
    errorElement.textContent = 'O vinculo ou a loja selecionada mudou. Consulte o catalogo novamente.';
    return;
  }

  const manualReason = target.action === 'manual' ? reason?.value.trim() : null;
  if (target.action === 'manual' && !manualReason) {
    errorElement.textContent = 'Informe o motivo da desativacao manual.';
    updateNuvemshopLinkDeactivationButton();
    return;
  }

  nuvemshopLinkDeactivationBusy = true;
  errorElement.textContent = '';
  confirmButton.disabled = true;
  cancelButton.disabled = true;
  confirmButton.textContent = target.action === 'quebrado' ? 'Confirmando na loja...' : 'Desativando...';
  let completed = false;
  let idempotent = false;
  try {
    const { data, error } = await sb.functions.invoke('nuvemshop-vinculo-quebrado', {
      body: {
        acao: target.action,
        store_id: target.storeId,
        vinculo_id: target.linkId,
        ...(target.action === 'manual' ? { motivo: manualReason } : {}),
      },
    });
    if (error) {
      const failure = await readNuvemshopFunctionFailure(error, 'Nao foi possivel desativar o vinculo selecionado.');
      throw new Error(failure.message);
    }
    if (data?.desativado !== true && data?.idempotente !== true) {
      throw new Error('O servidor retornou uma desativacao de vinculo inesperada.');
    }

    idempotent = data?.idempotente === true;
    nuvemshopActiveLinks = nuvemshopActiveLinks.filter(link => Number(link.id) !== target.linkId || Number(link.store_id) !== target.storeId);
    rebuildNuvemshopCatalogRows();
    clearNuvemshopPreviewAfterLinkChange();
    renderNuvemshopCatalog();
    completed = true;
  } catch (error) {
    console.error('Falha no fluxo seguro de desativacao de vinculo.', error);
    errorElement.textContent = error?.message || 'Nao foi possivel desativar o vinculo selecionado.';
  } finally {
    nuvemshopLinkDeactivationBusy = false;
    cancelButton.disabled = false;
    confirmButton.textContent = 'Confirmar desativacao';
    updateNuvemshopLinkDeactivationButton();
  }

  if (completed) {
    closeNuvemshopLinkDeactivationModal();
    showToast('blue', idempotent
      ? 'O vinculo ja estava desativado. Nenhum estoque foi alterado.'
      : 'Vinculo desativado com auditoria. Nenhum estoque foi alterado.');
  }
}

function manualProductSearchText(product) {
  return normalizeCode([
    product.id,
    product.nome,
    product.categoria,
    ...localProductCodes(product)
  ].filter(Boolean).join(' '));
}

function openManualNuvemshopLink(productId, variantId) {
  const row = findNuvemshopCatalogRow(productId, variantId);
  if (!row || row.status === 'linked') {
    alert('Este item nao esta disponivel para vinculo manual.');
    return;
  }

  openNuvemshopLinkModal(row);
}

function openNuvemshopLinkModal(row, presetProduct = null, presetVoltage = null) {
  nuvemshopManualRow = row;
  nuvemshopManualVoltage = presetVoltage;
  const suggestion = inferUnitsPerSale(row);
  row.unitsSuggestion = suggestion;
  document.getElementById('nuvemshop-manual-search').value = '';
  document.getElementById('nuvemshop-manual-units').value = suggestion.value;
  document.getElementById('nuvemshop-manual-error').textContent = '';
  document.getElementById('nuvemshop-manual-remote').innerHTML = `
    <strong>${escapeHtml(row.remoteName)}</strong>
    <div class="nuvemshop-manual-meta">${escapeHtml(row.variantLabel)} | Produto ${row.productId} | Variante ${row.variantId || '-'}</div>
    <div class="nuvemshop-manual-meta">SKU ${escapeHtml(row.sku || '-')} | Barras ${escapeHtml(row.barcode || '-')} | Estoque ${escapeHtml(row.remoteStock == null ? 'Ilimitado' : row.remoteStock)}</div>`;
  document.getElementById('nuvemshop-manual-local').textContent = 'Selecione o produto local correspondente.';
  document.getElementById('nuvemshop-manual-voltage-wrap').style.display = 'none';
  document.querySelectorAll('#nuvemshop-manual-voltage-wrap button').forEach(button => button.classList.remove('active'));
  renderManualNuvemshopProducts();
  if (presetProduct) {
    const productSelect = document.getElementById('nuvemshop-manual-product');
    productSelect.value = String(presetProduct.id);
    updateManualNuvemshopProduct();
    if (presetVoltage) selectManualNuvemshopVoltage(presetVoltage);
  }
  updateManualNuvemshopUnitsPreview();
  document.getElementById('nuvemshop-manual-modal').classList.add('open');
  setTimeout(() => {
    const focusTarget = presetProduct
      ? document.getElementById('nuvemshop-manual-units')
      : document.getElementById('nuvemshop-manual-search');
    focusTarget.focus();
    if (presetProduct) focusTarget.select();
  }, 0);
}

function closeManualNuvemshopLink() {
  document.getElementById('nuvemshop-manual-modal').classList.remove('open');
  nuvemshopManualRow = null;
  nuvemshopManualVoltage = null;
}

function renderManualNuvemshopProducts() {
  const select = document.getElementById('nuvemshop-manual-product');
  const currentValue = select.value;
  const search = normalizeCode(document.getElementById('nuvemshop-manual-search').value);
  const candidateIds = new Set((nuvemshopManualRow?.candidates || []).map(product => product.id));
  const filteredProducts = products
    .filter(product => !search || manualProductSearchText(product).includes(search))
    .sort((a, b) => {
      const candidateDifference = Number(candidateIds.has(b.id)) - Number(candidateIds.has(a.id));
      return candidateDifference || a.nome.localeCompare(b.nome, 'pt-BR');
    });

  select.innerHTML = `<option value="">${filteredProducts.length ? 'Selecione...' : 'Nenhum produto encontrado'}</option>` +
    filteredProducts.map(product => {
      const category = product.categoria === 'produto' ? 'Produto' : 'Maquina / Prensa';
      const candidate = candidateIds.has(product.id) ? ' | codigo correspondente' : '';
      return `<option value="${product.id}">${escapeHtml(product.nome)} | ID ${product.id} | ${category}${candidate}</option>`;
    }).join('');

  if (currentValue && filteredProducts.some(product => String(product.id) === currentValue)) {
    select.value = currentValue;
  }
  updateManualNuvemshopProduct();
}

function updateManualNuvemshopProduct() {
  const productId = Number(document.getElementById('nuvemshop-manual-product').value);
  const product = products.find(item => item.id === productId);
  const localInfo = document.getElementById('nuvemshop-manual-local');
  const voltageWrap = document.getElementById('nuvemshop-manual-voltage-wrap');
  document.getElementById('nuvemshop-manual-error').textContent = '';
  nuvemshopManualVoltage = null;
  document.querySelectorAll('#nuvemshop-manual-voltage-wrap button').forEach(button => button.classList.remove('active'));

  if (!product) {
    localInfo.textContent = 'Selecione o produto local correspondente.';
    voltageWrap.style.display = 'none';
    updateManualNuvemshopUnitsPreview();
    return;
  }

  const category = product.categoria === 'produto' ? 'Produto' : 'Maquina / Prensa';
  const stockText = product.tem_voltagem
    ? `110V: ${Number(product.quantidade_110v) || 0} | 220V: ${Number(product.quantidade_220v) || 0}`
    : `Estoque: ${Number(product.quantidade) || 0}`;
  localInfo.innerHTML = `<strong>${escapeHtml(product.nome)}</strong><div class="nuvemshop-manual-meta">ID ${product.id} | ${category} | ${stockText}</div>`;
  voltageWrap.style.display = product.tem_voltagem ? 'block' : 'none';
  updateManualNuvemshopUnitsPreview();
}

function selectManualNuvemshopVoltage(voltage) {
  if (!['110V', '220V'].includes(voltage)) return;
  nuvemshopManualVoltage = voltage;
  document.querySelectorAll('#nuvemshop-manual-voltage-wrap button').forEach(button => {
    button.classList.toggle('active', button.dataset.voltage === voltage);
  });
  document.getElementById('nuvemshop-manual-error').textContent = '';
  updateManualNuvemshopUnitsPreview();
}

function updateManualNuvemshopUnitsPreview() {
  const help = document.getElementById('nuvemshop-manual-units-help');
  const units = validUnitsPerSale(document.getElementById('nuvemshop-manual-units')?.value);
  const productId = Number(document.getElementById('nuvemshop-manual-product')?.value);
  const localProduct = products.find(product => product.id === productId);
  const voltage = localProduct?.tem_voltagem ? nuvemshopManualVoltage : null;
  const physicalStock = mappedLocalStock(localProduct, voltage);
  const destinationStock = packageDestinationStock(physicalStock, units);
  const suggestion = nuvemshopManualRow?.unitsSuggestion || inferUnitsPerSale(nuvemshopManualRow);

  if (!units) {
    help.textContent = 'Informe um numero inteiro entre 1 e 10.000.';
    return;
  }

  const suggestionText = suggestion?.value === units
    ? `Sugestao obtida pelo ${suggestion.source}. `
    : `Sugestao automatica: ${suggestion?.value || 1}. `;
  const stockText = destinationStock == null
    ? 'Selecione o produto e a voltagem para conferir o destino.'
    : `Estoque fisico ${physicalStock} gera ${destinationStock} oferta(s) disponivel(is).`;
  help.innerHTML = `${escapeHtml(suggestionText)}<strong>${escapeHtml(stockText)}</strong>`;
}

async function saveManualNuvemshopLink() {
  const errorElement = document.getElementById('nuvemshop-manual-error');
  const productId = Number(document.getElementById('nuvemshop-manual-product').value);
  const localProduct = products.find(product => product.id === productId);
  if (!nuvemshopManualRow || !localProduct) {
    errorElement.textContent = 'Selecione o produto local.';
    return;
  }
  if (localProduct.tem_voltagem && !nuvemshopManualVoltage) {
    errorElement.textContent = 'Selecione 110V ou 220V.';
    return;
  }
  const unitsPerSale = validUnitsPerSale(document.getElementById('nuvemshop-manual-units').value);
  if (!unitsPerSale) {
    errorElement.textContent = 'Informe quantas unidades fisicas esta oferta consome por venda.';
    return;
  }

  const row = nuvemshopManualRow;
  const button = document.getElementById('nuvemshop-manual-save');
  button.disabled = true;
  button.textContent = 'Salvando...';
  errorElement.textContent = '';

  const { data, error } = await sb.from('nuvemshop_vinculos').insert({
    store_id: nuvemshopStoreId,
    produto_id: localProduct.id,
    voltagem: localProduct.tem_voltagem ? nuvemshopManualVoltage : null,
    nuvemshop_produto_id: row.productId,
    nuvemshop_variante_id: row.variantId,
    nuvemshop_sku: row.sku || null,
    unidades_por_venda: unitsPerSale,
    ativo: true
  }).select('id').single();

  button.disabled = false;
  button.textContent = 'Confirmar vinculo';
  if (error) {
    console.error('Falha ao salvar vinculo manual Nuvemshop', error);
    errorElement.textContent = error.message.includes('duplicate key')
      ? 'Esta variante da Nuvemshop ja possui um vinculo ativo.'
      : `Nao foi possivel salvar: ${error.message}`;
    return;
  }

  row.status = 'linked';
  row.localProduct = localProduct;
  row.candidates = [];
  row.linkVoltage = localProduct.tem_voltagem ? nuvemshopManualVoltage : null;
  row.localStock = mappedLocalStock(localProduct, row.linkVoltage);
  row.savedLinkId = data.id;
  row.unitsPerSale = unitsPerSale;
  closeManualNuvemshopLink();
  if (nuvemshopPreviewGenerated) nuvemshopPreviewGeneratedAt = new Date();
  renderNuvemshopCatalog();
  showToast('green', 'Vinculo manual confirmado. Nenhum estoque foi alterado.');
}

function localDateValue(date = new Date()) {
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return localTime.toISOString().slice(0, 10);
}

function setDefaultCsvMovementDate() {
  const input = document.getElementById('csv-movement-date');
  if (!input) return;
  input.max = localDateValue();
  if (!input.value) input.value = localDateValue();
}

function movementDateFromFileName(fileName) {
  const match = String(fileName || '').match(/(?:^|\D)(\d{1,2})[-_.](\d{1,2})(?:[-_.](\d{2,4}))?(?:\D|$)/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const now = new Date();
  let year = match[3] ? Number(match[3]) : now.getFullYear();
  if (year < 100) year += 2000;

  let candidate = new Date(year, month - 1, day, 12);
  if (!match[3] && candidate > now) {
    year -= 1;
    candidate = new Date(year, month - 1, day, 12);
  }

  if (
    candidate.getFullYear() !== year ||
    candidate.getMonth() !== month - 1 ||
    candidate.getDate() !== day
  ) return null;

  return localDateValue(candidate);
}

async function hashCsvContent(text) {
  const normalized = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  const bytes = new TextEncoder().encode(normalized);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (inQuotes && next === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === ',' && !inQuotes) {
      row.push(current.trim());
      current = '';
      continue;
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') i++;
      row.push(current.trim());
      if (row.some(cell => cell !== '')) rows.push(row);
      row = [];
      current = '';
      continue;
    }

    current += char;
  }

  row.push(current.trim());
  if (row.some(cell => cell !== '')) rows.push(row);
  return rows;
}

function parseBrazilianQty(value) {
  const clean = String(value || '').replace(/\s/g, '').replace(/\./g, '').replace(',', '.');
  const parsed = Number(clean);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round(parsed));
}

function findHeaderIndex(headers, acceptedNames, fallbackIndex) {
  const normalized = headers.map(normalizeHeader);
  const foundIndex = normalized.findIndex(header => acceptedNames.includes(header));
  return foundIndex >= 0 ? foundIndex : fallbackIndex;
}

function readCsvQty(row, qtyIndex) {
  if (qtyIndex >= 0 && row[qtyIndex]) return row[qtyIndex];
  return row.slice(2).filter(Boolean).pop() || '';
}

function csvRowsToItems(rows) {
  if (rows.length < 2) return [];

  const headers = rows[0] || [];
  const refIndex = findHeaderIndex(headers, ['ref', 'referencia'], 0);
  const descIndex = findHeaderIndex(headers, ['descricao', 'produto', 'nome'], 1);
  const barcodeIndex = findHeaderIndex(headers, ['codigodebarra', 'codigobarra', 'codigobarras', 'codbarra', 'barras'], 8);
  const qtyIndex = findHeaderIndex(headers, ['qtde', 'qtd', 'quantidade'], -1);

  return rows.slice(1).map(row => {
    const ref = row[refIndex] || '';
    const descricao = row[descIndex] || '';
    const barcode = row[barcodeIndex] || '';
    const rawQty = readCsvQty(row, qtyIndex);
    return { ref, descricao, barcode, quantidade: parseBrazilianQty(rawQty), rawQty };
  }).filter(item => item.ref || item.descricao || item.barcode || item.quantidade);
}

function summarizeCsvItems(items) {
  const grouped = new Map();

  items.forEach(item => {
    const key = `${normalizeCode(item.ref)}|${normalizeCode(item.barcode)}|${normalizeCode(item.descricao)}`;
    const current = grouped.get(key);

    if (current) {
      current.quantidade += item.quantidade;
      current.rawQty = String(current.quantidade);
    } else {
      grouped.set(key, { ...item });
    }
  });

  return Array.from(grouped.values());
}

function productMatchesCsvItem(product, item) {
  const ref = normalizeCode(item.ref);
  const barcode = normalizeCode(item.barcode);

  if (ref && (
    normalizeCode(product.codigo_referencia) === ref ||
    normalizeCode(product.codigo_interno) === ref ||
    String(product.id) === ref
  )) return 'Referencia';

  if (barcode && (
    normalizeCode(product.sku) === barcode ||
    normalizeCode(product.codigo_interno) === barcode ||
    normalizeCode(product.codigo_referencia) === barcode
  )) return 'Codigo de barras';

  return null;
}

function findProductForCsvItem(item) {
  const productItems = products.filter(p => (p.categoria || 'maquina') === 'produto');
  const machineItems = products.filter(p => (p.categoria || 'maquina') !== 'produto');

  for (const product of productItems) {
    const matchBy = productMatchesCsvItem(product, item);
    if (matchBy) return { product, matchBy, ignoredMachine: null };
  }

  for (const machine of machineItems) {
    const matchBy = productMatchesCsvItem(machine, item);
    if (matchBy) return { product: null, matchBy, ignoredMachine: machine };
  }

  return { product: null, matchBy: null, ignoredMachine: null };
}

function csvApplicableRows() {
  return csvPreviewRows.filter(row => row.product && row.item.quantidade > 0 && row.afterQty >= 0);
}

function updateCsvApplyState() {
  const btn = document.getElementById('csv-apply-btn');
  const msg = document.getElementById('csv-apply-message');
  if (!btn || !msg) return;

  msg.className = 'csv-apply-message';
  const applicable = csvApplicableRows();
  const invalid = csvPreviewRows.filter(row => row.product && row.item.quantidade <= 0).length;
  const insufficient = csvPreviewRows.filter(row => row.product && row.afterQty < 0).length;
  const movementDate = document.getElementById('csv-movement-date')?.value || '';

  if (csvPreviewApplied) {
    btn.disabled = true;
    btn.textContent = 'Baixa aplicada';
    msg.classList.add('ok');
    msg.textContent = 'CSV aplicado. Se precisar repetir, selecione o arquivo novamente.';
    return;
  }

  btn.textContent = applicable.length ? `Aplicar baixa (${applicable.length})` : 'Aplicar baixa';
  btn.disabled = !applicable.length || invalid > 0 || insufficient > 0 || !movementDate || !csvPreviewHash || csvDuplicateCheckPending || !!csvDuplicateLot;

  if (!movementDate) {
    msg.classList.add('err');
    msg.textContent = 'Informe a data do movimento.';
  } else if (csvDuplicateCheckPending) {
    msg.textContent = 'Verificando se este arquivo CSV ja foi aplicado...';
  } else if (csvDuplicateLot) {
    msg.classList.add('err');
    msg.textContent = 'Este arquivo CSV ja foi aplicado anteriormente. Selecione outro arquivo.';
  } else if (!csvPreviewRows.length) {
    msg.textContent = '';
  } else if (invalid > 0) {
    msg.classList.add('err');
    msg.textContent = 'Existe produto encontrado com quantidade invalida.';
  } else if (insufficient > 0) {
    msg.classList.add('err');
    msg.textContent = 'Existe produto encontrado com estoque insuficiente.';
  } else if (applicable.length) {
    msg.textContent = 'Somente produtos encontrados serao baixados; maquinas e nao encontrados ficam de fora.';
  } else {
    msg.textContent = 'Nenhum produto valido para aplicar.';
  }
}

function renderCsvDuplicateWarning() {
  const warningEl = document.getElementById('csv-duplicate-warning');
  if (!warningEl) return;

  if (!csvDuplicateLot) {
    warningEl.hidden = true;
    warningEl.textContent = '';
    return;
  }

  const appliedAt = csvDuplicateLot.created_at
    ? new Date(csvDuplicateLot.created_at).toLocaleString('pt-BR')
    : 'em uma data anterior';
  const appliedBy = csvDuplicateLot.aplicado_email || 'um administrador';
  const totalApplied = Number(csvDuplicateLot.total_aplicado || 0);
  const quantityText = totalApplied
    ? `, com ${totalApplied} unidade${totalApplied === 1 ? '' : 's'} baixada${totalApplied === 1 ? '' : 's'}`
    : '';

  const movementLabel = csvDuplicateLot.data_movimento
    ? new Date(`${csvDuplicateLot.data_movimento}T12:00:00`).toLocaleDateString('pt-BR')
    : '';

  warningEl.textContent = `Atencao: este mesmo arquivo ja foi aplicado${movementLabel ? ` no movimento de ${movementLabel}` : ''} em ${appliedAt} por ${appliedBy}${quantityText}. O sistema bloqueia uma nova aplicacao mesmo se a data for alterada.`;
  warningEl.hidden = false;
}

async function loadCsvDuplicateWarning() {
  csvDuplicateLot = null;
  renderCsvDuplicateWarning();

  const requestedHash = csvPreviewHash;
  if (!requestedHash) {
    csvDuplicateCheckPending = false;
    updateCsvApplyState();
    return;
  }

  csvDuplicateCheckPending = true;
  updateCsvApplyState();

  const { data, error } = await sb
    .from('baixas_csv_lotes')
    .select('id, aplicado_email, total_aplicado, created_at, data_movimento')
    .eq('arquivo_hash', requestedHash)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (csvPreviewHash !== requestedHash) return;

  csvDuplicateCheckPending = false;
  if (error) {
    console.warn('Nao foi possivel verificar se este CSV ja foi aplicado.', error);
  } else {
    csvDuplicateLot = data;
    renderCsvDuplicateWarning();
  }

  updateCsvApplyState();
}

function handleCsvMovementDateChange() {
  updateCsvApplyState();
}

function clearCsvPreview() {
  csvPreviewRows = [];
  csvPreviewApplied = false;
  csvPreviewFileName = null;
  csvPreviewHash = null;
  csvDuplicateLot = null;
  csvDuplicateCheckPending = false;
  const input = document.getElementById('csv-baixa-input');
  const summaryEl = document.getElementById('csv-preview-summary');
  const wrapEl = document.getElementById('csv-preview-table-wrap');
  const tbody = document.getElementById('csv-preview-tbody');
  if (input) input.value = '';
  if (summaryEl) summaryEl.textContent = 'Nenhum arquivo selecionado.';
  if (wrapEl) wrapEl.style.display = 'none';
  if (tbody) tbody.innerHTML = '';
  renderCsvDuplicateWarning();
  updateCsvApplyState();
}

async function handleCsvPreview(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const summaryEl = document.getElementById('csv-preview-summary');
  const wrapEl = document.getElementById('csv-preview-table-wrap');
  const tbody = document.getElementById('csv-preview-tbody');

  csvPreviewRows = [];
  csvPreviewApplied = false;
  csvPreviewFileName = file.name;
  csvPreviewHash = null;
  csvDuplicateLot = null;
  csvDuplicateCheckPending = false;
  renderCsvDuplicateWarning();
  const detectedMovementDate = movementDateFromFileName(file.name);
  const movementInput = document.getElementById('csv-movement-date');
  if (detectedMovementDate && movementInput) movementInput.value = detectedMovementDate;
  updateCsvApplyState();
  summaryEl.textContent = 'Lendo arquivo...';
  wrapEl.style.display = 'none';
  tbody.innerHTML = '';

  const text = await file.text();
  try {
    csvPreviewHash = await hashCsvContent(text);
  } catch (error) {
    summaryEl.textContent = 'Nao foi possivel identificar o arquivo com seguranca.';
    updateCsvApplyState();
    return;
  }
  const rows = parseCsvText(text);
  const items = summarizeCsvItems(csvRowsToItems(rows));

  const previewRows = items.map(item => {
    const { product, matchBy, ignoredMachine } = findProductForCsvItem(item);
    const currentQty = product ? totalQty(product) : null;
    const afterQty = product ? currentQty - item.quantidade : null;
    let status = 'ok';
    let label = 'Encontrado';

    if (ignoredMachine) {
      status = 'muted';
      label = 'Maquina ignorada';
    } else if (!product) {
      status = 'err';
      label = 'Nao encontrado';
    } else if (item.quantidade <= 0) {
      status = 'warn';
      label = 'Qtd. invalida';
    } else if (afterQty < 0) {
      status = 'warn';
      label = 'Estoque insuf.';
    }

    return { item, product, ignoredMachine, matchBy, currentQty, afterQty, status, label };
  });
  csvPreviewRows = previewRows;

  const found = previewRows.filter(row => row.product).length;
  const ignoredMachines = previewRows.filter(row => row.ignoredMachine).length;
  const notFound = previewRows.filter(row => !row.product && !row.ignoredMachine).length;
  const insufficient = previewRows.filter(row => row.product && row.afterQty < 0).length;
  const totalQtyCsv = previewRows.reduce((sum, row) => sum + row.item.quantidade, 0);

  summaryEl.innerHTML = `
    <strong>${escapeHtml(file.name)}</strong> - ${previewRows.length} linha${previewRows.length === 1 ? '' : 's'} -
    ${found} produto${found === 1 ? '' : 's'} encontrado${found === 1 ? '' : 's'} -
    ${ignoredMachines} maquina${ignoredMachines === 1 ? '' : 's'} ignorada${ignoredMachines === 1 ? '' : 's'} -
    ${notFound} nao encontrado${notFound === 1 ? '' : 's'} -
    ${insufficient} com estoque insuficiente -
    total CSV: ${totalQtyCsv}
  `;

  if (!previewRows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Nenhuma linha valida encontrada no CSV.</td></tr>';
  } else {
    tbody.innerHTML = previewRows.map(row => {
      const foundLabel = row.product
        ? `<strong>${escapeHtml(row.product.nome)}</strong><div class="csv-muted">ID ${row.product.id}</div>`
        : row.ignoredMachine
          ? `<span class="csv-muted">${escapeHtml(row.ignoredMachine.nome)}</span>`
          : '<span class="csv-muted">-</span>';

      return `
        <tr>
          <td><span class="csv-status ${row.status}">${row.label}</span>${row.matchBy ? `<div class="csv-muted">por ${row.matchBy}</div>` : ''}</td>
          <td>${escapeHtml(row.item.ref || '-')}</td>
          <td>${escapeHtml(row.item.barcode || '-')}</td>
          <td>${escapeHtml(row.item.descricao || '-')}</td>
          <td>${foundLabel}</td>
          <td><strong>${row.item.quantidade}</strong><div class="csv-muted">${escapeHtml(row.item.rawQty || '')}</div></td>
          <td>${row.product ? row.currentQty : '-'}</td>
          <td>${row.product ? `<strong class="${row.afterQty < 0 ? 'qty-out' : ''}">${row.afterQty}</strong>` : '-'}</td>
        </tr>
      `;
    }).join('');
  }

  wrapEl.style.display = 'block';
  await loadCsvDuplicateWarning();
  updateCsvApplyState();
}

async function confirmCsvBaixa() {
  const btn = document.getElementById('csv-apply-btn');
  const msg = document.getElementById('csv-apply-message');
  const applicable = csvApplicableRows();
  const invalid = csvPreviewRows.filter(row => row.product && row.item.quantidade <= 0).length;
  const insufficient = csvPreviewRows.filter(row => row.product && row.afterQty < 0).length;
  const movementDate = document.getElementById('csv-movement-date')?.value || '';

  if (!applicable.length || invalid > 0 || insufficient > 0 || csvPreviewApplied || !movementDate || !csvPreviewHash || csvDuplicateCheckPending || csvDuplicateLot) {
    updateCsvApplyState();
    return;
  }

  const movementLabel = new Date(`${movementDate}T12:00:00`).toLocaleDateString('pt-BR');
  const ok = confirm(`Aplicar o fechamento de ${movementLabel} em ${applicable.length} produto${applicable.length === 1 ? '' : 's'} encontrado${applicable.length === 1 ? '' : 's'}?`);
  if (!ok) return;

  btn.disabled = true;
  btn.textContent = 'Aplicando...';
  msg.className = 'csv-apply-message';
  msg.textContent = '';

  const itens = applicable.map(row => ({
    produto_id: row.product.id,
    quantidade: row.item.quantidade,
    referencia: row.item.ref || null,
    codigo_barras: row.item.barcode || null,
    descricao: row.item.descricao || null,
    match_by: row.matchBy || null
  }));

  const resumo = {
    total_linhas: csvPreviewRows.length,
    produtos_encontrados: csvPreviewRows.filter(row => row.product).length,
    maquinas_ignoradas: csvPreviewRows.filter(row => row.ignoredMachine).length,
    nao_encontrados: csvPreviewRows.filter(row => !row.product && !row.ignoredMachine).length,
    estoque_insuficiente: csvPreviewRows.filter(row => row.product && row.afterQty < 0).length,
    total_csv: csvPreviewRows.reduce((sum, row) => sum + row.item.quantidade, 0)
  };

  const { data, error } = await sb.rpc('registrar_fechamento_csv_produtos', {
    p_itens: itens,
    p_arquivo_nome: csvPreviewFileName,
    p_resumo: resumo,
    p_arquivo_hash: csvPreviewHash,
    p_data_movimento: movementDate
  });

  if (error) {
    btn.disabled = false;
    updateCsvApplyState();
    msg.className = 'csv-apply-message err';
    msg.textContent = error.message || 'Nao foi possivel aplicar a baixa por CSV.';
    return;
  }

  csvPreviewApplied = true;
  msg.className = 'csv-apply-message ok';
  msg.textContent = `${data?.length || applicable.length} baixa${(data?.length || applicable.length) === 1 ? '' : 's'} aplicada${(data?.length || applicable.length) === 1 ? '' : 's'} com sucesso.`;
  await loadProducts();
  await loadHistory();
  await loadCsvLots();
  updateCsvApplyState();
}

// ─── VENDEDORES ──────────────────────────────────────────
let resetSenhaTargetId = null;

async function loadVendedores() {
  const { data } = await sb.from('vendedores').select('*').order('nome');
  vendedores = data || [];
  renderVendedoresList();
  renderVendedorSelect();
}

function renderVendedoresList() {
  const el = document.getElementById('vendedores-list');
  if (!vendedores.length) { el.innerHTML = '<tr><td colspan="3" class="empty-state">Nenhum vendedor cadastrado ainda.</td></tr>'; return; }
  el.innerHTML = vendedores.map(v => {
    const loginInfo = v.usuario
      ? `<span class="code-tag" style="font-size:11px">${v.usuario}</span>`
      : `<span style="color:var(--muted);font-size:11px">Sem login (só na lista)</span>`;
    const resetBtn = v.usuario
      ? `<button class="btn-edit" onclick="openResetSenhaModal(${v.id}, '${v.nome.replace(/'/g, "\\'")}')">Redefinir senha</button>`
      : '';
    return `<tr>
      <td><strong>${v.nome}</strong></td>
      <td>${loginInfo}</td>
      <td><div class="action-cell">${resetBtn}<button class="btn-delete" onclick="openDeleteVendedorModal(${v.id})">Remover</button></div></td>
    </tr>`;
  }).join('');
}

function renderVendedorSelect() {
  const sel = document.getElementById('baixa-vendedor');
  sel.innerHTML = '<option value="">Selecione...</option>' + vendedores.map(v => `<option value="${v.nome}">${v.nome}</option>`).join('');

  const filterSel = document.getElementById('filter-vendedor');
  if (filterSel) {
    const current = filterSel.value;
    filterSel.innerHTML = '<option value="">Todos os vendedores</option>' + vendedores.map(v => `<option value="${v.nome}">${v.nome}</option>`).join('');
    filterSel.value = current;
  }
}

async function addVendedor() {
  const nomeInput = document.getElementById('new-vendedor-nome');
  const usuarioInput = document.getElementById('new-vendedor-usuario');
  const senhaInput = document.getElementById('new-vendedor-senha');
  const errorEl = document.getElementById('vendedor-error');
  const successEl = document.getElementById('vendedor-success');
  errorEl.textContent = ''; successEl.textContent = '';

  const nome = nomeInput.value.trim();
  const usuario = usuarioInput.value.trim().toLowerCase();
  const senha = senhaInput.value;

  if (!nome) { errorEl.textContent = 'O nome é obrigatório.'; return; }

  if (usuario && !senha) { errorEl.textContent = 'Defina uma senha para criar o login, ou deixe os dois campos em branco.'; return; }
  if (!usuario && senha) { errorEl.textContent = 'Defina um nome de usuário para criar o login.'; return; }
  if (senha && senha.length < 6) { errorEl.textContent = 'A senha deve ter pelo menos 6 caracteres.'; return; }

  let authUserId = null;

  if (usuario && senha) {
    const { data, error } = await sb.functions.invoke('criar-vendedor', {
      body: { acao: 'criar', usuario, senha }
    });
    if (error || data?.error) {
      errorEl.textContent = data?.error || 'Erro ao criar login. Verifique se o usuário já existe.';
      return;
    }
    authUserId = data.authUserId;
  }

  const insertBody = { nome };
  if (usuario) insertBody.usuario = usuario;
  if (authUserId) insertBody.auth_user_id = authUserId;

  const { error: insertError } = await sb.from('vendedores').insert(insertBody);
  if (insertError) {
    errorEl.textContent = 'Vendedor não pôde ser salvo: ' + insertError.message;
    return;
  }

  nomeInput.value = ''; usuarioInput.value = ''; senhaInput.value = '';
  successEl.textContent = 'Vendedor adicionado com sucesso!';
  setTimeout(() => successEl.textContent = '', 3000);
  await loadVendedores();
}

function openDeleteVendedorModal(id) { deleteVendedorId = id; document.getElementById('delete-vendedor-modal').classList.add('open'); }
function closeDeleteVendedorModal() { deleteVendedorId = null; document.getElementById('delete-vendedor-modal').classList.remove('open'); }
async function confirmDeleteVendedor() {
  if (!deleteVendedorId) return;
  const v = vendedores.find(x => x.id === deleteVendedorId);

  if (v && v.auth_user_id) {
    await sb.functions.invoke('criar-vendedor', { body: { acao: 'remover', authUserId: v.auth_user_id } });
  }

  await sb.from('vendedores').delete().eq('id', deleteVendedorId);
  closeDeleteVendedorModal();
  await loadVendedores();
}

function openResetSenhaModal(id, nome) {
  resetSenhaTargetId = id;
  document.getElementById('reset-senha-nome').textContent = `Definir nova senha de login para ${nome}.`;
  document.getElementById('reset-senha-input').value = '';
  document.getElementById('reset-senha-error').textContent = '';
  document.getElementById('reset-senha-modal').classList.add('open');
}
function closeResetSenhaModal() {
  resetSenhaTargetId = null;
  document.getElementById('reset-senha-modal').classList.remove('open');
}
async function confirmResetSenha() {
  const errorEl = document.getElementById('reset-senha-error');
  errorEl.textContent = '';
  const novaSenha = document.getElementById('reset-senha-input').value;

  if (!novaSenha || novaSenha.length < 6) { errorEl.textContent = 'A senha deve ter pelo menos 6 caracteres.'; return; }

  const v = vendedores.find(x => x.id === resetSenhaTargetId);
  if (!v || !v.auth_user_id) { errorEl.textContent = 'Este vendedor não tem login.'; return; }

  const { data, error } = await sb.functions.invoke('criar-vendedor', {
    body: { acao: 'redefinir_senha', authUserId: v.auth_user_id, senha: novaSenha }
  });

  if (error || data?.error) { errorEl.textContent = data?.error || 'Erro ao redefinir a senha.'; return; }

  closeResetSenhaModal();
}

// ─── PAINEL DE BAIXA ─────────────────────────────────────
function openBaixaPanel(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  if (!isProductActive(p)) {
    showToast('red', 'Produto inativo não pode receber baixa.');
    return;
  }
  const safeProductName = escapeHtml(p.nome || 'Produto');
  baixaProduto = p;
  baixaVoltagemSelecionada = null;

  document.getElementById('baixa-prod-info').innerHTML = `
    ${p.imagem_url
      ? `<img class="baixa-prod-img" src="${p.imagem_url}" onerror="this.outerHTML='<div class=baixa-prod-img-ph>📦</div>'">`
      : `<div class="baixa-prod-img-ph">📦</div>`}
    <div>
      <div class="baixa-prod-name">${safeProductName}</div>
      <div class="baixa-prod-qty">${p.tem_voltagem ? `110V: ${p.quantidade_110v} · 220V: ${p.quantidade_220v}` : `Estoque atual: ${p.quantidade}`}</div>
    </div>`;

  const voltWrap = document.getElementById('baixa-volt-choice-wrap');
  if (p.tem_voltagem) {
    voltWrap.style.display = 'block';
    document.getElementById('baixa-volt-choice').innerHTML = `
      <div class="volt-choice-btn" id="vc-110" onclick="selectBaixaVolt('v110')">
        <div class="vc-label">110V</div><div class="vc-qty">${p.quantidade_110v} em estoque</div>
      </div>
      <div class="volt-choice-btn" id="vc-220" onclick="selectBaixaVolt('v220')">
        <div class="vc-label">220V</div><div class="vc-qty">${p.quantidade_220v} em estoque</div>
      </div>`;
  } else {
    voltWrap.style.display = 'none';
  }

  document.getElementById('baixa-qty').value = '';
  document.getElementById('baixa-vendedor').value = '';
  document.getElementById('baixa-error').textContent = '';
  updateBaixaPreview();

  document.getElementById('baixa-overlay').classList.add('open');
  document.getElementById('baixa-panel').classList.add('open');
}

function closeBaixaPanel() {
  document.getElementById('baixa-overlay').classList.remove('open');
  document.getElementById('baixa-panel').classList.remove('open');
  baixaProduto = null;
  baixaVoltagemSelecionada = null;
}

function selectBaixaVolt(volt) {
  baixaVoltagemSelecionada = volt;
  document.getElementById('vc-110').classList.toggle('selected', volt === 'v110');
  document.getElementById('vc-220').classList.toggle('selected', volt === 'v220');
  updateBaixaPreview();
}

function currentBaixaEstoqueAtual() {
  if (!baixaProduto) return 0;
  if (!baixaProduto.tem_voltagem) return baixaProduto.quantidade;
  if (baixaVoltagemSelecionada === 'v110') return baixaProduto.quantidade_110v;
  if (baixaVoltagemSelecionada === 'v220') return baixaProduto.quantidade_220v;
  return null;
}

function updateBaixaPreview() {
  const display = document.getElementById('baixa-preview-value');
  const atual = currentBaixaEstoqueAtual();
  const qtyInput = parseInt(document.getElementById('baixa-qty').value) || 0;

  if (atual === null) { display.textContent = 'Selecione a voltagem'; display.classList.remove('negative'); return; }

  const resultado = atual - qtyInput;
  display.textContent = resultado;
  display.classList.toggle('negative', resultado < 0);
}

async function confirmBaixa() {
  const errorEl = document.getElementById('baixa-error');
  errorEl.textContent = '';

  if (!baixaProduto) return;
  if (baixaProduto.tem_voltagem && !baixaVoltagemSelecionada) { errorEl.textContent = 'Selecione a voltagem.'; return; }

  const qty = parseInt(document.getElementById('baixa-qty').value) || 0;
  if (qty <= 0) { errorEl.textContent = 'Informe uma quantidade válida.'; return; }

  const vendedor = document.getElementById('baixa-vendedor').value;
  if (!vendedor) { errorEl.textContent = 'Selecione quem está dando a baixa.'; return; }

  const atual = currentBaixaEstoqueAtual();
  if (qty > atual) { errorEl.textContent = `Quantidade maior que o estoque disponível (${atual}).`; return; }

  const btn = document.getElementById('btn-confirm-baixa');
  btn.disabled = true; btn.textContent = 'Salvando...';

  let voltLabel = null;

  if (baixaProduto.tem_voltagem) {
    voltLabel = baixaVoltagemSelecionada === 'v110' ? '110V' : '220V';
  }

  const { data, error } = await sb.rpc('registrar_baixa_administrativa', {
    p_produto_id: baixaProduto.id,
    p_quantidade: qty,
    p_vendedor: vendedor,
    p_voltagem: voltLabel
  });

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Confirmar baixa';
    errorEl.textContent = error.message || 'Não foi possível registrar a baixa.';
    return;
  }

  const resultado = Array.isArray(data) ? data[0] : data;
  if (resultado) {
    pushHistoryNotification({
      id: resultado.historico_id,
      produto_id: resultado.produto_id,
      quantidade_anterior: resultado.quantidade_anterior,
      quantidade_nova: resultado.quantidade_nova,
      usuario: resultado.usuario,
      vendedor: resultado.vendedor,
      voltagem: resultado.voltagem,
      tipo: resultado.tipo,
      created_at: resultado.created_at
    });
  }

  btn.disabled = false; btn.textContent = 'Confirmar baixa';
  closeBaixaPanel();
  await loadProducts();
}

// ─── HISTÓRICO ───────────────────────────────────────────
let historyRows = [];

async function loadCsvLots(resetPage = false) {
  const el = document.getElementById('csv-lots-list');
  if (!el) return;

  if (resetPage) csvLotsPage = 1;
  const startIndex = (csvLotsPage - 1) * csvLotsPageSize;
  const endIndex = startIndex + csvLotsPageSize - 1;
  el.innerHTML = '<div class="empty-state">Carregando importacoes...</div>';

  const { data, error, count } = await sb
    .from('baixas_csv_lotes')
    .select('*, baixas_csv_itens(*)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(startIndex, endIndex);

  if (error) {
    csvLots = [];
    csvLotsTotal = 0;
    if (csvLotsPage === 1) {
      dashboardLatestCsvLot = null;
      dashboardFirstCsvPage = [];
    }
    el.innerHTML = '<div class="empty-state">Relatorio de CSV ainda nao configurado no Supabase.</div>';
    renderCsvLotsPagination();
    renderDashboardResolverToday();
    return;
  }

  csvLotsTotal = count || 0;
  const totalPages = Math.max(1, Math.ceil(csvLotsTotal / csvLotsPageSize));
  if (csvLotsPage > totalPages) {
    csvLotsPage = totalPages;
    await loadCsvLots();
    return;
  }

  csvLots = data || [];
  if (csvLotsPage === 1) {
    dashboardLatestCsvLot = csvLots[0] || null;
    dashboardFirstCsvPage = csvLots.slice();
  }
  renderCsvLots();
  renderDashboardResolverToday();
}

function toggleCsvLot(lotId) {
  const key = String(lotId);
  if (csvExpandedLots.has(key)) csvExpandedLots.delete(key);
  else csvExpandedLots.add(key);
  renderCsvLots();
}

function changeCsvLotsPage(delta) {
  setCsvLotsPage(csvLotsPage + delta);
}

function setCsvLotsPage(page) {
  const totalPages = Math.max(1, Math.ceil(csvLotsTotal / csvLotsPageSize));
  const requestedPage = page === 'last' ? totalPages : Number(page);
  if (!Number.isFinite(requestedPage)) return;

  const nextPage = Math.min(Math.max(1, requestedPage), totalPages);
  if (nextPage === csvLotsPage) return;

  csvLotsPage = nextPage;
  csvExpandedLots.clear();
  loadCsvLots();
  document.getElementById('csv-lots-heading')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCsvLotsPagination() {
  const pagination = document.getElementById('csv-lots-pagination');
  const summary = document.getElementById('csv-lots-pagination-summary');
  const pageInfo = document.getElementById('csv-lots-page-info');
  const firstButton = document.getElementById('csv-lots-page-first');
  const previousButton = document.getElementById('csv-lots-page-prev');
  const nextButton = document.getElementById('csv-lots-page-next');
  const lastButton = document.getElementById('csv-lots-page-last');
  if (!pagination || !summary || !pageInfo || !firstButton || !previousButton || !nextButton || !lastButton) return;

  if (!csvLotsTotal) {
    pagination.style.display = 'none';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(csvLotsTotal / csvLotsPageSize));
  const startItem = (csvLotsPage - 1) * csvLotsPageSize + 1;
  const endItem = Math.min(csvLotsPage * csvLotsPageSize, csvLotsTotal);
  pagination.style.display = 'flex';
  summary.textContent = `Exibindo ${startItem}-${endItem} de ${csvLotsTotal} importacoes`;
  pageInfo.textContent = `Pagina ${csvLotsPage} de ${totalPages}`;
  firstButton.disabled = csvLotsPage === 1;
  previousButton.disabled = csvLotsPage === 1;
  nextButton.disabled = csvLotsPage === totalPages;
  lastButton.disabled = csvLotsPage === totalPages;
}

function renderCsvLots() {
  const el = document.getElementById('csv-lots-list');
  if (!el) return;

  if (!csvLots.length) {
    el.innerHTML = '<div class="empty-state">Nenhuma importacao CSV registrada ainda.</div>';
    renderCsvLotsPagination();
    return;
  }

  el.innerHTML = csvLots.map(lote => {
    const lotKey = String(lote.id);
    const expanded = csvExpandedLots.has(lotKey);
    const detailId = `csv-lot-details-${lotKey}`;
    const time = new Date(lote.created_at).toLocaleString('pt-BR');
    const movementDate = lote.data_movimento
      ? new Date(`${lote.data_movimento}T12:00:00`).toLocaleDateString('pt-BR')
      : 'nao informada';
    const itens = (lote.baixas_csv_itens || []).slice().sort((a, b) => a.produto_nome.localeCompare(b.produto_nome));
    const details = `<div class="csv-lot-details" id="${escapeHtml(detailId)}"${expanded ? '' : ' hidden'}>
          ${itens.map(item => `
            <div class="csv-lot-item">
              <div>
                <strong>${escapeHtml(item.produto_nome)}</strong>
                <div class="csv-muted">${escapeHtml(item.descricao_csv || '')}${item.referencia ? ` · Ref: ${escapeHtml(item.referencia)}` : ''}</div>
              </div>
              <div class="csv-lot-stat"><strong>${item.quantidade_csv}</strong>baixado</div>
              <div class="csv-lot-stat"><strong>${item.quantidade_anterior}</strong>antes</div>
              <div class="csv-lot-stat"><strong>${item.quantidade_nova}</strong>depois</div>
            </div>
          `).join('') || '<div class="empty-state">Nenhum item detalhado neste lote.</div>'}
        </div>`;

    return `<div class="csv-lot-card">
      <button type="button" class="csv-lot-toggle" onclick='toggleCsvLot(${JSON.stringify(lotKey)})' aria-expanded="${expanded}" aria-controls="${escapeHtml(detailId)}">
        <span class="csv-lot-main">
          <span class="csv-lot-heading">
            <span class="csv-lot-title">${escapeHtml(lote.arquivo_nome || 'CSV aplicado')}</span>
            <span class="csv-lot-meta">Movimento ${movementDate} · aplicado em ${time} · ${escapeHtml(lote.aplicado_email || 'admin')}</span>
          </span>
          <span class="csv-lot-stat"><strong>${lote.produtos_encontrados || 0}</strong>encontrados</span>
          <span class="csv-lot-stat"><strong>${lote.total_aplicado || 0}</strong>pecas baixadas</span>
          <span class="csv-lot-stat"><strong>${lote.nao_encontrados || 0}</strong>nao encontrados</span>
          <span class="csv-lot-stat"><strong>${lote.maquinas_ignoradas || 0}</strong>maquinas</span>
          <span class="csv-lot-stat"><strong>${lote.estoque_insuficiente || 0}</strong>insuficiente</span>
          <span class="csv-lot-chevron" aria-hidden="true">&#9662;</span>
        </span>
      </button>
      ${details}
    </div>`;
  }).join('');
  renderCsvLotsPagination();
}

async function loadHistory() {
  const { data } = await sb.from('historico').select('*, produtos(nome, imagem_url)').order('created_at', { ascending: false }).limit(200);
  historyRows = data || [];
  renderHistory();
  renderDashboardResolverToday();
}

function historyRowType(row) {
  const tipo = String(row.tipo || '');
  if (tipo === 'baixa_csv_produto') return 'csv';
  if (tipo === 'baixa_manual_produto') return 'manual';
  if (isBaixaTipo(tipo)) return 'baixa';
  return 'entrada';
}

function historyRowDelta(row) {
  return Math.abs((row.quantidade_nova || 0) - (row.quantidade_anterior || 0));
}

function updateHistorySummary(rows) {
  const cards = document.querySelectorAll('#history-summary-grid .history-summary-card strong');
  if (!cards.length) return;

  const entradas = rows.filter(row => historyRowType(row) === 'entrada').reduce((sum, row) => sum + historyRowDelta(row), 0);
  const baixas = rows.filter(row => historyRowType(row) !== 'entrada').reduce((sum, row) => sum + historyRowDelta(row), 0);
  const totalPecas = rows.reduce((sum, row) => sum + historyRowDelta(row), 0);

  cards[0].textContent = rows.length;
  cards[1].textContent = entradas;
  cards[2].textContent = baixas;
  cards[3].textContent = totalPecas;
}

function getFilteredHistoryRows() {
  const q = (document.getElementById('search-historico')?.value || '').toLowerCase();
  const typeFilter = document.getElementById('filter-historico-tipo')?.value || '';
  const periodValue = document.getElementById('filter-historico-periodo')?.value || '';
  const since = periodValue ? new Date(Date.now() - Number(periodValue) * 24 * 60 * 60 * 1000) : null;
  return historyRows.filter(r => {
    const matchesSearch =
      (r.produtos?.nome || '').toLowerCase().includes(q) ||
      (r.usuario || '').toLowerCase().includes(q) ||
      (r.vendedor || '').toLowerCase().includes(q);
    const rowType = historyRowType(r);
    const matchesType = !typeFilter || rowType === typeFilter || (typeFilter === 'baixa' && rowType !== 'entrada');
    const matchesPeriod = !since || new Date(r.created_at) >= since;
    return matchesSearch && matchesType && matchesPeriod;
  });
}

function historyTypeLabel(row) {
  const type = historyRowType(row);
  if (type === 'csv') return 'Baixa CSV';
  if (type === 'manual') return 'Baixa manual';
  if (type === 'baixa') return 'Baixa';
  return 'Entrada / contagem';
}

function renderHistory() {
  const rows = getFilteredHistoryRows();
  updateHistorySummary(rows);
  const el = document.getElementById('history-list');
  if (!rows.length) { el.innerHTML = '<div class="empty-state">Nenhuma atualização encontrada.</div>'; return; }
  el.innerHTML = rows.map(r => {
    const up = r.quantidade_nova >= r.quantidade_anterior;
    const isBaixa = isBaixaTipo(r.tipo);
    const time = new Date(r.created_at).toLocaleString('pt-BR');
    const thumb = r.produtos?.imagem_url
      ? `<img src="${r.produtos.imagem_url}" style="width:36px;height:36px;border-radius: 4px;object-fit:cover;border:1px solid var(--border);flex-shrink:0" onerror="this.style.display='none'">`
      : `<div style="width:36px;height:36px;border-radius: 4px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">📦</div>`;
    const voltTag = r.voltagem ? `<span class="volt-tag" style="margin-left:6px">${r.voltagem}</span>` : '';
    const tipoTag = isBaixa ? `<span class="history-type-tag">Baixa</span>` : '';
    const quemTexto = isBaixa ? `vendido por ${r.vendedor || r.usuario || '—'}` : `por ${r.usuario || 'Funcionário'}`;
    return `<div class="history-item">
      ${thumb}
      <div class="history-icon ${isBaixa ? 'baixa' : (up ? 'up' : 'down')}">${isBaixa ? '↓' : (up ? '▲' : '▼')}</div>
      <div class="history-body">
        <div class="history-product">${r.produtos?.nome || 'Produto'} ${voltTag} ${tipoTag}</div>
        <div class="history-detail">${r.quantidade_anterior} → ${r.quantidade_nova} &nbsp;·&nbsp; ${quemTexto}</div>
      </div>
      <div class="history-time">${time}</div>
    </div>`;
  }).join('');
}

function csvCell(value) {
  const text = String(value ?? '');
  return `"${text.replace(/"/g, '""')}"`;
}

function exportHistoryCsv() {
  const rows = getFilteredHistoryRows();
  if (!rows.length) {
    alert('Nenhuma movimentacao para exportar com os filtros atuais.');
    return;
  }

  const header = [
    'Data',
    'Produto',
    'Tipo',
    'Quantidade anterior',
    'Quantidade nova',
    'Diferenca',
    'Usuario',
    'Vendedor',
    'Voltagem'
  ];

  const lines = rows.map(row => [
    new Date(row.created_at).toLocaleString('pt-BR'),
    row.produtos?.nome || 'Produto',
    historyTypeLabel(row),
    row.quantidade_anterior,
    row.quantidade_nova,
    historyRowDelta(row),
    row.usuario || '',
    row.vendedor || '',
    row.voltagem || ''
  ].map(csvCell).join(';'));

  const csv = '\uFEFF' + [header.map(csvCell).join(';'), ...lines].join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const stamp = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `historico-estoque-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── REALTIME ────────────────────────────────────────────
function subscribeRealtime() {
  sb.channel('estoque-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'produtos' }, async (payload) => {
      await loadProducts();
      if (payload.eventType === 'UPDATE' && payload.new?.id) {
        const row = document.getElementById(`row-${payload.new.id}`);
        if (row) { row.classList.remove('new-flash'); void row.offsetWidth; row.classList.add('new-flash'); }
      }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'historico' }, async (payload) => {
      await loadHistory();
      pushHistoryNotification(payload.new);
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'baixas_csv_lotes' }, async () => {
      await loadCsvLots(true);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vendedores' }, async () => { await loadVendedores(); })
    .subscribe();
}

// ─── TABS ────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', ['dashboard','produtos','nuvemshop','vendedores','historico'][i] === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  if (name === 'nuvemshop') {
    renderNuvemshopWorkflow();
    loadNuvemshopCatalog();
    loadNuvemshopAuditHistory();
  }
}

document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('new-vendedor-nome').addEventListener('keydown', e => { if (e.key === 'Enter') addVendedor(); });
document.getElementById('new-vendedor-usuario').addEventListener('keydown', e => { if (e.key === 'Enter') addVendedor(); });
document.getElementById('new-vendedor-senha').addEventListener('keydown', e => { if (e.key === 'Enter') addVendedor(); });

// ─── TEMA (escuro/claro) ─────────────────────────────────
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
    document.getElementById('theme-icon').textContent = '🌙';
  } else {
    document.documentElement.removeAttribute('data-theme');
    document.getElementById('theme-icon').textContent = '☀️';
  }
}

function toggleTheme() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const next = isLight ? 'dark' : 'light';
  localStorage.setItem('admin-theme', next);
  applyTheme(next);
}

(function initTheme() {
  const saved = localStorage.getItem('admin-theme');
  applyTheme(saved === 'light' ? 'light' : 'dark');
})();

checkSession();
function escapeCsvImportHistoryHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function formatCsvImportHistoryMovement(value) {
  const parts = String(value || '').split('-');
  if (parts.length === 3 && parts[0].length === 4) return `${parts[2]}/${parts[1]}/${parts[0]}`;
  return '-';
}

function formatCsvImportHistoryCreatedAt(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short'
  }).format(date);
}

async function loadCsvImportHistory() {
  const statusEl = document.getElementById('csv-import-history-status');
  const tbody = document.getElementById('csv-import-history-tbody');
  if (!statusEl || !tbody) return;

  statusEl.className = 'csv-import-history-status';
  statusEl.textContent = 'Carregando importacoes...';
  tbody.innerHTML = '';

  const { data, error } = await sb
    .from('baixas_csv_lotes')
    .select('id, aplicado_email, total_aplicado, created_at, data_movimento')
    .order('created_at', { ascending: false })
    .limit(15);

  if (error) {
    statusEl.classList.add('error');
    statusEl.textContent = `Nao foi possivel carregar o historico: ${error.message}`;
    return;
  }

  const imports = data || [];
  statusEl.textContent = imports.length
    ? `Mostrando as ${imports.length} importacoes mais recentes.`
    : 'Nenhuma importacao CSV registrada.';

  tbody.innerHTML = imports.length
    ? imports.map((item) => `
        <tr>
          <td>${formatCsvImportHistoryMovement(item.data_movimento)}</td>
          <td>${formatCsvImportHistoryCreatedAt(item.created_at)}</td>
          <td><strong>${Number(item.total_aplicado || 0).toLocaleString('pt-BR')}</strong></td>
          <td>${escapeCsvImportHistoryHtml(item.aplicado_email || '-')}</td>
        </tr>
      `).join('')
    : '<tr><td colspan="4" class="csv-import-history-empty">Nenhuma importacao CSV registrada.</td></tr>';
}

function initCsvImportHistory() {
  const toggleBtn = document.getElementById('btn-toggle-csv-import-history');
  const refreshBtn = document.getElementById('btn-refresh-csv-import-history');
  const content = document.getElementById('csv-import-history-content');
  if (!toggleBtn || !refreshBtn || !content) return;

  toggleBtn.addEventListener('click', async () => {
    const opening = content.hidden;
    content.hidden = !opening;
    toggleBtn.textContent = opening ? 'Fechar' : 'Abrir';
    toggleBtn.setAttribute('aria-expanded', String(opening));
    refreshBtn.hidden = !opening;
    if (opening) await loadCsvImportHistory();
  });

  refreshBtn.addEventListener('click', loadCsvImportHistory);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initCsvImportHistory);
} else {
  initCsvImportHistory();
}
