let products = [];
let vendedores = [];
let deleteTargetId = null;
let deleteVendedorId = null;
let csvPreviewRows = [];
let csvPreviewApplied = false;
let csvPreviewFileName = null;
let csvLots = [];

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
  if (session) { showApp(); init(); }
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
  showApp(); init();
}
async function doLogout() { await sb.auth.signOut(); }
function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
}

async function init() {
  loadSavedNotifications();
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
  document.getElementById('qty-simple-wrap').classList.toggle('visible', !checked);
  document.getElementById('qty-voltage-wrap').classList.toggle('visible', checked);
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

  const body = {
    nome,
    categoria: document.getElementById('p-categoria').value || 'maquina',
    codigo_fabricante: document.getElementById('p-cod-fab').value.trim() || null,
    codigo_interno: document.getElementById('p-cod-interno').value.trim() || null,
    codigo_referencia: document.getElementById('p-cod-ref').value.trim() || null,
    sku: document.getElementById('p-cod-barras').value.trim() || null,
    tem_voltagem: temVoltagem,
    observacoes: document.getElementById('p-obs').value.trim() || null,
    imagem_url: document.getElementById('p-img-url').value.trim() || null
  };

  if (temVoltagem) {
    body.quantidade_110v = parseInt(document.getElementById('p-qty-110').value) || 0;
    body.quantidade_220v = parseInt(document.getElementById('p-qty-220').value) || 0;
    body.quantidade = 0;
    body.minimo = parseInt(document.getElementById('p-min-volt').value) || 0;
  } else {
    body.quantidade = parseInt(document.getElementById('p-qty').value) || 0;
    body.minimo = parseInt(document.getElementById('p-min').value) || 0;
    body.quantidade_110v = 0;
    body.quantidade_220v = 0;
  }

  const editId = document.getElementById('p-edit-id').value;
  if (editId) { await sb.from('produtos').update(body).eq('id', editId); }
  else { await sb.from('produtos').insert(body); }
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
  ['p-nome','p-cod-fab','p-cod-interno','p-cod-ref','p-cod-barras','p-qty','p-min','p-qty-110','p-qty-220','p-min-volt','p-obs','p-img-url','p-edit-id'].forEach(id => document.getElementById(id).value = '');
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

  if (csvPreviewApplied) {
    btn.disabled = true;
    btn.textContent = 'Baixa aplicada';
    msg.classList.add('ok');
    msg.textContent = 'CSV aplicado. Se precisar repetir, selecione o arquivo novamente.';
    return;
  }

  btn.textContent = applicable.length ? `Aplicar baixa (${applicable.length})` : 'Aplicar baixa';
  btn.disabled = !applicable.length || invalid > 0 || insufficient > 0;

  if (!csvPreviewRows.length) {
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
  updateCsvApplyState();
  summaryEl.textContent = 'Lendo arquivo...';
  wrapEl.style.display = 'none';
  tbody.innerHTML = '';

  const text = await file.text();
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

  if (!applicable.length || invalid > 0 || insufficient > 0 || csvPreviewApplied) {
    updateCsvApplyState();
    return;
  }

  const ok = confirm(`Aplicar baixa em ${applicable.length} produto${applicable.length === 1 ? '' : 's'} encontrado${applicable.length === 1 ? '' : 's'}?`);
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

  const { data, error } = await sb.rpc('registrar_baixa_csv_produtos', {
    p_itens: itens,
    p_arquivo_nome: csvPreviewFileName,
    p_resumo: resumo
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
          <div class="csv-lot-meta">${time} · ${escapeHtml(lote.aplicado_email || 'admin')}</div>
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
  const { data } = await sb.from('historico').select('*, produtos(nome, imagem_url)').order('created_at', { ascending: false }).limit(50);
  historyRows = data || [];
  renderHistory();
}

function renderHistory() {
  const q = (document.getElementById('search-historico')?.value || '').toLowerCase();
  const rows = historyRows.filter(r =>
    (r.produtos?.nome || '').toLowerCase().includes(q) ||
    (r.usuario || '').toLowerCase().includes(q) ||
    (r.vendedor || '').toLowerCase().includes(q)
  );
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
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', ['dashboard','produtos','vendedores','historico'][i] === name));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.getElementById(`tab-${name}`).classList.add('active');
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
