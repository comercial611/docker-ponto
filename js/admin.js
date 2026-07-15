let products = [];
let vendedores = [];
let deleteTargetId = null;
let deleteVendedorId = null;
let csvPreviewRows = [];
let csvPreviewApplied = false;
let csvPreviewFileName = null;
let csvPreviewHash = null;
let csvLots = [];
let nuvemshopCatalogRows = [];
let nuvemshopCatalogLoaded = false;
let nuvemshopStoreId = null;

// Estado do painel de baixa
let baixaProduto = null;
let baixaVoltagemSelecionada = null; // 'v110' | 'v220' | null

// ─── NOTIFICAÇÕES ────────────────────────────────────────
let notifications = [];
let productsSnapshot = {}; // { id: { quantidade, quantidade_110v, quantidade_220v, minimo, tem_voltagem } }
const NOTIFICATIONS_STORAGE_KEY = 'admin-notifications';

function snapshotProducts(list) {
  const snap = {};
  list.forEach(p => {
    snap[p.id] = {
      quantidade: p.quantidade,
      quantidade_110v: p.quantidade_110v,
      quantidade_220v: p.quantidade_220v,
      minimo: p.minimo,
      tem_voltagem: p.tem_voltagem
    };
  });
  return snap;
}

function statusFromQty(qty, minimo) {
  if (qty === 0) return 'out';
  if (qty <= (minimo || 0)) return 'low';
  return 'ok';
}

function loadSavedNotifications() {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTIFICATIONS_STORAGE_KEY) || '[]');
    notifications = saved
      .map(n => ({ ...n, time: new Date(n.time) }))
      .filter(n => n.id && n.text && !Number.isNaN(n.time.getTime()));
  } catch {
    notifications = [];
  }
  renderNotifDropdown();
}

function saveNotifications() {
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(notifications.slice(0, 50)));
}

function pushNotification(color, text, sourceId) {
  if (sourceId && notifications.some(n => n.sourceId === sourceId)) return;

  const notif = { id: Date.now() + Math.random(), sourceId, color, text, time: new Date() };
  notifications.unshift(notif);
  if (notifications.length > 50) notifications.pop();
  saveNotifications();
  renderNotifDropdown();
  showToast(color, text);
}

function renderNotifDropdown() {
  const countEl = document.getElementById('notif-count');
  countEl.textContent = notifications.length > 99 ? '99+' : notifications.length;
  countEl.classList.toggle('visible', notifications.length > 0);

  const listEl = document.getElementById('notif-list');
  if (!notifications.length) {
    listEl.innerHTML = '<div class="empty-state">Nenhuma notificação ainda.</div>';
    return;
  }

  listEl.innerHTML = notifications.map(n => `
    <div class="notif-item">
      <div class="notif-dot ${n.color}"></div>
      <div class="notif-body">
        <div class="notif-text">${n.text}</div>
        <div class="notif-time">${n.time.toLocaleString('pt-BR')}</div>
      </div>
      <button class="notif-delete-btn" onclick="event.stopPropagation(); deleteNotification(${JSON.stringify(n.id)})" title="Apagar notificação">x</button>
    </div>`).join('');
}

function toggleNotifDropdown() {
  document.getElementById('notif-dropdown').classList.toggle('open');
}

function clearNotifications() {
  notifications = [];
  saveNotifications();
  renderNotifDropdown();
}

function deleteNotification(id) {
  notifications = notifications.filter(n => n.id !== id);
  saveNotifications();
  renderNotifDropdown();
}

document.addEventListener('click', (e) => {
  const wrap = document.querySelector('.notif-bell-wrap');
  if (wrap && !wrap.contains(e.target)) document.getElementById('notif-dropdown').classList.remove('open');
});

function showToast(color, text) {
  const stack = document.getElementById('toast-stack');
  const el = document.createElement('div');
  el.className = `toast ${color}`;
  el.innerHTML = `<div class="toast-dot ${color}"></div><div class="toast-text">${text}</div>`;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  }, 4500);
}

// Compara o snapshot anterior com a lista nova e gera notificações de mudança de estoque
function detectStockChanges(newList) {
  // As notificações de alterações agora vêm do historico.
  // Aqui mantemos apenas o snapshot atualizado para evitar notificações duplicadas.
  productsSnapshot = snapshotProducts(newList);
}

