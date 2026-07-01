let products = [];
let vendedores = [];
let deleteTargetId = null;
let deleteVendedorId = null;

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
function pushHistoryNotification(record) {
  if (!record) return;

  const product = products.find(p => p.id === record.produto_id);
  const productName = product?.nome || 'Produto';
  const before = record.quantidade_anterior;
  const after = record.quantidade_nova;
  const volt = record.voltagem ? ` (${record.voltagem})` : '';
  const sourceId = `historico-${record.id}`;

  if (record.tipo === 'baixa') {
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

function codesHTML(p) {
  const tags = [];
  if (p.codigo_fabricante) tags.push(`Fab: ${p.codigo_fabricante}`);
  if (p.codigo_interno) tags.push(`Int: ${p.codigo_interno}`);
  if (p.codigo_referencia) tags.push(`Ref: ${p.codigo_referencia}`);
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
      (p.codigo_referencia||'').toLowerCase().includes(q);
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
  const filtered = products.filter(p =>
    p.nome.toLowerCase().includes(q) ||
    (p.codigo_fabricante||'').toLowerCase().includes(q) ||
    (p.codigo_interno||'').toLowerCase().includes(q) ||
    (p.codigo_referencia||'').toLowerCase().includes(q)
  );
  const tbody = document.getElementById('prod-tbody');
  if (!filtered.length) { tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum produto encontrado.</td></tr>'; return; }
  tbody.innerHTML = filtered.map(p => `<tr>
    <td>${thumbHTML(p)}</td>
    <td><strong>${p.nome}</strong></td>
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
    codigo_fabricante: document.getElementById('p-cod-fab').value.trim() || null,
    codigo_interno: document.getElementById('p-cod-interno').value.trim() || null,
    codigo_referencia: document.getElementById('p-cod-ref').value.trim() || null,
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
  document.getElementById('p-cod-fab').value = p.codigo_fabricante || '';
  document.getElementById('p-cod-interno').value = p.codigo_interno || '';
  document.getElementById('p-cod-ref').value = p.codigo_referencia || '';
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
  ['p-nome','p-cod-fab','p-cod-interno','p-cod-ref','p-qty','p-min','p-qty-110','p-qty-220','p-min-volt','p-obs','p-img-url','p-edit-id'].forEach(id => document.getElementById(id).value = '');
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
    const time = new Date(r.created_at).toLocaleString('pt-BR');
    const thumb = r.produtos?.imagem_url
      ? `<img src="${r.produtos.imagem_url}" style="width:36px;height:36px;border-radius: 4px;object-fit:cover;border:1px solid var(--border);flex-shrink:0" onerror="this.style.display='none'">`
      : `<div style="width:36px;height:36px;border-radius: 4px;background:var(--surface2);display:flex;align-items:center;justify-content:center;font-size:16px;flex-shrink:0">📦</div>`;
    const voltTag = r.voltagem ? `<span class="volt-tag" style="margin-left:6px">${r.voltagem}</span>` : '';
    const tipoTag = r.tipo === 'baixa' ? `<span class="history-type-tag">Baixa</span>` : '';
    const quemTexto = r.tipo === 'baixa' ? `vendido por ${r.vendedor || r.usuario || '—'}` : `por ${r.usuario || 'Funcionário'}`;
    return `<div class="history-item">
      ${thumb}
      <div class="history-icon ${r.tipo === 'baixa' ? 'baixa' : (up ? 'up' : 'down')}">${r.tipo === 'baixa' ? '↓' : (up ? '▲' : '▼')}</div>
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
