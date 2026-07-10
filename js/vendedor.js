let products = [];
let vendedorAtual = null; // registro da tabela `vendedores` ligado ao login atual
let minhasBaixas = [];
let sellerHistoryOpen = false;
let realtimeChannel = null;

// Estado do painel de baixa
let baixaProduto = null;
let baixaVoltagemSelecionada = null;

// ─── AUTH ────────────────────────────────────────────────
async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    await loadVendedorAtual(session.user.id);
    if (vendedorAtual) {
      showApp();
      await Promise.all([loadProducts(), loadMinhasBaixas()]);
      subscribeRealtime();
    } else {
      await sb.auth.signOut();
    }
  }
}

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    cleanupRealtime();
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
  }
});

async function loadVendedorAtual(authUserId) {
  const { data } = await sb.from('vendedores').select('*').eq('auth_user_id', authUserId).maybeSingle();
  vendedorAtual = data || null;
}

async function doLogin() {
  const usuario = document.getElementById('login-usuario').value.trim().toLowerCase();
  const pass = document.getElementById('login-pass').value;
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('btn-login');
  errorEl.textContent = '';

  if (!usuario || !pass) { errorEl.textContent = 'Preencha usuário e senha.'; return; }

  btn.disabled = true; btn.textContent = 'Entrando...';

  const emailFake = `${usuario}@vendedor.estoque.local`;
  const { data, error } = await sb.auth.signInWithPassword({ email: emailFake, password: pass });

  btn.disabled = false; btn.textContent = 'Entrar';

  if (error) { errorEl.textContent = 'Usuário ou senha incorretos.'; return; }

  await loadVendedorAtual(data.user.id);
  if (!vendedorAtual) {
    errorEl.textContent = 'Este login não está vinculado a um vendedor. Fale com o administrador.';
    await sb.auth.signOut();
    return;
  }

  document.getElementById('user-name').textContent = vendedorAtual.nome;
  showApp();
  await Promise.all([loadProducts(), loadMinhasBaixas()]);
  subscribeRealtime();
}

async function doLogout() { await sb.auth.signOut(); }

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  const nome = vendedorAtual?.nome || '';
  document.getElementById('user-name').textContent = nome;
  document.getElementById('user-avatar').textContent = nome ? nome.trim()[0].toUpperCase() : 'V';
  const mobileName = document.getElementById('mobile-user-name');
  const mobileAvatar = document.getElementById('mobile-user-avatar');
  if (mobileName) mobileName.textContent = nome || 'Vendedor';
  if (mobileAvatar) mobileAvatar.textContent = nome ? nome.trim()[0].toUpperCase() : 'V';
  setSellerHistoryOpen(false);

  // Aplica o modo de visualização padrão (lista) na UI do toggle
  document.getElementById('view-grid-btn').classList.toggle('active', viewMode === 'grid');
  document.getElementById('view-list-btn').classList.toggle('active', viewMode === 'list');
  document.getElementById('products-list').classList.toggle('list-mode', viewMode === 'list');
}

// ─── TEMA (claro/escuro) ──────────────────────────────────
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const icon = theme === 'dark' ? '☀️' : '🌙';
  const label = theme === 'dark' ? 'Modo claro' : 'Modo escuro';
  const iconEl = document.getElementById('theme-icon');
  const labelEl = document.getElementById('theme-label');
  const iconMobileEl = document.getElementById('theme-icon-mobile');
  if (iconEl) iconEl.textContent = icon;
  if (labelEl) labelEl.textContent = label;
  if (iconMobileEl) iconMobileEl.textContent = icon;
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  const next = current === 'dark' ? 'light' : 'dark';
  localStorage.setItem('vendedor-theme', next);
  applyTheme(next);
}

(function initTheme() {
  const saved = localStorage.getItem('vendedor-theme');
  if (saved === 'dark') applyTheme('dark');
})();

// ─── PRODUTOS (somente leitura + baixa) ──────────────────
let statusFilter = '';
let productTypeFilter = 'maquina';
let viewMode = 'list';