function checkSimpleDelta(p, prev) {
  const before = prev.quantidade;
  const after = p.quantidade;
  if (before === after) return;

  if (after > before) {
    pushNotification('green', `<strong>${p.nome}</strong> recebeu entrada de estoque: ${before} → ${after}`);
  } else {
    const statusBefore = statusFromQty(before, p.minimo);
    const statusAfter = statusFromQty(after, p.minimo);
    if (statusAfter === 'out' && statusBefore !== 'out') {
      pushNotification('red', `<strong>${p.nome}</strong> ficou sem estoque`);
    } else if (statusAfter === 'low' && statusBefore === 'ok') {
      pushNotification('yellow', `<strong>${p.nome}</strong> está com estoque baixo (${after} restante${after === 1 ? '' : 's'})`);
    }
  }
}

function checkVoltDelta(p, prev, field, voltLabel) {
  const before = prev[field];
  const after = p[field];
  if (before === after) return;

  if (after > before) {
    pushNotification('green', `<strong>${p.nome}</strong> (${voltLabel}) recebeu entrada de estoque: ${before} → ${after}`);
  } else {
    const statusBefore = statusFromQty(before, p.minimo);
    const statusAfter = statusFromQty(after, p.minimo);
    if (statusAfter === 'out' && statusBefore !== 'out') {
      pushNotification('red', `<strong>${p.nome}</strong> (${voltLabel}) ficou sem estoque`);
    } else if (statusAfter === 'low' && statusBefore === 'ok') {
      pushNotification('yellow', `<strong>${p.nome}</strong> (${voltLabel}) está com estoque baixo (${after} restante${after === 1 ? '' : 's'})`);
    }
  }
}

// ─── AUTH ────────────────────────────────────────────────
function isBaixaTipo(tipo) {
  return String(tipo || '').startsWith('baixa');
}

function pushHistoryNotification(record) {
  if (!record) return;

  const product = products.find(p => p.id === record.produto_id);
  const productName = product?.nome || 'Produto';
  const before = record.quantidade_anterior;
  const after = record.quantidade_nova;
  const volt = record.voltagem ? ` (${record.voltagem})` : '';
  const sourceId = `historico-${record.id}`;

  if (isBaixaTipo(record.tipo)) {
    const vendedor = record.vendedor || record.usuario || 'vendedor';
    pushNotification('blue', `<strong>${productName}</strong>${volt}: baixa de ${before} para ${after} por ${vendedor}`, sourceId);
    return;
  }

  const usuario = record.usuario || 'funcionário';
  const color = after >= before ? 'green' : 'yellow';
  pushNotification(color, `<strong>${productName}</strong>${volt}: contagem de ${before} para ${after} por ${usuario}`, sourceId);
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
}

async function init() {
  loadSavedNotifications();
  setDefaultCsvMovementDate();
  await loadProducts();
  await loadVendedores();
  await loadHistory();
  await loadCsvLots();
  subscribeRealtime();
}

// ─── PRODUTOS ────────────────────────────────────────────
async function loadProducts() {
  const { data } = await sb.from('produtos').select('*').order('nome');
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
}

