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
let nuvemshopCatalogPage = 1;
let nuvemshopCatalogPageSize = 50;
let nuvemshopStoreId = null;
let nuvemshopStockLocation = null;
let nuvemshopManualRow = null;
let nuvemshopManualVoltage = null;
let nuvemshopPreviewGenerated = false;
let nuvemshopPreviewGeneratedAt = null;
let nuvemshopServerSimulation = null;
let nuvemshopPilotReadiness = null;
let nuvemshopPilotSelectedItemId = null;
let nuvemshopPilotApplying = false;
let nuvemshopPilotApplicationLocked = false;
let nuvemshopPilotWindowBusy = false;
let nuvemshopPilotWindowTimer = null;
let nuvemshopAuditRows = [];
let nuvemshopAuditLoaded = false;
let nuvemshopAuditUser = null;
let nuvemshopAuditPage = 1;
let nuvemshopAuditPageSize = 10;
let nuvemshopAuditTotal = 0;
let nuvemshopAuditSearchTimer = null;
const nuvemshopExpandedAudits = new Set();

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
    product.codigo_fabricante, product.codigo_interno, product.codigo_referencia, product.codigo_barras, product.sku,
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
        linkVoltage: localVoltage,
        savedLinkId: savedLink?.id || null
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
  const pagination = document.getElementById('nuvemshop-pagination');
  button.disabled = true;
  button.textContent = 'Consultando...';
  message.className = 'nuvemshop-message';
  message.textContent = 'Consultando catalogo da Nuvemshop...';
  message.style.display = 'flex';
  tableWrap.style.display = 'none';
  pagination.style.display = 'none';
  nuvemshopServerSimulation = null;
  nuvemshopPilotReadiness = null;
  nuvemshopPilotSelectedItemId = null;

  try {
    const { data, error } = await sb.functions.invoke('nuvemshop-catalogo', { method: 'GET' });
    if (error) throw error;
    if (!data?.store_id) throw new Error('Loja Nuvemshop nao identificada.');
    const linksResult = await sb.from('nuvemshop_vinculos')
      .select('*')
      .eq('store_id', data.store_id)
      .eq('ativo', true);
    if (linksResult.error) throw linksResult.error;
    if (!Array.isArray(data?.produtos)) throw new Error('Catalogo em formato inesperado.');

    nuvemshopStoreId = data.store_id;
    nuvemshopStockLocation = data.estoque_local || null;
    nuvemshopCatalogRows = flattenNuvemshopCatalog(data.produtos, linksResult.data || []);
    nuvemshopCatalogLoaded = true;
    if (nuvemshopPreviewGenerated) nuvemshopPreviewGeneratedAt = new Date();
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
  const connectionText = document.getElementById('nuvemshop-connection-text');
  if (connectionText) {
    if (nuvemshopStockLocation?.status === 'unico') {
      connectionText.textContent = `Somente leitura | Local confirmado: ${nuvemshopStockLocation.local.nome}`;
    } else if (nuvemshopStockLocation?.status === 'multiplo') {
      connectionText.textContent = `${nuvemshopStockLocation.total} locais encontrados | Sincronizacao bloqueada`;
    } else if (nuvemshopStockLocation?.status === 'nao_encontrado') {
      connectionText.textContent = 'Somente leitura | Nenhum local separado informado pela Nuvemshop';
    } else if (nuvemshopStockLocation?.status === 'indisponivel') {
      const httpStatus = nuvemshopStockLocation.http_status ? ` (HTTP ${nuvemshopStockLocation.http_status})` : '';
      connectionText.textContent = `Somente leitura | Consulta de local indisponivel${httpStatus}`;
    } else {
      connectionText.textContent = 'Somente leitura | Local de estoque ainda nao confirmado';
    }
  }
  if (nuvemshopPreviewGenerated) renderNuvemshopSyncPreview();

  const message = document.getElementById('nuvemshop-message');
  const tableWrap = document.getElementById('nuvemshop-table-wrap');
  const tbody = document.getElementById('nuvemshop-tbody');
  const pagination = document.getElementById('nuvemshop-pagination');
  message.style.display = 'none';
  tableWrap.style.display = 'block';

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
    const action = row.status === 'linked'
      ? `<div class="nuvemshop-linked-actions"><span class="nuvemshop-link-confirmed">Confirmado</span><button class="nuvemshop-unlink-btn" id="nuvemshop-unlink-${row.savedLinkId}" onclick="unlinkNuvemshopLink(${row.productId}, ${row.variantId ?? 'null'})">Desfazer</button></div>`
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
      const destinationStock = Number(row.localStock);
      const currentStock = row.remoteStock == null ? null : Number(row.remoteStock);
      const difference = currentStock == null ? null : destinationStock - currentStock;
      const previewStatus = currentStock == null
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
  if (!nuvemshopCatalogLoaded) await loadNuvemshopCatalog();
  if (!nuvemshopCatalogLoaded) return;

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
  const validationText = document.getElementById('nuvemshop-preview-validation');
  const canSimulate = nuvemshopStockLocation?.status === 'unico' && allRows.length > 0;
  simulationButton.disabled = !canSimulate;
  pilotButton.disabled = !nuvemshopServerSimulation;
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

  const tbody = document.getElementById('nuvemshop-preview-tbody');
  if (!filteredRows.length) {
    tbody.innerHTML = '<tr><td colspan="5" class="empty-state">Nenhum produto vinculado encontrado para este filtro.</td></tr>';
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
  if (nuvemshopStockLocation?.status !== 'unico') {
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

function openNuvemshopPilotModal() {
  if (!nuvemshopServerSimulation?.auditoria_id) {
    alert('Valide a previa no servidor antes de verificar o piloto.');
    return;
  }

  nuvemshopPilotReadiness = null;
  nuvemshopPilotSelectedItemId = null;
  nuvemshopPilotApplying = false;
  nuvemshopPilotApplicationLocked = false;
  nuvemshopPilotWindowBusy = false;
  if (nuvemshopPilotWindowTimer) clearTimeout(nuvemshopPilotWindowTimer);
  nuvemshopPilotWindowTimer = null;
  document.getElementById('nuvemshop-pilot-summary').innerHTML =
    `A verificacao usara a auditoria <strong>${escapeHtml(nuvemshopServerSimulation.auditoria_id)}</strong> como referencia.<br>` +
    'A verificacao inicial nao altera estoques. A aplicacao so sera liberada depois de todas as protecoes.';
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
  applyButton.textContent = 'Aplicar 1 item';
  updateNuvemshopPilotWindowButtons();
  document.getElementById('nuvemshop-pilot-modal').classList.add('open');
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
  const confirmation = nuvemshopPilotReadiness?.confirmacao_exigida || 'APLICAR 1 ITEM';

  section.classList.add('visible');
  input.placeholder = confirmation;
  if (!candidates.length) {
    itemsElement.innerHTML = '<div class="nuvemshop-audit-empty">Esta validacao nao possui item que alteraria o estoque.</div>';
    note.textContent = 'Gere uma nova validacao depois de conferir os vinculos e estoques.';
    updateNuvemshopPilotApplyButton();
    return;
  }

  itemsElement.innerHTML = candidates.map(item => {
    const itemId = Number(item.auditoria_item_id);
    const voltage = item.voltagem || 'Unica';
    const selected = itemId === nuvemshopPilotSelectedItemId;
    return `<button type="button" class="nuvemshop-pilot-item${selected ? ' selected' : ''}" onclick="selectNuvemshopPilotItem(${itemId})">
      <input type="radio" name="nuvemshop-pilot-item" tabindex="-1"${selected ? ' checked' : ''}>
      <span>
        <span class="nuvemshop-pilot-item-name">${escapeHtml(item.produto_nome)}</span>
        <span class="nuvemshop-pilot-item-meta">${escapeHtml(voltage)} | Item auditado ${escapeHtml(itemId)}</span>
      </span>
      <span class="nuvemshop-pilot-item-stock">${escapeHtml(item.estoque_atual)} para <strong>${escapeHtml(item.estoque_destino)}</strong></span>
    </button>`;
  }).join('');

  note.className = `nuvemshop-pilot-application-note${nuvemshopPilotReadiness?.pronto_para_aplicar ? ' ready' : ''}`;
  if (nuvemshopPilotReadiness?.pronto_para_aplicar) {
    note.textContent = `Escolha um item e digite exatamente "${confirmation}". O servidor ainda repetira todas as verificacoes antes da escrita.`;
  } else if (nuvemshopPilotReadiness?.pode_habilitar) {
    note.textContent = 'Selecione o item, libere a janela temporaria e depois confirme a aplicacao.';
  } else {
    note.textContent = 'A selecao pode ser conferida, mas a aplicacao permanece desativada enquanto houver protecoes bloqueadas.';
  }
  updateNuvemshopPilotApplyButton();
}

function selectNuvemshopPilotItem(itemId) {
  const normalizedItemId = Number(itemId);
  if (nuvemshopPilotApplicationLocked || nuvemshopPilotApplying) return;
  if (!nuvemshopPilotCandidates().some(item => Number(item.auditoria_item_id) === normalizedItemId)) return;
  nuvemshopPilotSelectedItemId = normalizedItemId;
  renderNuvemshopPilotApplication();
  document.getElementById('nuvemshop-pilot-application-result').className = 'nuvemshop-pilot-application-result';
}

function updateNuvemshopPilotApplyButton() {
  const button = document.getElementById('nuvemshop-pilot-apply');
  if (!button) return;
  const input = document.getElementById('nuvemshop-pilot-confirmation');
  const confirmation = nuvemshopPilotReadiness?.confirmacao_exigida || 'APLICAR 1 ITEM';
  const selectedItemExists = nuvemshopPilotCandidates()
    .some(item => Number(item.auditoria_item_id) === nuvemshopPilotSelectedItemId);
  button.disabled = !nuvemshopPilotReadiness?.pronto_para_aplicar ||
    !selectedItemExists ||
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
    'LIBERAR PILOTO POR 5 MINUTOS';
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
    'LIBERAR PILOTO POR 5 MINUTOS';
  const active = data?.janela_ativa === true;

  section.classList.add('visible');
  input.placeholder = confirmation;
  if (active && data.escrita_habilitada_ate) {
    const expiresAt = new Date(data.escrita_habilitada_ate);
    status.className = 'nuvemshop-pilot-window-status active';
    status.textContent = `Janela ativa ate ${expiresAt.toLocaleTimeString('pt-BR')}. Ela sera fechada apos a primeira tentativa.`;

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
    'LIBERAR PILOTO POR 5 MINUTOS';

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
        modo: enableWindow ? 'habilitar_piloto' : 'desabilitar_piloto',
        store_id: nuvemshopStoreId,
        auditoria_id: nuvemshopServerSimulation?.auditoria_id,
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
      ? 'janela_piloto_habilitada'
      : 'janela_piloto_desabilitada';
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
  const windowExpiresAt = data.escrita_habilitada_ate
    ? new Date(data.escrita_habilitada_ate).toLocaleTimeString('pt-BR')
    : null;
  const checks = [
    { label: 'Simulacao recente', ok: data.simulacao_valida, value: data.simulacao_valida ? 'Valida' : 'Invalida' },
    { label: 'Escopo de escrita', ok: data.escopo_escrita, value: data.escopo_escrita ? 'Autorizado' : 'Ausente' },
    { label: 'Local de estoque', ok: data.local_confirmado, value: data.local_confirmado ? 'Confirmado' : 'Pendente' },
    { label: 'Vinculos ativos', ok: data.vinculos_dentro_limite, value: String(data.vinculos_ativos ?? 0) },
    { label: 'Limite do piloto', ok: data.limite_seguro, value: `${data.limite_itens ?? '-'} item` },
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
      ? 'Protecoes atendidas. Selecione somente um item para o piloto.'
      : 'Piloto bloqueado com seguranca. Nenhuma escrita foi executada.'}
  </div>
  ${blockers.length ? `<div class="nuvemshop-pilot-blockers">${blockers.map(blocker => `<div>${escapeHtml(blocker)}</div>`).join('')}</div>` : ''}`;
  result.classList.add('visible');
  renderNuvemshopPilotWindow(data);
}

async function runNuvemshopPilotReadiness() {
  const button = document.getElementById('nuvemshop-pilot-run');
  const errorElement = document.getElementById('nuvemshop-pilot-error');
  button.disabled = true;
  button.textContent = 'Verificando...';
  errorElement.textContent = '';

  try {
    const { data, error } = await sb.functions.invoke('nuvemshop-sincronizacao', {
      body: {
        modo: 'verificar_piloto',
        store_id: nuvemshopStoreId,
        auditoria_id: nuvemshopServerSimulation?.auditoria_id
      }
    });
    if (error) throw error;
    if (data?.modo !== 'verificacao_piloto' || data?.escrita_executada !== false) {
      throw new Error('O servidor retornou uma verificacao inesperada.');
    }

    nuvemshopPilotReadiness = data;
    renderNuvemshopPilotReadiness(data);
    renderNuvemshopPilotApplication();
    showToast('green', 'Protecoes do piloto verificadas sem alterar estoques.');
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
  const confirmation = nuvemshopPilotReadiness?.confirmacao_exigida || 'APLICAR 1 ITEM';
  const selectedItem = nuvemshopPilotCandidates()
    .find(item => Number(item.auditoria_item_id) === nuvemshopPilotSelectedItemId);

  if (!nuvemshopPilotReadiness?.pronto_para_aplicar) {
    errorElement.textContent = 'Verifique novamente as protecoes antes de qualquer aplicacao.';
    return;
  }
  if (!selectedItem) {
    errorElement.textContent = 'Selecione exatamente um item auditado.';
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
        modo: 'aplicar_piloto',
        store_id: nuvemshopStoreId,
        auditoria_id: nuvemshopServerSimulation.auditoria_id,
        item_auditoria_id: Number(selectedItem.auditoria_item_id),
        confirmacao: confirmation
      }
    });
    if (error) {
      const failure = await readNuvemshopFunctionFailure(error, 'Nao foi possivel concluir a aplicacao piloto.');
      const terminalAttempt = Boolean(failure.payload?.aplicacao_id);
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
        '<br>A janela foi encerrada. Nao repita a tentativa; confira a auditoria e gere uma nova validacao.';
      nuvemshopServerSimulation = null;
      nuvemshopPilotReadiness = null;
      renderNuvemshopSyncPreview();
      return;
    }
    if (data?.modo !== 'aplicacao_piloto' || data?.resultado !== 'concluida' || data?.escrita_executada !== true) {
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
    resultElement.innerHTML =
      `<strong>Aplicacao confirmada.</strong><br>` +
      `Estoque Nuvemshop: ${escapeHtml(data.estoque_anterior)} para ${escapeHtml(data.estoque_confirmado)}.<br>` +
      `Auditoria: ${escapeHtml(data.aplicacao_id)}`;
    button.textContent = 'Aplicacao concluida';
    showToast('green', 'Um item foi aplicado e confirmado na Nuvemshop.');
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
    button.textContent = nuvemshopPilotApplicationLocked ? 'Nova validacao necessaria' : 'Aplicar 1 item';
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

function formatNuvemshopAuditDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function nuvemshopAuditStatusLabel(status) {
  return ({
    preparando: 'Preparando',
    processando: 'Processando',
    concluida: 'Concluida',
    parcial: 'Parcial',
    falhou: 'Falhou',
    cancelada: 'Cancelada'
  })[status] || status || '-';
}

function nuvemshopAuditResultLabel(result) {
  return ({
    igual: 'Sem alteracao',
    alteraria: 'Alteraria',
    sem_controle: 'Sem controle',
    erro: 'Erro'
  })[result] || result || '-';
}

function nuvemshopAuditRequester(row) {
  if (nuvemshopAuditUser?.id === row.solicitado_por) {
    return nuvemshopAuditUser.email || 'Administrador atual';
  }
  return `Administrador ${String(row.solicitado_por || '').slice(0, 8)}`;
}

async function loadNuvemshopAuditHistory(force = false) {
  if (nuvemshopAuditLoaded && !force) return;

  const button = document.getElementById('nuvemshop-audit-refresh');
  const message = document.getElementById('nuvemshop-audit-message');
  const tableWrap = document.getElementById('nuvemshop-audit-table-wrap');
  const pagination = document.getElementById('nuvemshop-audit-pagination');
  if (!button || !message || !tableWrap) return;

  button.disabled = true;
  button.textContent = 'Consultando...';
  message.className = 'nuvemshop-message';
  message.textContent = 'Consultando historico de validacoes...';
  message.style.display = 'flex';
  tableWrap.style.display = 'none';
  if (pagination) pagination.style.display = 'none';

  try {
    const userResult = await sb.auth.getUser();
    nuvemshopAuditUser = userResult.data?.user || null;

    const filter = document.getElementById('nuvemshop-audit-filter')?.value || '';
    const search = normalizeCode(document.getElementById('nuvemshop-audit-search')?.value || '');
    const matchingIds = search ? await resolveNuvemshopAuditSearchIds(search) : null;

    if (matchingIds && !matchingIds.length) {
      nuvemshopAuditRows = [];
      nuvemshopAuditTotal = 0;
      nuvemshopAuditLoaded = true;
      renderNuvemshopAuditHistory();
      return;
    }

    const fields = 'id, chave_operacao, store_id, local_estoque_id, modo, status, solicitado_por, total_itens, itens_sucesso, itens_falha, iniciado_em, concluido_em, erro, created_at';
    const from = (nuvemshopAuditPage - 1) * nuvemshopAuditPageSize;
    const to = from + nuvemshopAuditPageSize - 1;
    let historyQuery = sb.from('nuvemshop_sincronizacoes')
      .select(fields, { count: 'exact' });

    if (filter === 'simulacao' || filter === 'aplicacao') {
      historyQuery = historyQuery.eq('modo', filter);
    } else if (filter === 'falha') {
      historyQuery = historyQuery.or('status.in.(falhou,parcial),itens_falha.gt.0');
    }
    if (matchingIds) historyQuery = historyQuery.in('id', matchingIds);

    const historyResult = await historyQuery
      .order('created_at', { ascending: false })
      .range(from, to);
    if (historyResult.error) throw historyResult.error;

    const histories = historyResult.data || [];
    nuvemshopAuditTotal = historyResult.count || 0;

    const totalPages = Math.max(1, Math.ceil(nuvemshopAuditTotal / nuvemshopAuditPageSize));
    if (nuvemshopAuditPage > totalPages) {
      nuvemshopAuditPage = totalPages;
      return loadNuvemshopAuditHistory(true);
    }

    const historyIds = histories.map(row => row.id);
    let items = [];
    if (historyIds.length) {
      const itemsResult = await sb.from('nuvemshop_sincronizacao_itens')
        .select('id, sincronizacao_id, produto_id, voltagem, nuvemshop_produto_id, nuvemshop_variante_id, estoque_anterior, estoque_destino, resultado_previsto, diferenca, status, erro, processado_em')
        .in('sincronizacao_id', historyIds)
        .order('id', { ascending: true });
      if (itemsResult.error) throw itemsResult.error;
      items = itemsResult.data || [];
    }

    nuvemshopAuditRows = histories.map(history => ({
      ...history,
      items: items.filter(item => item.sincronizacao_id === history.id)
    }));
    nuvemshopAuditLoaded = true;
    renderNuvemshopAuditHistory();
  } catch (error) {
    console.error('Falha ao consultar historico Nuvemshop', error);
    message.className = 'nuvemshop-message error';
    message.textContent = 'Nao foi possivel consultar o historico de validacoes.';
    message.style.display = 'flex';
  } finally {
    button.disabled = false;
    button.textContent = 'Atualizar';
  }
}

async function resolveNuvemshopAuditSearchIds(search) {
  const matchingIds = new Set();
  const productIds = products
    .filter(product => normalizeCode(`${product.nome || ''} ${product.id}`).includes(search))
    .map(product => product.id);

  const metadataResult = await sb.from('nuvemshop_sincronizacoes')
    .select('id, store_id, status, modo, solicitado_por, created_at')
    .order('created_at', { ascending: false })
    .limit(500);
  if (metadataResult.error) throw metadataResult.error;
  (metadataResult.data || []).forEach(row => {
    if (nuvemshopAuditMetadataTerms(row).includes(search)) matchingIds.add(row.id);
  });

  let itemQuery = null;
  if (productIds.length) {
    itemQuery = sb.from('nuvemshop_sincronizacao_itens')
      .select('sincronizacao_id')
      .in('produto_id', productIds.slice(0, 500));
  } else if (/^\d+$/.test(search)) {
    itemQuery = sb.from('nuvemshop_sincronizacao_itens')
      .select('sincronizacao_id')
      .eq('produto_id', Number(search));
  } else if (/^(110|110v|220|220v)$/.test(search)) {
    const voltage = search.startsWith('110') ? '110V' : '220V';
    itemQuery = sb.from('nuvemshop_sincronizacao_itens')
      .select('sincronizacao_id')
      .ilike('voltagem', voltage);
  }

  if (itemQuery) {
    const itemResult = await itemQuery.limit(2000);
    if (itemResult.error) throw itemResult.error;
    (itemResult.data || []).forEach(item => matchingIds.add(item.sincronizacao_id));
  }

  return Array.from(matchingIds).slice(0, 500);
}

function handleNuvemshopAuditFilters() {
  nuvemshopAuditPage = 1;
  clearTimeout(nuvemshopAuditSearchTimer);
  nuvemshopAuditSearchTimer = setTimeout(() => loadNuvemshopAuditHistory(true), 250);
}

function setNuvemshopAuditPageSize(value) {
  const size = Number(value);
  nuvemshopAuditPageSize = [10, 20, 30].includes(size) ? size : 10;
  nuvemshopAuditPage = 1;
  nuvemshopExpandedAudits.clear();
  loadNuvemshopAuditHistory(true);
}

function changeNuvemshopAuditPage(direction) {
  setNuvemshopAuditPage(nuvemshopAuditPage + Number(direction));
}

function setNuvemshopAuditPage(page) {
  const totalPages = Math.max(1, Math.ceil(nuvemshopAuditTotal / nuvemshopAuditPageSize));
  const nextPage = page === 'last' ? totalPages : Math.min(totalPages, Math.max(1, Number(page) || 1));
  if (nextPage === nuvemshopAuditPage) return;
  nuvemshopAuditPage = nextPage;
  nuvemshopExpandedAudits.clear();
  loadNuvemshopAuditHistory(true);
}

function renderNuvemshopAuditPagination() {
  const pagination = document.getElementById('nuvemshop-audit-pagination');
  const summary = document.getElementById('nuvemshop-audit-pagination-summary');
  const pageInfo = document.getElementById('nuvemshop-audit-page-info');
  const firstButton = document.getElementById('nuvemshop-audit-page-first');
  const previousButton = document.getElementById('nuvemshop-audit-page-prev');
  const nextButton = document.getElementById('nuvemshop-audit-page-next');
  const lastButton = document.getElementById('nuvemshop-audit-page-last');
  if (!pagination || !summary || !pageInfo || !firstButton || !previousButton || !nextButton || !lastButton) return;

  if (!nuvemshopAuditTotal) {
    pagination.style.display = 'none';
    return;
  }

  const totalPages = Math.max(1, Math.ceil(nuvemshopAuditTotal / nuvemshopAuditPageSize));
  const firstItem = (nuvemshopAuditPage - 1) * nuvemshopAuditPageSize + 1;
  const lastItem = Math.min(nuvemshopAuditPage * nuvemshopAuditPageSize, nuvemshopAuditTotal);
  summary.textContent = `Exibindo ${firstItem}-${lastItem} de ${nuvemshopAuditTotal} validacoes`;
  pageInfo.textContent = `Pagina ${nuvemshopAuditPage} de ${totalPages}`;
  firstButton.disabled = nuvemshopAuditPage === 1;
  previousButton.disabled = nuvemshopAuditPage === 1;
  nextButton.disabled = nuvemshopAuditPage === totalPages;
  lastButton.disabled = nuvemshopAuditPage === totalPages;
  pagination.style.display = 'flex';
}

function nuvemshopAuditItemMatches(item, search) {
  const product = products.find(candidate => candidate.id === item.produto_id);
  return normalizeCode(`${product?.nome || ''} ${item.produto_id} ${item.voltagem || ''}`).includes(search);
}

function nuvemshopAuditMetadataTerms(row) {
  return normalizeCode([
    row.id,
    row.store_id,
    row.status,
    row.modo,
    formatNuvemshopAuditDate(row.created_at),
    nuvemshopAuditRequester(row)
  ].join(' '));
}

function buildNuvemshopAuditItems(row) {
  if (!row.items.length) {
    return '<div class="nuvemshop-audit-empty">Esta auditoria nao possui itens gravados.</div>';
  }

  const search = normalizeCode(document.getElementById('nuvemshop-audit-search')?.value || '');
  const filterItems = search && !nuvemshopAuditMetadataTerms(row).includes(search);
  const visibleItems = filterItems
    ? row.items.filter(item => nuvemshopAuditItemMatches(item, search))
    : row.items;
  const countMessage = filterItems
    ? `<div class="nuvemshop-audit-filter-count">${visibleItems.length} de ${row.items.length} itens exibidos</div>`
    : '';

  return `<div class="nuvemshop-audit-items-wrap">
    ${countMessage}
    <table class="nuvemshop-audit-items-table">
      <thead><tr><th>Produto local</th><th>Voltagem</th><th>Estoque anterior</th><th>Destino previsto</th><th>Diferenca</th><th>Resultado</th></tr></thead>
      <tbody>${visibleItems.map(item => {
        const product = products.find(candidate => candidate.id === item.produto_id);
        const productName = product?.nome || `Produto #${item.produto_id}`;
        const difference = item.diferenca == null ? '-' : `${item.diferenca > 0 ? '+' : ''}${item.diferenca}`;
        const resultClass = item.resultado_previsto || 'erro';
        return `<tr>
          <td><strong>${escapeHtml(productName)}</strong><div class="nuvemshop-local-meta">ID ${escapeHtml(item.produto_id)}</div></td>
          <td>${escapeHtml(item.voltagem || 'Unica')}</td>
          <td>${escapeHtml(item.estoque_anterior ?? '-')}</td>
          <td>${escapeHtml(item.estoque_destino ?? '-')}</td>
          <td><strong class="nuvemshop-audit-difference ${escapeHtml(resultClass)}">${escapeHtml(difference)}</strong></td>
          <td><span class="nuvemshop-audit-item-result ${escapeHtml(resultClass)}">${escapeHtml(nuvemshopAuditResultLabel(item.resultado_previsto))}</span>${item.erro ? `<div class="nuvemshop-audit-item-error">${escapeHtml(item.erro)}</div>` : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>
  </div>`;
}

function renderNuvemshopAuditHistory() {
  const message = document.getElementById('nuvemshop-audit-message');
  const tableWrap = document.getElementById('nuvemshop-audit-table-wrap');
  const tbody = document.getElementById('nuvemshop-audit-tbody');
  if (!message || !tableWrap || !tbody || !nuvemshopAuditLoaded) return;

  const pagination = document.getElementById('nuvemshop-audit-pagination');
  const filtered = nuvemshopAuditRows;

  if (!filtered.length) {
    tbody.innerHTML = '';
    tableWrap.style.display = 'none';
    if (pagination) pagination.style.display = 'none';
    message.className = 'nuvemshop-message';
    message.textContent = nuvemshopAuditTotal
      ? 'Nenhuma validacao foi encontrada nesta pagina.'
      : 'Nenhuma validacao corresponde aos filtros escolhidos.';
    message.style.display = 'flex';
    return;
  }

  message.style.display = 'none';
  tableWrap.style.display = 'block';
  tbody.innerHTML = filtered.map(row => {
    const expanded = nuvemshopExpandedAudits.has(row.id);
    const statusClass = ['concluida', 'parcial', 'falhou', 'cancelada'].includes(row.status) ? row.status : 'processando';
    const modeLabel = row.modo === 'simulacao' ? 'Simulacao' : 'Aplicacao';
    return `<tr class="nuvemshop-audit-row">
      <td><strong>${escapeHtml(formatNuvemshopAuditDate(row.created_at))}</strong><div class="nuvemshop-local-meta">${escapeHtml(String(row.id).slice(0, 8))}</div></td>
      <td><span class="nuvemshop-audit-mode ${escapeHtml(row.modo)}">${escapeHtml(modeLabel)}</span></td>
      <td><strong>${escapeHtml(row.store_id)}</strong><div class="nuvemshop-local-meta">${escapeHtml(row.local_estoque_id || 'Local nao informado')}</div></td>
      <td><strong>${escapeHtml(row.total_itens)}</strong><div class="nuvemshop-local-meta">${escapeHtml(row.itens_sucesso)} ok · ${escapeHtml(row.itens_falha)} falhas</div></td>
      <td><span class="nuvemshop-audit-status ${escapeHtml(statusClass)}">${escapeHtml(nuvemshopAuditStatusLabel(row.status))}</span>${row.erro ? `<div class="nuvemshop-audit-item-error">${escapeHtml(row.erro)}</div>` : ''}</td>
      <td>${escapeHtml(nuvemshopAuditRequester(row))}</td>
      <td><button class="nuvemshop-audit-toggle" onclick="toggleNuvemshopAudit('${escapeHtml(row.id)}')" aria-expanded="${expanded}">${expanded ? 'Ocultar' : 'Detalhes'}</button></td>
    </tr>
    ${expanded ? `<tr class="nuvemshop-audit-detail-row"><td colspan="7">${buildNuvemshopAuditItems(row)}</td></tr>` : ''}`;
  }).join('');
  renderNuvemshopAuditPagination();
}

function toggleNuvemshopAudit(id) {
  if (nuvemshopExpandedAudits.has(id)) nuvemshopExpandedAudits.delete(id);
  else nuvemshopExpandedAudits.add(id);
  renderNuvemshopAuditHistory();
}

async function confirmNuvemshopLink(productId, variantId) {
  const normalizedVariantId = variantId == null ? null : Number(variantId);
  const row = nuvemshopCatalogRows.find(item =>
    item.productId === Number(productId) && item.variantId === normalizedVariantId
  );
  if (!row || row.status !== 'matched' || !row.localProduct) {
    alert('Esta correspondencia nao esta disponivel para confirmacao.');
    return;
  }
  if (row.localProduct.tem_voltagem && !row.linkVoltage) {
    alert('Nao foi possivel identificar a voltagem. Este item devera ser vinculado manualmente.');
    return;
  }

  const voltageText = row.linkVoltage ? ` (${row.linkVoltage})` : '';
  const confirmed = confirm(
    `Confirmar vinculo?\n\nNuvemshop: ${row.remoteName} - ${row.variantLabel}\nLocal: ${row.localProduct.nome}${voltageText}\n\nEsta acao nao altera o estoque.`
  );
  if (!confirmed) return;

  const button = document.getElementById(`nuvemshop-link-${row.productId}-${row.variantId || 'base'}`);
  if (button) {
    button.disabled = true;
    button.textContent = 'Salvando...';
  }

  const { data, error } = await sb.from('nuvemshop_vinculos').insert({
    store_id: nuvemshopStoreId,
    produto_id: row.localProduct.id,
    voltagem: row.linkVoltage || null,
    nuvemshop_produto_id: row.productId,
    nuvemshop_variante_id: row.variantId,
    nuvemshop_sku: row.sku || null,
    ativo: true
  }).select('id').single();

  if (error) {
    console.error('Falha ao confirmar vinculo Nuvemshop', error);
    alert(`Nao foi possivel confirmar o vinculo: ${error.message}`);
    if (button) {
      button.disabled = false;
      button.textContent = 'Confirmar vinculo';
    }
    return;
  }

  row.status = 'linked';
  row.savedLinkId = data.id;
  if (nuvemshopPreviewGenerated) nuvemshopPreviewGeneratedAt = new Date();
  renderNuvemshopCatalog();
  showToast('green', 'Vinculo Nuvemshop confirmado. Nenhum estoque foi alterado.');
}

function findNuvemshopCatalogRow(productId, variantId) {
  const normalizedVariantId = variantId == null ? null : Number(variantId);
  return nuvemshopCatalogRows.find(item =>
    item.productId === Number(productId) && item.variantId === normalizedVariantId
  );
}

function restoreAutomaticNuvemshopMatch(row) {
  const candidates = findExactLocalCandidates({ sku: row.sku, barcode: row.barcode });
  const localProduct = candidates.length === 1 ? candidates[0] : null;
  const inferredVoltage = inferVoltage(row.variantLabel) || inferVoltage(row.remoteName);
  const localVoltage = localProduct?.tem_voltagem ? inferredVoltage : null;

  row.status = candidates.length === 1 ? 'matched' : candidates.length > 1 ? 'ambiguous' : 'unmatched';
  row.localProduct = localProduct;
  row.candidates = candidates;
  row.linkVoltage = localVoltage;
  row.localStock = mappedLocalStock(localProduct, localVoltage);
  row.savedLinkId = null;
}

async function unlinkNuvemshopLink(productId, variantId) {
  const row = findNuvemshopCatalogRow(productId, variantId);
  if (!row || row.status !== 'linked' || !row.savedLinkId || !row.localProduct) {
    alert('Este vinculo nao esta disponivel para ser desfeito.');
    return;
  }

  const voltageText = row.linkVoltage ? ` (${row.linkVoltage})` : '';
  const confirmed = confirm(
    `Desfazer este vinculo?\n\nNuvemshop: ${row.remoteName} - ${row.variantLabel}\nLocal: ${row.localProduct.nome}${voltageText}\n\nO registro sera desativado. Nenhum estoque sera alterado.`
  );
  if (!confirmed) return;

  const linkId = row.savedLinkId;
  const button = document.getElementById(`nuvemshop-unlink-${linkId}`);
  if (button) {
    button.disabled = true;
    button.textContent = 'Desfazendo...';
  }

  const { data, error } = await sb.from('nuvemshop_vinculos')
    .update({ ativo: false })
    .eq('id', linkId)
    .eq('ativo', true)
    .select('id')
    .maybeSingle();

  if (error || !data) {
    console.error('Falha ao desfazer vinculo Nuvemshop', error);
    alert(`Nao foi possivel desfazer o vinculo: ${error?.message || 'o registro ativo nao foi encontrado.'}`);
    if (button) {
      button.disabled = false;
      button.textContent = 'Desfazer';
    }
    return;
  }

  restoreAutomaticNuvemshopMatch(row);
  if (nuvemshopPreviewGenerated) nuvemshopPreviewGeneratedAt = new Date();
  renderNuvemshopCatalog();
  showToast('blue', 'Vinculo desfeito. Nenhum estoque foi alterado.');
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

  nuvemshopManualRow = row;
  nuvemshopManualVoltage = null;
  document.getElementById('nuvemshop-manual-search').value = '';
  document.getElementById('nuvemshop-manual-error').textContent = '';
  document.getElementById('nuvemshop-manual-remote').innerHTML = `
    <strong>${escapeHtml(row.remoteName)}</strong>
    <div class="nuvemshop-manual-meta">${escapeHtml(row.variantLabel)} | Produto ${row.productId} | Variante ${row.variantId || '-'}</div>
    <div class="nuvemshop-manual-meta">SKU ${escapeHtml(row.sku || '-')} | Barras ${escapeHtml(row.barcode || '-')} | Estoque ${escapeHtml(row.remoteStock == null ? 'Ilimitado' : row.remoteStock)}</div>`;
  document.getElementById('nuvemshop-manual-local').textContent = 'Selecione o produto local correspondente.';
  document.getElementById('nuvemshop-manual-voltage-wrap').style.display = 'none';
  document.querySelectorAll('#nuvemshop-manual-voltage-wrap button').forEach(button => button.classList.remove('active'));
  renderManualNuvemshopProducts();
  document.getElementById('nuvemshop-manual-modal').classList.add('open');
  setTimeout(() => document.getElementById('nuvemshop-manual-search').focus(), 0);
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
    return;
  }

  const category = product.categoria === 'produto' ? 'Produto' : 'Maquina / Prensa';
  const stockText = product.tem_voltagem
    ? `110V: ${Number(product.quantidade_110v) || 0} | 220V: ${Number(product.quantidade_220v) || 0}`
    : `Estoque: ${Number(product.quantidade) || 0}`;
  localInfo.innerHTML = `<strong>${escapeHtml(product.nome)}</strong><div class="nuvemshop-manual-meta">ID ${product.id} | ${category} | ${stockText}</div>`;
  voltageWrap.style.display = product.tem_voltagem ? 'block' : 'none';
}

function selectManualNuvemshopVoltage(voltage) {
  if (!['110V', '220V'].includes(voltage)) return;
  nuvemshopManualVoltage = voltage;
  document.querySelectorAll('#nuvemshop-manual-voltage-wrap button').forEach(button => {
    button.classList.toggle('active', button.dataset.voltage === voltage);
  });
  document.getElementById('nuvemshop-manual-error').textContent = '';
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
    ativo: true
  }).select('id').single();

  button.disabled = false;
  button.textContent = 'Confirmar vinculo';
  if (error) {
    console.error('Falha ao salvar vinculo manual Nuvemshop', error);
    errorElement.textContent = error.message.includes('duplicate key')
      ? 'Este produto local ou variante da Nuvemshop ja possui um vinculo ativo.'
      : `Nao foi possivel salvar: ${error.message}`;
    return;
  }

  row.status = 'linked';
  row.localProduct = localProduct;
  row.candidates = [];
  row.linkVoltage = localProduct.tem_voltagem ? nuvemshopManualVoltage : null;
  row.localStock = mappedLocalStock(localProduct, row.linkVoltage);
  row.savedLinkId = data.id;
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
  if (name === 'nuvemshop') {
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