function productCategory(p) {
  return p.categoria || 'maquina';
}

function setProductTypeFilter(type) {
  productTypeFilter = type === 'produto' ? 'produto' : 'maquina';
  document.getElementById('tab-type-maquina')?.classList.toggle('active', productTypeFilter === 'maquina');
  document.getElementById('tab-type-produto')?.classList.toggle('active', productTypeFilter === 'produto');
  renderCards();
}

function setStatusFilter(status) {
  statusFilter = status;
  document.querySelectorAll('.filter-pill').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === status);
  });
  renderCards();
}

function setViewMode(mode) {
  viewMode = mode;
  document.getElementById('view-grid-btn').classList.toggle('active', mode === 'grid');
  document.getElementById('view-list-btn').classList.toggle('active', mode === 'list');
  document.getElementById('products-list').classList.toggle('list-mode', mode === 'list');
  renderCards();
}

async function loadProducts() {
  const { data } = await sb.from('produtos').select('*').order('nome');
  products = data || [];
  syncOpenBaixaProduct();
  renderCards();
}

function syncOpenBaixaProduct() {
  if (!baixaProduto) return;

  const updated = products.find(product => product.id === baixaProduto.id);
  if (!updated) {
    closeBaixaPanel();
    return;
  }

  baixaProduto = updated;
  updateBaixaPreview();
}


function setSellerHistoryOpen(open) {
  sellerHistoryOpen = !!open;
  const historyEl = document.getElementById('seller-history');
  const toggleEl = document.getElementById('seller-history-toggle');
  if (historyEl) historyEl.classList.toggle('is-collapsed', !sellerHistoryOpen);
  if (toggleEl) toggleEl.textContent = sellerHistoryOpen ? 'Fechar' : 'Abrir';
}

function toggleSellerHistory() {
  setSellerHistoryOpen(!sellerHistoryOpen);
}
async function loadMinhasBaixas() {
  const listEl = document.getElementById('seller-history-list');
  const subEl = document.getElementById('seller-history-sub');
  const refreshBtn = document.querySelector('.seller-history-refresh');
  if (!listEl) return;

  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = 'Carregando...';
  }
  if (subEl) subEl.textContent = 'Atualizando suas baixas recentes';
  listEl.innerHTML = '<div class="history-loading"><span class="history-spinner"></span><span>Carregando historico...</span></div>';

  const { data, error } = await sb.rpc('listar_minhas_baixas_vendedor', { p_limite: 30 });

  if (refreshBtn) {
    refreshBtn.disabled = false;
    refreshBtn.textContent = 'Atualizar';
  }

  if (error) {
    listEl.innerHTML = '<div class="history-empty">Nao foi possivel carregar suas baixas.</div>';
    if (subEl) subEl.textContent = 'Tente atualizar novamente em alguns instantes';
    return;
  }

  minhasBaixas = data || [];
  renderMinhasBaixas();
}

function renderMinhasBaixas() {
  const listEl = document.getElementById('seller-history-list');
  const subEl = document.getElementById('seller-history-sub');
  if (!listEl) return;

  if (subEl) {
    subEl.textContent = minhasBaixas.length
      ? `${minhasBaixas.length} baixa${minhasBaixas.length === 1 ? '' : 's'} recente${minhasBaixas.length === 1 ? '' : 's'}`
      : 'Nenhuma baixa registrada por voce ainda';
  }

  if (!minhasBaixas.length) {
    listEl.innerHTML = '<div class="history-empty">Nenhuma baixa registrada por voce ainda.</div>';
    return;
  }

  listEl.innerHTML = minhasBaixas.map(item => {
    const quantidade = Number(item.quantidade_movimentada || 0);
    const voltagem = item.voltagem ? ` · ${escapeHtml(String(item.voltagem).toUpperCase())}` : '';
    const data = formatDateTimeBR(item.created_at);
    return `<div class="history-item">
      <div>
        <div class="history-product">${escapeHtml(item.produto_nome || 'Produto')}</div>
        <div class="history-meta">${data}${voltagem} · ${item.quantidade_anterior} -> ${item.quantidade_nova}</div>
      </div>
      <div class="history-qty"><strong>-${quantidade}</strong>baixado</div>
    </div>`;
  }).join('');
}