function thumbHTML(p, size) {
  size = size || 44;
  if (p.imagem_url) {
    return `<img class="prod-thumb" style="width:${size}px;height:${size}px" src="${p.imagem_url}" alt="${p.nome}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
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

function totalQty(p) { return p.tem_voltagem ? (p.quantidade_110v + p.quantidade_220v) : p.quantidade; }

function getStatus(p) {
  const qty = totalQty(p);
  if (qty === 0) return { cls: 'out', label: 'Sem estoque' };
  if (qty <= (p.minimo || 0)) return { cls: 'low', label: 'Estoque baixo' };
  return { cls: 'ok', label: 'OK' };
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
  const q = document.getElementById('search-dash').value.toLowerCase();
  const statusFilter = document.getElementById('filter-status').value;
  const vendedorFilter = document.getElementById('filter-vendedor').value;

  const filtered = products.filter(p => {
    const matchesSearch =
      p.nome.toLowerCase().includes(q) ||
      (p.codigo_fabricante||'').toLowerCase().includes(q) ||
      (p.codigo_interno||'').toLowerCase().includes(q) ||
      (p.codigo_referencia||'').toLowerCase().includes(q) ||
      (p.sku||'').toLowerCase().includes(q);
    const matchesStatus = !statusFilter || getStatus(p).cls === statusFilter;
    const matchesVendedor = !vendedorFilter || p.ultima_baixa_vendedor === vendedorFilter;
    return matchesSearch && matchesStatus && matchesVendedor;
  });

  const tbody = document.getElementById('dash-tbody');
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Nenhum produto encontrado.</td></tr>'; return; }
  tbody.innerHTML = filtered.map(p => {
    const status = getStatus(p);
    return `<tr id="row-${p.id}">
      <td>${thumbHTML(p)}</td>
      <td><strong>${p.nome}</strong>${p.observacoes ? `<br><span style="color:var(--muted);font-size:11px">${p.observacoes}</span>` : ''}</td>
      <td>${codesHTML(p)}</td>
      <td>${qtyCellHTML(p)}</td>
      <td style="color:var(--muted)">${p.minimo || 0}</td>
      <td><span class="badge ${status.cls}">${status.label}</span></td>
      <td>${lastBaixaHTML(p)}</td>
      <td><button class="btn-baixa" onclick="openBaixaPanel(${p.id})">Baixa</button></td>
    </tr>`;
  }).join('');
}

function renderProdTable() {
  const q = (document.getElementById('search-prod')?.value || '').toLowerCase();
  const categoryFilter = document.getElementById('filter-prod-categoria')?.value || '';
  const filtered = products.filter(p => {
    const matchesSearch =
      p.nome.toLowerCase().includes(q) ||
      (p.codigo_fabricante||'').toLowerCase().includes(q) ||
      (p.codigo_interno||'').toLowerCase().includes(q) ||
      (p.codigo_referencia||'').toLowerCase().includes(q) ||
      (p.sku||'').toLowerCase().includes(q);
    const matchesCategory = !categoryFilter || (p.categoria || 'maquina') === categoryFilter;
    return matchesSearch && matchesCategory;
  });
  const tbody = document.getElementById('prod-tbody');
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nenhum produto encontrado.</td></tr>'; return; }
  tbody.innerHTML = filtered.map(p => `<tr>
    <td>${thumbHTML(p)}</td>
    <td><strong>${p.nome}</strong></td>
    <td>${categoryHTML(p)}</td>
    <td>${codesHTML(p)}</td>
    <td>${qtyCellHTML(p)}</td>
    <td>${p.minimo || 0}</td>
    <td><div class="action-cell">
      <button class="btn-baixa" onclick="openBaixaPanel(${p.id})">Baixa</button>
      <button class="btn-edit" onclick="editProduct(${p.id})">Editar</button>
      <button class="btn-delete" onclick="openDeleteModal(${p.id})">Excluir</button>
    </div></td>
  </tr>`).join('');
}
function updateStats() {
  document.getElementById('stat-total').textContent = products.length;
  document.getElementById('stat-ok').textContent = products.filter(p => getStatus(p).cls === 'ok').length;
  document.getElementById('stat-low').textContent = products.filter(p => getStatus(p).cls === 'low').length;
  document.getElementById('stat-out').textContent = products.filter(p => getStatus(p).cls === 'out').length;
}

function toggleVoltagem(e) {
  const checked = e.target.checked;
  document.getElementById('codes-simple-wrap').classList.toggle('visible', !checked);
  document.getElementById('codes-voltage-wrap').classList.toggle('visible', checked);
  document.getElementById('qty-simple-wrap').classList.toggle('visible', !checked);
  document.getElementById('qty-voltage-wrap').classList.toggle('visible', checked);
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

function previewImg() {
  const url = document.getElementById('p-img-url').value.trim();
  const img = document.getElementById('img-preview');
  const hint = document.getElementById('img-hint');
  if (url) { img.src = url; img.classList.add('visible'); hint.textContent = ''; }
  else { img.classList.remove('visible'); hint.textContent = 'Cole a URL de uma imagem para visualizar'; }
}

async function saveProduct() {
  const nome = document.getElementById('p-nome').value.trim();
  if (!nome) { alert('Nome do produto é obrigatório.'); return; }
  const temVoltagem = document.getElementById('p-tem-voltagem').checked;

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
    body.codigo_fabricante = formatVoltageCodes(voltageCodes.fabricante110, voltageCodes.fabricante220) || legacyCodes.fabricante || null;
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
  document.getElementById('p-nome').value = p.nome;
  document.getElementById('p-categoria').value = p.categoria || 'maquina';
  document.getElementById('p-cod-fab').value = p.codigo_fabricante || '';
  document.getElementById('p-cod-interno').value = p.codigo_interno || '';
  document.getElementById('p-cod-ref').value = p.codigo_referencia || '';
  document.getElementById('p-cod-barras').value = p.sku || '';
  document.getElementById('p-obs').value = p.observacoes || '';
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
    'p-qty','p-min','p-qty-110','p-qty-220','p-min-volt','p-obs','p-img-url','p-edit-id'
  ].forEach(id => document.getElementById(id).value = '');
  document.getElementById('p-categoria').value = 'maquina';
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

function openDeleteModal(id) { deleteTargetId = id; document.getElementById('delete-modal').classList.add('open'); }
function closeDeleteModal() { deleteTargetId = null; document.getElementById('delete-modal').classList.remove('open'); }
async function confirmDelete() {
  if (!deleteTargetId) return;
  await sb.from('produtos').delete().eq('id', deleteTargetId);
  closeDeleteModal();
  await loadProducts();
}

// ─── PREVIA CSV PRODUTOS ─────────────────────────────────
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char]);
}

function normalizeCode(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizeHeader(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

// NUVEMSHOP - CONFERENCIA SOMENTE LEITURA
function translatedValue(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  return String(value.pt || value['pt-BR'] || value.es || value.en || Object.values(value)[0] || '');
}

function remoteVariantLabel(variant) {
  const values = Array.isArray(variant?.values) ? variant.values.map(translatedValue).filter(Boolean) : [];
  return values.length ? values.join(' / ') : 'Unica';
}

function remoteVariantStock(variant) {
  if (variant?.stock_management === false) return null;
  if (Number.isFinite(Number(variant?.stock))) return Number(variant.stock);
  if (Array.isArray(variant?.inventory_levels)) {
    return variant.inventory_levels.reduce((total, level) => total + (Number(level?.stock) || 0), 0);
  }
  return 0;
}

function codeTokens(value) {
  const normalized = normalizeCode(value);
  if (!normalized) return [];

  const voltageMarkers = new Set(['110', '220', '110v', '220v', 'v110', 'v220']);
  return [...new Set((normalized.match(/[a-z0-9]+(?:[-./][a-z0-9]+)*/g) || [])
    .filter(token => !voltageMarkers.has(token)))];
}

function localProductCodes(product) {
  return [
    product.codigo_fabricante, product.codigo_interno, product.codigo_referencia, product.sku,
    product.codigo_fabricante_110v, product.codigo_fabricante_220v,
    product.codigo_interno_110v, product.codigo_interno_220v,
    product.codigo_referencia_110v, product.codigo_referencia_220v,
    product.codigo_barras_110v, product.codigo_barras_220v
  ]
    .flatMap(codeTokens);
}

function findExactLocalCandidates(variant) {
  const remoteCodes = [variant?.sku, variant?.barcode].flatMap(codeTokens);
  if (!remoteCodes.length) return [];
  return products.filter(product => localProductCodes(product).some(code => remoteCodes.includes(code)));
}

function inferVoltage(value) {
  const normalized = String(value || '').toUpperCase();
  if (/(^|\D)110\s*V?(\D|$)/.test(normalized)) return '110V';
  if (/(^|\D)220\s*V?(\D|$)/.test(normalized)) return '220V';
  return null;
}

function mappedLocalStock(product, voltage) {
  if (!product) return null;
  if (!product.tem_voltagem) return Number(product.quantidade) || 0;
  if (voltage === '110V') return Number(product.quantidade_110v) || 0;
  if (voltage === '220V') return Number(product.quantidade_220v) || 0;
  return (Number(product.quantidade_110v) || 0) + (Number(product.quantidade_220v) || 0);
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
        linkVoltage: localVoltage
      });
    });
  });
  return rows;
}

async function loadNuvemshopCatalog(force = false) {
  if (nuvemshopCatalogLoaded && !force) return;
  const button = document.getElementById('nuvemshop-refresh-btn');
  const message = document.getElementById('nuvemshop-message');
  const tableWrap = document.getElementById('nuvemshop-table-wrap');
  button.disabled = true;
  button.textContent = 'Consultando...';
  message.className = 'nuvemshop-message';
  message.textContent = 'Consultando catalogo da Nuvemshop...';
  message.style.display = 'flex';
  tableWrap.style.display = 'none';

  try {
    const [{ data, error }, linksResult] = await Promise.all([
      sb.functions.invoke('nuvemshop-catalogo', { method: 'GET' }),
      sb.from('nuvemshop_vinculos').select('*').eq('ativo', true)
    ]);
    if (error) throw error;
    if (linksResult.error) throw linksResult.error;
    if (!Array.isArray(data?.produtos)) throw new Error('Catalogo em formato inesperado.');

    nuvemshopStoreId = data.store_id;
    nuvemshopCatalogRows = flattenNuvemshopCatalog(data.produtos, linksResult.data || []);
    nuvemshopCatalogLoaded = true;
    renderNuvemshopCatalog();
  } catch (error) {
    console.error('Falha ao consultar Nuvemshop', error);
    message.className = 'nuvemshop-message error';
    message.textContent = 'Nao foi possivel consultar o catalogo. Confira os logs da funcao nuvemshop-catalogo.';
    message.style.display = 'flex';
  } finally {
    button.disabled = false;
    button.textContent = 'Atualizar catalogo';
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

  const message = document.getElementById('nuvemshop-message');
  const tableWrap = document.getElementById('nuvemshop-table-wrap');
  const tbody = document.getElementById('nuvemshop-tbody');
  message.style.display = 'none';
  tableWrap.style.display = 'block';

  if (!filtered.length) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty-state">Nenhum item encontrado para este filtro.</td></tr>';
    return;
  }

  const statusLabels = {
    linked: 'Vinculado',
    matched: 'Exato',
    ambiguous: 'Revisar',
    unmatched: 'Nao identificado'
  };

  tbody.innerHTML = filtered.map(row => {
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

    return `<tr>
      <td><span class="nuvemshop-status ${row.status}">${statusLabels[row.status]}</span></td>
      <td><div class="nuvemshop-product">${image}<div><div class="nuvemshop-product-name">${escapeHtml(row.remoteName)}</div><div class="nuvemshop-product-id">Produto ${row.productId}</div></div></div></td>
      <td><div>${escapeHtml(row.variantLabel)}</div><div class="nuvemshop-variant">Variante ${row.variantId || '-'}</div></td>
      <td><div class="code-tags">${row.sku ? `<span class="code-tag">SKU: ${escapeHtml(row.sku)}</span>` : ''}${row.barcode ? `<span class="code-tag">Barras: ${escapeHtml(row.barcode)}</span>` : ''}${!row.sku && !row.barcode ? '<span class="csv-muted">Sem codigo</span>' : ''}</div></td>
      <td><span class="nuvemshop-stock">${escapeHtml(remoteStock)}</span></td>
      <td>${localDescription}</td>
      <td><span class="nuvemshop-stock">${escapeHtml(localStock)}</span></td>
    </tr>`;
  }).join('');
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
  btn.disabled = !applicable.length || invalid > 0 || insufficient > 0 || !movementDate || !csvPreviewHash;

  if (!movementDate) {
    msg.classList.add('err');
    msg.textContent = 'Informe a data do movimento.';
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

function clearCsvPreview() {
  csvPreviewRows = [];
  csvPreviewApplied = false;
  csvPreviewFileName = null;
  csvPreviewHash = null;
  const input = document.getElementById('csv-baixa-input');
  const summaryEl = document.getElementById('csv-preview-summary');
  const wrapEl = document.getElementById('csv-preview-table-wrap');
  const tbody = document.getElementById('csv-preview-tbody');
  if (input) input.value = '';
  if (summaryEl) summaryEl.textContent = 'Nenhum arquivo selecionado.';
  if (wrapEl) wrapEl.style.display = 'none';
  if (tbody) tbody.innerHTML = '';
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
  updateCsvApplyState();
}

async function confirmCsvBaixa() {
  const btn = document.getElementById('csv-apply-btn');
  const msg = document.getElementById('csv-apply-message');
  const applicable = csvApplicableRows();
  const invalid = csvPreviewRows.filter(row => row.product && row.item.quantidade <= 0).length;
  const insufficient = csvPreviewRows.filter(row => row.product && row.afterQty < 0).length;
  const movementDate = document.getElementById('csv-movement-date')?.value || '';

  if (!applicable.length || invalid > 0 || insufficient > 0 || csvPreviewApplied || !movementDate || !csvPreviewHash) {
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

  const novaQty = atual - qty;
  const btn = document.getElementById('btn-confirm-baixa');
  btn.disabled = true; btn.textContent = 'Salvando...';

  const agora = new Date().toISOString();
  let updateBody = { ultima_baixa_vendedor: vendedor, ultima_baixa_em: agora };
  let voltLabel = null;

  if (baixaProduto.tem_voltagem) {
    voltLabel = baixaVoltagemSelecionada === 'v110' ? '110V' : '220V';
    updateBody[baixaVoltagemSelecionada === 'v110' ? 'quantidade_110v' : 'quantidade_220v'] = novaQty;
    updateBody.ultima_baixa_voltagem = voltLabel;
  } else {
    updateBody.quantidade = novaQty;
    updateBody.ultima_baixa_voltagem = null;
  }

  const { error: updateError } = await sb.from('produtos').update(updateBody).eq('id', baixaProduto.id);
  if (updateError) {
    btn.disabled = false;
    btn.textContent = 'Confirmar baixa';
    errorEl.textContent = updateError.message || 'Não foi possível atualizar o produto.';
    return;
  }

  const { data: historicoData, error: historicoError } = await sb.from('historico').insert({
    produto_id: baixaProduto.id,
    quantidade_anterior: atual,
    quantidade_nova: novaQty,
    usuario: vendedor,
    vendedor: vendedor,
    voltagem: voltLabel,
    tipo: 'baixa'
  }).select('id, produto_id, quantidade_anterior, quantidade_nova, usuario, voltagem, tipo, vendedor').single();

  if (historicoError) {
    btn.disabled = false;
    btn.textContent = 'Confirmar baixa';
    errorEl.textContent = historicoError.message || 'Produto atualizado, mas não foi possível registrar o histórico.';
    return;
  }

  if (historicoData) pushHistoryNotification(historicoData);

  btn.disabled = false; btn.textContent = 'Confirmar baixa';
  closeBaixaPanel();
  await loadProducts();
}

// ─── HISTÓRICO ───────────────────────────────────────────
let historyRows = [];

async function loadCsvLots() {
  const el = document.getElementById('csv-lots-list');
  if (!el) return;

  const { data, error } = await sb
    .from('baixas_csv_lotes')
    .select('*, baixas_csv_itens(*)')
    .order('created_at', { ascending: false })
    .limit(8);

  if (error) {
    csvLots = [];
    el.innerHTML = '<div class="empty-state">Relatorio de CSV ainda nao configurado no Supabase.</div>';
    return;
  }

  csvLots = data || [];
  renderCsvLots();
}

function renderCsvLots() {
  const el = document.getElementById('csv-lots-list');
  if (!el) return;

  if (!csvLots.length) {
    el.innerHTML = '<div class="empty-state">Nenhuma importacao CSV registrada ainda.</div>';
    return;
  }

  el.innerHTML = csvLots.map(lote => {
    const time = new Date(lote.created_at).toLocaleString('pt-BR');
    const movementDate = lote.data_movimento
      ? new Date(`${lote.data_movimento}T12:00:00`).toLocaleDateString('pt-BR')
      : 'nao informada';
    const itens = (lote.baixas_csv_itens || []).slice().sort((a, b) => a.produto_nome.localeCompare(b.produto_nome));
    const details = itens.length
      ? `<div class="csv-lot-details">
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
          `).join('')}
        </div>`
      : '';

    return `<div class="csv-lot-card">
      <div class="csv-lot-main">
        <div>
          <div class="csv-lot-title">${escapeHtml(lote.arquivo_nome || 'CSV aplicado')}</div>
          <div class="csv-lot-meta">Movimento ${movementDate} · aplicado em ${time} · ${escapeHtml(lote.aplicado_email || 'admin')}</div>
        </div>
        <div class="csv-lot-stat"><strong>${lote.produtos_encontrados || 0}</strong>encontrados</div>
        <div class="csv-lot-stat"><strong>${lote.total_aplicado || 0}</strong>pecas baixadas</div>
        <div class="csv-lot-stat"><strong>${lote.nao_encontrados || 0}</strong>nao encontrados</div>
        <div class="csv-lot-stat"><strong>${lote.maquinas_ignoradas || 0}</strong>maquinas</div>
        <div class="csv-lot-stat"><strong>${lote.estoque_insuficiente || 0}</strong>insuficiente</div>
      </div>
      ${details}
    </div>`;
  }).join('');
}

async function loadHistory() {
  const { data } = await sb.from('historico').select('*, produtos(nome, imagem_url)').order('created_at', { ascending: false }).limit(200);
  historyRows = data || [];
  renderHistory();
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
      await loadCsvLots();
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: 'vendedores' }, async () => { await loadVendedores(); })
    .subscribe();
}

// ─── TABS ────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', ['dashboard','produtos','nuvemshop','vendedores','historico'][i] === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
  if (name === 'nuvemshop') loadNuvemshopCatalog();
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
