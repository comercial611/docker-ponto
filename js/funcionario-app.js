let products = [];
let selectedProduct = null;
let statusFilter = '';
let productTypeFilter = 'maquina';
let userEmail = null;
let historyByProduct = {};

async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();

  if (session) {
    userEmail = session.user.email;
    document.getElementById('user-email').textContent = userEmail;
    showApp();
    await loadProducts();
  }
}

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
  }
});

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass = document.getElementById('login-pass').value;
  const errorEl = document.getElementById('login-error');

  errorEl.textContent = '';

  const { data, error } = await sb.auth.signInWithPassword({
    email,
    password: pass
  });

  if (error) {
    errorEl.textContent = 'E-mail ou senha incorretos.';
    return;
  }

  userEmail = data.user.email;
  document.getElementById('user-email').textContent = userEmail;
  showApp();
  await loadProducts();
}

async function doLogout() {
  await sb.auth.signOut();
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
}

async function loadProducts() {
  const { data, error } = await sb
    .from('produtos')
    .select('*')
    .order('nome');

  if (error) {
    showToast(error.message || 'Nao foi possivel carregar produtos.');
    return;
  }

  products = data || [];
  renderProducts();
}

function totalQty(product) {
  return product.tem_voltagem
    ? (Number(product.quantidade_110v) || 0) + (Number(product.quantidade_220v) || 0)
    : Number(product.quantidade) || 0;
}

function productCategory(product) {
  return product.categoria || 'maquina';
}

function setProductTypeFilter(type) {
  productTypeFilter = type === 'produto' ? 'produto' : 'maquina';
  document.getElementById('type-filter-maquina')?.classList.toggle('active', productTypeFilter === 'maquina');
  document.getElementById('type-filter-produto')?.classList.toggle('active', productTypeFilter === 'produto');
  renderProducts();
}

function getStatus(product) {
  const qty = totalQty(product);

  if (qty === 0) return { cls: 'out', label: 'Zerado' };
  if (qty <= (Number(product.minimo) || 0)) return { cls: 'low', label: 'Abaixo do mínimo' };

  return { cls: 'ok', label: 'OK' };
}

function productImage(product, className) {
  if (product.imagem_url) {
    return `
      <img
        class="${className}"
        src="${escapeAttr(product.imagem_url)}"
        alt="${escapeAttr(product.nome)}"
        onerror="this.outerHTML='<div class=${className}-placeholder>Sem foto</div>'"
      >`;
  }

  return `<div class="${className}-placeholder">Sem foto</div>`;
}

function productCodes(product) {
  const codes = [];

  if (product.codigo_fabricante) codes.push(`Fab: ${product.codigo_fabricante}`);
  if (product.codigo_interno) codes.push(`Int: ${product.codigo_interno}`);
  if (product.codigo_referencia) codes.push(`Ref: ${product.codigo_referencia}`);
  if (product.sku) codes.push(`Barras: ${product.sku}`);

  return codes;
}

function renderProducts() {
  const query = document.getElementById('search-input').value.trim().toLowerCase();
  const listEl = document.getElementById('products-list');
  const machineCount = products.filter(product => productCategory(product) === 'maquina').length;
  const productCount = products.filter(product => productCategory(product) === 'produto').length;

  document.getElementById('count-type-maquina').textContent = machineCount;
  document.getElementById('count-type-produto').textContent = productCount;

  const filtered = products.filter(product => {
    const status = getStatus(product);
    const matchesType = productCategory(product) === productTypeFilter;
    const matchesStatus = !statusFilter || status.cls === statusFilter;
    const haystack = [
      product.nome,
      product.codigo_fabricante,
      product.codigo_interno,
      product.codigo_referencia,
      product.sku
    ].filter(Boolean).join(' ').toLowerCase();

    return matchesType && matchesStatus && haystack.includes(query);
  });

  if (!filtered.length) {
    listEl.innerHTML = '<div class="empty-state">Nenhum produto encontrado.</div>';
    return;
  }

  listEl.innerHTML = filtered.map(product => {
    const status = getStatus(product);
    const codes = productCodes(product);
    const qtyText = product.tem_voltagem
      ? `110V ${product.quantidade_110v || 0} · 220V ${product.quantidade_220v || 0}`
      : `Atual ${product.quantidade || 0}`;

    return `
      <button class="product-card ${status.cls}" onclick="openProductSheet(${product.id})">
        ${productImage(product, 'product-img')}
        <div>
          <div class="product-name">${escapeHtml(product.nome)}</div>
          <div class="product-code">${escapeHtml(codes[0] || 'Sem código')}</div>
          <div class="product-meta">
            <span class="pill status-pill ${status.cls}">${status.label}</span>
            <span class="pill">${escapeHtml(qtyText)}</span>
          </div>
        </div>
        <div class="qty-summary"><span>Total</span>${totalQty(product)}</div>
      </button>`;
  }).join('');
}