function formatDateTimeBR(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
function totalQty(p) { return p.tem_voltagem ? (p.quantidade_110v + p.quantidade_220v) : p.quantidade; }

function getStatus(p) {
  const qty = totalQty(p);
  if (qty === 0) return { cls: 'out', label: 'Sem estoque' };
  if (qty <= (p.minimo || 0)) return { cls: 'low', label: 'Estoque baixo' };
  return { cls: 'ok', label: 'OK' };
}

function updateFilterCounts() {
  const counts = { ok: 0, low: 0, out: 0 };
  const visibleTypeProducts = products.filter(p => productCategory(p) === productTypeFilter);
  const machineCount = products.filter(p => productCategory(p) === 'maquina').length;
  const productCount = products.filter(p => productCategory(p) === 'produto').length;

  visibleTypeProducts.forEach(p => { counts[getStatus(p).cls]++; });

  document.getElementById('count-all').textContent = visibleTypeProducts.length;
  document.getElementById('count-ok').textContent = counts.ok;
  document.getElementById('count-low').textContent = counts.low;
  document.getElementById('count-out').textContent = counts.out;
  document.getElementById('count-type-maquina').textContent = machineCount;
  document.getElementById('count-type-produto').textContent = productCount;
}

function codesArray(p) {
  const codes = [];
  if (p.codigo_fabricante) codes.push(`Fab: ${p.codigo_fabricante}`);
  if (p.codigo_interno) codes.push(`Int: ${p.codigo_interno}`);
  if (p.codigo_referencia) codes.push(`Ref: ${p.codigo_referencia}`);
  if (p.sku) codes.push(`Barras: ${p.sku}`);
  return codes;
}

function renderCards() {
  updateFilterCounts();

  const q = document.getElementById('search-input').value.toLowerCase();
  const filtered = products.filter(p => {
    const matchesSearch =
      p.nome.toLowerCase().includes(q) ||
      (p.codigo_fabricante||'').toLowerCase().includes(q) ||
      (p.codigo_interno||'').toLowerCase().includes(q) ||
      (p.codigo_referencia||'').toLowerCase().includes(q) ||
      (p.sku||'').toLowerCase().includes(q);
    const matchesType = productCategory(p) === productTypeFilter;
    const matchesStatus = !statusFilter || getStatus(p).cls === statusFilter;
    return matchesSearch && matchesType && matchesStatus;
  });

  const countText = `${filtered.length} item${filtered.length === 1 ? '' : 's'}`;
  const topbarCount = document.getElementById('topbar-count');
  if (topbarCount) topbarCount.textContent = countText;
  const topbarCountDesktop = document.getElementById('topbar-count-desktop');
  if (topbarCountDesktop) topbarCountDesktop.textContent = countText;

  const el = document.getElementById('products-list');
  if (!filtered.length) { el.innerHTML = '<div class="empty-state">Nenhum produto encontrado.</div>'; return; }

  const effectiveMode = window.innerWidth < 900 ? 'grid' : viewMode;
  el.innerHTML = effectiveMode === 'list'
    ? filtered.map(p => renderRow(p)).join('')
    : filtered.map(p => renderCard(p)).join('');
}

function renderCard(p) {
  const status = getStatus(p);
  const isProduct = productCategory(p) === 'produto';

  const imgHTML = p.imagem_url
    ? `<img class="prod-img" src="${p.imagem_url}" alt="${p.nome}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    + `<div class="prod-img-placeholder" style="display:none">📦</div>`
    : `<div class="prod-img-placeholder">📦</div>`;

  const codes = codesArray(p);
  const codesHTML = codes.length
    ? `<div class="prod-codes">${codes.map(c => `<span class="prod-code">${c}</span>`).join('')}</div>`
    : '';

  let qtyRowHTML;
  if (p.tem_voltagem) {
    qtyRowHTML = `
      <div class="prod-qty-row">
        <div class="prod-qty-item"><span class="volt-chip">110V</span><strong class="qty-${status.cls}">${p.quantidade_110v}</strong></div>
        <div class="prod-qty-item"><span class="volt-chip">220V</span><strong class="qty-${status.cls}">${p.quantidade_220v}</strong></div>
      </div>`;
  } else {
    qtyRowHTML = `
      <div class="prod-qty-row">
        <div class="prod-qty-item">Em estoque<strong class="qty-${status.cls}">${p.quantidade}</strong></div>
      </div>`;
  }

  return `<div class="prod-card ${status.cls}" id="card-${p.id}">
    <div class="prod-badge-row"><span class="prod-badge ${status.cls}">${status.label}</span></div>
    <div class="prod-top">
      ${imgHTML}
      <div class="prod-info">
        <div class="prod-name">${p.nome}</div>
        ${codesHTML}
      </div>
    </div>
    ${qtyRowHTML}
    ${isProduct
      ? `<button class="btn-baixa-card is-product-manual" onclick="openBaixaPanel(${p.id})">Baixa manual</button>`
      : `<button class="btn-baixa-card" onclick="openBaixaPanel(${p.id})">Dar baixa</button>`}
  </div>`;
}

function renderRow(p) {
  const status = getStatus(p);
  const isProduct = productCategory(p) === 'produto';

  const imgHTML = p.imagem_url
    ? `<img class="prod-row-img" src="${p.imagem_url}" alt="${p.nome}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
    + `<div class="prod-row-img-ph" style="display:none">📦</div>`
    : `<div class="prod-row-img-ph">📦</div>`;

  const codes = codesArray(p);
  const codesText = codes.length ? codes.join(' · ') : '';

  let qtyHTML;
  if (p.tem_voltagem) {
    qtyHTML = `
      <div class="prod-row-qty-item"><div class="label">110V</div><div class="value qty-${status.cls}">${p.quantidade_110v}</div></div>
      <div class="prod-row-qty-item"><div class="label">220V</div><div class="value qty-${status.cls}">${p.quantidade_220v}</div></div>`;
  } else {
    qtyHTML = `<div class="prod-row-qty-item"><div class="label">Qtd.</div><div class="value qty-${status.cls}">${p.quantidade}</div></div>`;
  }

  return `<div class="prod-row" id="row-${p.id}">
    ${imgHTML}
    <div class="prod-row-info">
      <div class="prod-row-name">${p.nome}</div>
      ${codesText ? `<div class="prod-row-codes">${codesText}</div>` : ''}
    </div>
    <div class="prod-row-qty">${qtyHTML}</div>
    <span class="prod-row-badge ${status.cls}">${status.label}</span>
    ${isProduct
      ? `<button class="btn-baixa-row is-product-manual" onclick="openBaixaPanel(${p.id})">Baixa manual</button>`
      : `<button class="btn-baixa-row" onclick="openBaixaPanel(${p.id})">Dar baixa</button>`}
  </div>`;
}

// ─── PAINEL DE BAIXA ─────────────────────────────────────
function openBaixaPanel(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const isProduct = productCategory(p) === 'produto';
  baixaProduto = p;
  baixaVoltagemSelecionada = null;

  document.getElementById('baixa-panel-title').textContent = isProduct
    ? 'Baixa manual de produto'
    : 'Dar baixa no estoque';

  document.getElementById('baixa-prod-info').innerHTML = `
    ${p.imagem_url
      ? `<img class="baixa-prod-img" src="${p.imagem_url}" onerror="this.outerHTML='<div class=baixa-prod-img-ph>📦</div>'">`
      : `<div class="baixa-prod-img-ph">📦</div>`}
    <div>
      <div class="baixa-prod-name">${p.nome}</div>
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
  document.getElementById('baixa-product-password').value = '';
  document.getElementById('baixa-product-password-wrap').style.display = isProduct ? 'block' : 'none';
  document.getElementById('baixa-error').textContent = '';
  updateBaixaPreview();

  document.getElementById('baixa-overlay').classList.add('open');
  document.getElementById('baixa-panel').classList.add('open');
}

function closeBaixaPanel() {
  document.getElementById('baixa-overlay').classList.remove('open');
  document.getElementById('baixa-panel').classList.remove('open');
  document.getElementById('baixa-product-password-wrap').style.display = 'none';
  document.getElementById('baixa-product-password').value = '';
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

  if (!baixaProduto || !vendedorAtual) return;
  const isProduct = productCategory(baixaProduto) === 'produto';
  if (baixaProduto.tem_voltagem && !baixaVoltagemSelecionada) {
    errorEl.textContent = 'Selecione a voltagem.';
    return;
  }

  const qty = parseInt(document.getElementById('baixa-qty').value) || 0;
  if (qty <= 0) {
    errorEl.textContent = 'Informe uma quantidade valida.';
    return;
  }

  const atual = currentBaixaEstoqueAtual();
  if (qty > atual) {
    errorEl.textContent = `Quantidade maior que o estoque disponivel (${atual}).`;
    return;
  }

  const senhaProduto = document.getElementById('baixa-product-password').value.trim();
  if (isProduct && !senhaProduto) {
    errorEl.textContent = 'Informe a senha de autorizacao.';
    return;
  }

  const novaQty = atual - qty;
  const btn = document.getElementById('btn-confirm-baixa');
  btn.disabled = true;
  btn.textContent = 'Salvando...';

  const voltLabel = baixaProduto.tem_voltagem
    ? (baixaVoltagemSelecionada === 'v110' ? '110v' : '220v')
    : null;

  const rpcName = isProduct ? 'registrar_baixa_produto_manual' : 'registrar_baixa_venda';
  const rpcParams = {
    p_produto_id: baixaProduto.id,
    p_quantidade: qty,
    p_voltagem: voltLabel
  };

  if (isProduct) rpcParams.p_senha = senhaProduto;

  const { data, error } = await sb.rpc(rpcName, rpcParams);

  btn.disabled = false;
  btn.textContent = 'Confirmar baixa';

  if (error) {
    errorEl.textContent = error.message || 'Nao foi possivel registrar a baixa.';
    return;
  }

  const nomeProduto = baixaProduto.nome;



  const produtoAtualizado = Array.isArray(data) ? data[0] : null;

if (produtoAtualizado) {
  products = products.map(p => p.id === baixaProduto.id ? {
    ...p,
    quantidade: produtoAtualizado.quantidade,
    quantidade_110v: produtoAtualizado.quantidade_110v,
    quantidade_220v: produtoAtualizado.quantidade_220v,
    ultima_baixa_vendedor: vendedorAtual.nome,
    ultima_baixa_em: new Date().toISOString(),
    ultima_baixa_voltagem: voltLabel
  } : p);

  renderCards();
} else {
  await loadProducts();
}


  closeBaixaPanel();
  showToast(`Baixa registrada: ${nomeProduto} -> ${novaQty}${voltLabel ? ' (' + voltLabel.toUpperCase() + ')' : ''}`);
  await loadProducts();
  await loadMinhasBaixas();
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

function subscribeRealtime() {
  if (realtimeChannel) return;

  realtimeChannel = sb.channel('vendedor-estoque-realtime')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'produtos' }, async () => {
      await Promise.all([loadProducts(), loadMinhasBaixas()]);
    })
    .subscribe();
}

function cleanupRealtime() {
  if (!realtimeChannel) return;
  sb.removeChannel(realtimeChannel);
  realtimeChannel = null;
}

document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-usuario').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (products.length) renderCards(); }, 150);
});

checkSession();
