const SUPABASE_URL = 'https://pcugivsgiudlxhnuvttf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_iMMKiY9-Rl95kESNDtHtYA_lFm-P1Ax';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let products = [];
let vendedorAtual = null; // registro da tabela `vendedores` ligado ao login atual

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
      await loadProducts();
    } else {
      await sb.auth.signOut();
    }
  }
}

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
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
  await loadProducts();
}

async function doLogout() { await sb.auth.signOut(); }

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
  const nome = vendedorAtual?.nome || '';
  document.getElementById('user-name').textContent = nome;
  document.getElementById('user-avatar').textContent = nome ? nome.trim()[0].toUpperCase() : 'V';

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
let viewMode = 'list';

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
  renderCards();
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
  products.forEach(p => { counts[getStatus(p).cls]++; });
  document.getElementById('count-all').textContent = products.length;
  document.getElementById('count-ok').textContent = counts.ok;
  document.getElementById('count-low').textContent = counts.low;
  document.getElementById('count-out').textContent = counts.out;
}

function codesArray(p) {
  const codes = [];
  if (p.codigo_fabricante) codes.push(`Fab: ${p.codigo_fabricante}`);
  if (p.codigo_interno) codes.push(`Int: ${p.codigo_interno}`);
  if (p.codigo_referencia) codes.push(`Ref: ${p.codigo_referencia}`);
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
      (p.codigo_referencia||'').toLowerCase().includes(q);
    const matchesStatus = !statusFilter || getStatus(p).cls === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const countText = `${filtered.length} produto${filtered.length === 1 ? '' : 's'}`;
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
    <button class="btn-baixa-card" onclick="openBaixaPanel(${p.id})">Dar baixa</button>
  </div>`;
}

function renderRow(p) {
  const status = getStatus(p);

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
    <button class="btn-baixa-row" onclick="openBaixaPanel(${p.id})">Dar baixa</button>
  </div>`;
}

// ─── PAINEL DE BAIXA ─────────────────────────────────────
function openBaixaPanel(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  baixaProduto = p;
  baixaVoltagemSelecionada = null;

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

  if (!baixaProduto || !vendedorAtual) return;
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

  const novaQty = atual - qty;
  const btn = document.getElementById('btn-confirm-baixa');
  btn.disabled = true;
  btn.textContent = 'Salvando...';

  const voltLabel = baixaProduto.tem_voltagem
    ? (baixaVoltagemSelecionada === 'v110' ? '110v' : '220v')
    : null;

  const { data, error } = await sb.rpc('registrar_baixa_venda', {
    p_produto_id: baixaProduto.id,
    p_quantidade: qty,
    p_voltagem: voltLabel
  });

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
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 3000);
}

document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('login-usuario').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (products.length) renderCards(); }, 150);
});

checkSession();