function setStatusFilter(nextFilter) {
  statusFilter = nextFilter;

  document.querySelectorAll('.filter-chip').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.filter === nextFilter);
  });

  renderProducts();
}

async function openProductSheet(productId) {
  selectedProduct = products.find(product => product.id === productId);

  if (!selectedProduct) return;

  renderProductSheet();
  document.getElementById('product-overlay').classList.add('open');
  document.getElementById('product-sheet').classList.add('open');

  await loadProductHistory(productId);
}

function closeProductSheet() {
  selectedProduct = null;
  document.getElementById('product-overlay').classList.remove('open');
  document.getElementById('product-sheet').classList.remove('open');
}

function renderProductSheet() {
  if (!selectedProduct) return;

  const status = getStatus(selectedProduct);
  const codes = productCodes(selectedProduct);
  const observations = selectedProduct.observacoes || '';
  const content = document.getElementById('sheet-content');

  content.innerHTML = `
    <div class="sheet-hero">
      ${productImage(selectedProduct, 'sheet-img')}
      <div>
        <div class="sheet-title">${escapeHtml(selectedProduct.nome)}</div>
        <div class="sheet-sub">${escapeHtml(codes.join(' · ') || 'Sem códigos cadastrados')}</div>
        <div class="product-meta" style="margin-top:10px">
          <span class="pill status-pill ${status.cls}">${status.label}</span>
          <span class="pill">Mínimo ${selectedProduct.minimo || 0}</span>
        </div>
        <button class="close-sheet" onclick="closeProductSheet()">Fechar</button>
      </div>
    </div>

    <div class="section-label">Contagem</div>
    ${renderCountControls(selectedProduct)}

    <div class="section-label">Observações</div>
    <div class="notes-panel">
      <textarea class="notes-box" id="product-notes" placeholder="Digite uma observação sobre este produto">${escapeHtml(observations)}</textarea>
      <button class="notes-save-btn" id="save-notes-btn" onclick="saveProductNotes(${selectedProduct.id})">Salvar observação</button>
    </div>

    <div class="section-label">Últimas alterações deste produto</div>
    <div class="history-list" id="product-history">
      <div class="empty-state">Carregando histórico...</div>
    </div>
  `;
}

function renderCountControls(product) {
  if (product.tem_voltagem) {
    return (
      renderCountBox(product, '110V', '110v', product.quantidade_110v || 0) +
      renderCountBox(product, '220V', '220v', product.quantidade_220v || 0)
    );
  }

  return renderCountBox(product, 'Estoque', null, product.quantidade || 0);
}

function renderCountBox(product, label, volt, qty) {
  const inputId = volt ? `count-${product.id}-${volt}` : `count-${product.id}`;
  const saveArgs = volt ? `${product.id}, '${volt}'` : `${product.id}, null`;

  return `
    <div class="count-box">
      <div class="count-head">
        <span>${label}</span>
        <span>Atual <strong>${qty}</strong></span>
      </div>

      <div class="count-row">
        <button class="count-btn" onclick="adjustCount('${inputId}', -1)">-</button>
        <input class="count-input" type="number" min="0" id="${inputId}" value="${qty}">
        <button class="count-btn" onclick="adjustCount('${inputId}', 1)">+</button>
      </div>

      <div class="quick-row">
        <button class="quick-btn" onclick="adjustCount('${inputId}', -10)">-10</button>
        <button class="quick-btn" onclick="adjustCount('${inputId}', -5)">-5</button>
        <button class="quick-btn" onclick="adjustCount('${inputId}', 5)">+5</button>
        <button class="quick-btn" onclick="adjustCount('${inputId}', 10)">+10</button>
      </div>

      <button class="save-btn" id="save-${inputId}" onclick="saveCount(${saveArgs})">
        Salvar contagem
      </button>
    </div>
  `;
}

function adjustCount(inputId, delta) {
  const input = document.getElementById(inputId);
  const nextValue = Math.max(0, (parseInt(input.value, 10) || 0) + delta);
  input.value = nextValue;
}

