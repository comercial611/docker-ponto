// ─── NOTIFICAÇÕES ────────────────────────────────────────
let notifications = [];
let dismissedNotificationSources = new Set();
let productsSnapshot = {}; // { id: { quantidade, quantidade_110v, quantidade_220v, minimo, tem_voltagem } }
const NOTIFICATIONS_STORAGE_KEY = 'admin-notifications';
const DISMISSED_NOTIFICATIONS_STORAGE_KEY = 'admin-notifications-dismissed';
const NOTIFICATION_COLORS = new Set(['green', 'yellow', 'red', 'blue']);
const DEFAULT_NOTIFICATION_COLOR = 'blue';

function sanitizeNotificationText(text) {
  return escapeHtml(text)
    .replace(/&lt;strong&gt;/g, '<strong>')
    .replace(/&lt;\/strong&gt;/g, '</strong>');
}

function normalizeNotificationColor(color) {
  return NOTIFICATION_COLORS.has(color) ? color : DEFAULT_NOTIFICATION_COLOR;
}

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
    const dismissed = JSON.parse(localStorage.getItem(DISMISSED_NOTIFICATIONS_STORAGE_KEY) || '[]');
    dismissedNotificationSources = new Set(Array.isArray(dismissed) ? dismissed : []);
    notifications = saved
      .map(n => ({
        ...n,
        color: normalizeNotificationColor(n.color),
        time: new Date(n.time)
      }))
      .filter(n => Number.isFinite(n.id) && n.text && !Number.isNaN(n.time.getTime()));
  } catch {
    notifications = [];
    dismissedNotificationSources = new Set();
  }
  renderNotifDropdown();
}

function saveNotifications() {
  localStorage.setItem(NOTIFICATIONS_STORAGE_KEY, JSON.stringify(notifications.slice(0, 50)));
  localStorage.setItem(DISMISSED_NOTIFICATIONS_STORAGE_KEY, JSON.stringify([...dismissedNotificationSources].slice(-500)));
}

function pushNotification(color, text, sourceId, time = new Date(), showToastMessage = true) {
  if (sourceId && (dismissedNotificationSources.has(sourceId) || notifications.some(n => n.sourceId === sourceId))) return;

  const notif = { id: Date.now() + Math.random(), sourceId, color, text, time: new Date(time) };
  notifications.unshift(notif);
  if (notifications.length > 50) notifications.pop();
  saveNotifications();
  renderNotifDropdown();
  if (showToastMessage) showToast(color, text);
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

  listEl.innerHTML = notifications.map(n => {
    const color = normalizeNotificationColor(n.color);
    const id = Number.isFinite(n.id) ? n.id : null;
    if (id === null) return '';
    return `
    <div class="notif-item">
      <div class="notif-dot ${color}"></div>
      <div class="notif-body">
        <div class="notif-text">${sanitizeNotificationText(n.text)}</div>
        <div class="notif-time">${n.time.toLocaleString('pt-BR')}</div>
      </div>
      <button class="notif-delete-btn" onclick="event.stopPropagation(); deleteNotification(${id})" title="Apagar notificação">x</button>
    </div>`;
  }).join('');
}

function toggleNotifDropdown() {
  document.getElementById('notif-dropdown').classList.toggle('open');
}

function clearNotifications() {
  notifications.forEach(n => {
    if (n.sourceId) dismissedNotificationSources.add(n.sourceId);
  });
  notifications = [];
  saveNotifications();
  renderNotifDropdown();
}

function deleteNotification(id) {
  const notification = notifications.find(n => n.id === id);
  if (notification?.sourceId) dismissedNotificationSources.add(notification.sourceId);
  notifications = notifications.filter(n => n.id !== id);
  saveNotifications();
  renderNotifDropdown();
}

document.addEventListener('click', (e) => {
  const wrap = document.querySelector('.notif-bell-wrap');
  if (wrap && !wrap.contains(e.target)) document.getElementById('notif-dropdown').classList.remove('open');
});

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

function shouldNotifyHistoryRecord(record) {
  return ['contagem', 'baixa', 'baixa_manual_produto'].includes(String(record?.tipo || ''));
}

function pushHistoryNotification(record, showToastMessage = true) {
  if (!record || !shouldNotifyHistoryRecord(record)) return;

  const product = products.find(p => p.id === record.produto_id);
  const productName = product?.nome || 'Produto';
  const before = record.quantidade_anterior;
  const after = record.quantidade_nova;
  const volt = record.voltagem ? ` (${record.voltagem})` : '';
  const sourceId = `historico-${record.id}`;

  if (isBaixaTipo(record.tipo)) {
    const vendedor = record.vendedor || record.usuario || 'vendedor';
    pushNotification('blue', `<strong>${productName}</strong>${volt}: baixa de ${before} para ${after} por ${vendedor}`, sourceId, record.created_at, showToastMessage);
    return;
  }

  const usuario = record.usuario || 'funcionário';
  const color = after >= before ? 'green' : 'yellow';
  pushNotification(color, `<strong>${productName}</strong>${volt}: contagem de ${before} para ${after} por ${usuario}`, sourceId, record.created_at, showToastMessage);
}

function restoreRecentHistoryNotifications(rows) {
  [...rows].reverse().forEach(record => pushHistoryNotification(record, false));
}