async function saveCount(productId, volt) {
  const product = products.find(item => item.id === productId);

  if (!product) return;

  const inputId = volt ? `count-${productId}-${volt}` : `count-${productId}`;
  const btn = document.getElementById(`save-${inputId}`);
  const quantidade = parseInt(document.getElementById(inputId).value, 10) || 0;

  btn.disabled = true;
  btn.textContent = 'Salvando...';

  const { data, error } = await sb.rpc('registrar_contagem_estoque', {
    p_produto_id: productId,
    p_quantidade: quantidade,
    p_voltagem: volt
  });

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Salvar contagem';
    showToast(error.message || 'Nao foi possivel salvar.');
    return;
  }

  const updated = Array.isArray(data) ? data[0] : null;

  if (updated) {
    product.quantidade = updated.quantidade;
    product.quantidade_110v = updated.quantidade_110v;
    product.quantidade_220v = updated.quantidade_220v;
  } else if (volt === '110v') {
    product.quantidade_110v = quantidade;
  } else if (volt === '220v') {
    product.quantidade_220v = quantidade;
  } else {
    product.quantidade = quantidade;
  }

  btn.classList.add('saved');
  btn.textContent = 'Salvo';
  showToast('Contagem salva.');

  selectedProduct = product;
  renderProducts();
  renderProductSheet();
  await loadProductHistory(productId);

  setTimeout(() => {
    const newBtn = document.getElementById(`save-${inputId}`);
    if (newBtn) {
      newBtn.disabled = false;
      newBtn.classList.remove('saved');
      newBtn.textContent = 'Salvar contagem';
    }
  }, 900);
}

async function saveProductNotes(productId) {
  const product = products.find(item => item.id === productId);
  const input = document.getElementById('product-notes');
  const btn = document.getElementById('save-notes-btn');

  if (!product || !input || !btn) return;

  btn.disabled = true;
  btn.textContent = 'Salvando...';

  const { data, error } = await sb.rpc('atualizar_observacao_produto', {
    p_produto_id: productId,
    p_observacoes: input.value
  });

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Salvar observação';
    showToast(error.message || 'Não foi possível salvar a observação.');
    return;
  }

  const updated = Array.isArray(data) ? data[0] : null;
  product.observacoes = updated ? updated.observacoes : input.value.trim();
  selectedProduct = product;

  btn.classList.add('saved');
  btn.textContent = 'Observação salva';
  showToast('Observação salva.');
  renderProducts();

  setTimeout(() => {
    const newBtn = document.getElementById('save-notes-btn');
    if (newBtn) {
      newBtn.disabled = false;
      newBtn.classList.remove('saved');
      newBtn.textContent = 'Salvar observação';
    }
  }, 900);
}
async function loadProductHistory(productId) {
  const historyEl = document.getElementById('product-history');

  if (!historyEl) return;

  const { data, error } = await sb
    .from('historico')
    .select('id, quantidade_anterior, quantidade_nova, usuario, created_at, voltagem, tipo, vendedor')
    .eq('produto_id', productId)
    .order('created_at', { ascending: false })
    .limit(8);

  if (error) {
    historyEl.innerHTML = '<div class="empty-state">Não foi possível carregar o histórico.</div>';
    return;
  }

  historyByProduct[productId] = data || [];
  renderProductHistory(productId);
}

function renderProductHistory(productId) {
  const historyEl = document.getElementById('product-history');
  const rows = historyByProduct[productId] || [];

  if (!rows.length) {
    historyEl.innerHTML = '<div class="empty-state">Sem histórico para este produto.</div>';
    return;
  }

  historyEl.innerHTML = rows.map(row => {
    const who = row.tipo === 'baixa'
      ? (row.vendedor || row.usuario || 'Vendedor')
      : (row.usuario || 'Funcionário');

    const type = row.tipo === 'baixa' ? 'Baixa' : 'Contagem';
    const volt = row.voltagem ? ` · ${row.voltagem.toUpperCase()}` : '';
    const time = new Date(row.created_at).toLocaleString('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short'
    });

    return `
      <div class="history-item">
        <div>
          <div class="history-main">
            ${type}${volt}: ${row.quantidade_anterior} para ${row.quantidade_nova}
          </div>
          <div class="history-meta">${escapeHtml(who)}</div>
        </div>
        <div class="history-meta">${time}</div>
      </div>`;
  }).join('');
}

function showToast(message) {
  const toast = document.getElementById('toast');

  toast.textContent = message;
  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
  }, 2400);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  })[char]);
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#096;');
}

document.getElementById('login-pass').addEventListener('keydown', event => {
  if (event.key === 'Enter') doLogin();
});

document.getElementById('login-email').addEventListener('keydown', event => {
  if (event.key === 'Enter') doLogin();
});

checkSession();
