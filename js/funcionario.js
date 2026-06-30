const SUPABASE_URL = 'https://pcugivsgiudlxhnuvttf.supabase.co';
const SUPABASE_KEY = 'sb_publishable_iMMKiY9-Rl95kESNDtHtYA_lFm-P1Ax';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

let products = [];
let newQtys = {};       // { id: qty }                  -> produtos sem voltagem
let newQtysVolt = {};   // { id: { v110: x, v220: y } }  -> produtos com voltagem
let userEmail = null;

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
  const pass  = document.getElementById('login-pass').value;
  document.getElementById('login-error').textContent = '';
  const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
  if (error) { document.getElementById('login-error').textContent = 'E-mail ou senha incorretos.'; return; }
  userEmail = data.user.email;
  document.getElementById('user-email').textContent = userEmail;
  showApp();
  await loadProducts();
}

async function doLogout() { await sb.auth.signOut(); }

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
}

async function loadProducts() {
  const { data } = await sb.from('produtos').select('*').order('nome');
  products = data || [];
  newQtys = {};
  newQtysVolt = {};
  products.forEach(p => {
    if (p.tem_voltagem) {
      newQtysVolt[p.id] = { v110: p.quantidade_110v || 0, v220: p.quantidade_220v || 0 };
    } else {
      newQtys[p.id] = p.quantidade;
    }
  });
  renderCards();
}

function totalQty(p) {
  return p.tem_voltagem ? (p.quantidade_110v + p.quantidade_220v) : p.quantidade;
}

function getStatus(p) {
  const qty = totalQty(p);
  if (qty === 0) return { cls: 'out', label: 'Sem estoque' };
  if (qty <= (p.minimo || 0)) return { cls: 'low', label: 'Estoque baixo' };
  return { cls: 'ok', label: 'OK' };
}

function renderCards() {
  const q = document.getElementById('search-input').value.toLowerCase();
  const filtered = products.filter(p =>
    p.nome.toLowerCase().includes(q) ||
    (p.codigo_fabricante||'').toLowerCase().includes(q) ||
    (p.codigo_interno||'').toLowerCase().includes(q) ||
    (p.codigo_referencia||'').toLowerCase().includes(q)
  );
  const el = document.getElementById('products-list');
  if (!filtered.length) { el.innerHTML = '<div class="empty-state">Nenhum produto encontrado.</div>'; return; }

  el.innerHTML = filtered.map(p => {
    const status = getStatus(p);

    const imgHTML = p.imagem_url
      ? `<img class="prod-img" src="${p.imagem_url}" alt="${p.nome}" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">`
      + `<div class="prod-img-placeholder" style="display:none">📦</div>`
      : `<div class="prod-img-placeholder">📦</div>`;

    const codes = [];
    if (p.codigo_fabricante) codes.push(`Fab: ${p.codigo_fabricante}`);
    if (p.codigo_interno) codes.push(`Int: ${p.codigo_interno}`);
    if (p.codigo_referencia) codes.push(`Ref: ${p.codigo_referencia}`);
    const codesHTML = codes.length
      ? `<div class="prod-codes">${codes.map(c => `<span class="prod-code">${c}</span>`).join('')}</div>`
      : '';

    let qtyBlockHTML;
    if (p.tem_voltagem) {
      const qty110 = newQtysVolt[p.id]?.v110 ?? p.quantidade_110v;
      const qty220 = newQtysVolt[p.id]?.v220 ?? p.quantidade_220v;
      qtyBlockHTML = `
        <div class="volt-section">
          <div class="volt-label-row"><span class="volt-chip v110">110V</span><span class="qty-current">Atual: <strong>${p.quantidade_110v}</strong></span></div>
          <div class="qty-row">
            <div class="counter">
              <button class="counter-btn" onclick="adjVolt(${p.id}, 'v110', -1)">−</button>
              <input class="counter-input" type="number" min="0" id="qty-${p.id}-110" value="${qty110}" oninput="onQtyInputVolt(${p.id}, 'v110', this.value)">
              <button class="counter-btn" onclick="adjVolt(${p.id}, 'v110', 1)">+</button>
            </div>
            <button class="btn-update" id="btn-${p.id}-110" onclick="saveQtyVolt(${p.id}, 'v110')" style="flex:1">Salvar 110V</button>
          </div>
        </div>
        <div class="volt-section">
          <div class="volt-label-row"><span class="volt-chip v220">220V</span><span class="qty-current">Atual: <strong>${p.quantidade_220v}</strong></span></div>
          <div class="qty-row">
            <div class="counter">
              <button class="counter-btn" onclick="adjVolt(${p.id}, 'v220', -1)">−</button>
              <input class="counter-input" type="number" min="0" id="qty-${p.id}-220" value="${qty220}" oninput="onQtyInputVolt(${p.id}, 'v220', this.value)">
              <button class="counter-btn" onclick="adjVolt(${p.id}, 'v220', 1)">+</button>
            </div>
            <button class="btn-update" id="btn-${p.id}-220" onclick="saveQtyVolt(${p.id}, 'v220')" style="flex:1">Salvar 220V</button>
          </div>
        </div>`;
    } else {
      const qty = newQtys[p.id] ?? p.quantidade;
      qtyBlockHTML = `
        <div class="qty-row">
          <div class="qty-current">Atual: <strong>${p.quantidade}</strong></div>
          <div class="counter">
            <button class="counter-btn" onclick="adj(${p.id}, -1)">−</button>
            <input class="counter-input" type="number" min="0" id="qty-${p.id}" value="${qty}" oninput="onQtyInput(${p.id}, this.value)">
            <button class="counter-btn" onclick="adj(${p.id}, 1)">+</button>
          </div>
          <button class="btn-update" id="btn-${p.id}" onclick="saveQty(${p.id})">Salvar</button>
        </div>`;
    }

    return `<div class="prod-card ${status.cls}" id="card-${p.id}">
      <div class="prod-top">
        ${imgHTML}
        <div class="prod-info">
          <div class="prod-name">${p.nome}</div>
          ${codesHTML}
        </div>
        <span class="prod-badge ${status.cls}">${status.label}</span>
      </div>
      ${qtyBlockHTML}
    </div>`;
  }).join('');
}

// ─── PRODUTOS SEM VOLTAGEM ───────────────────────────────
function adj(id, delta) {
  const input = document.getElementById(`qty-${id}`);
  const val = Math.max(0, (parseInt(input.value) || 0) + delta);
  input.value = val; newQtys[id] = val;
}
function onQtyInput(id, val) { newQtys[id] = parseInt(val) || 0; }

async function saveQty(id) {
  const novaQty = newQtys[id];
  const prod = products.find(p => p.id === id);
  if (novaQty === undefined || !prod) return;

  const btn = document.getElementById(`btn-${id}`);
  btn.disabled = true;
  btn.textContent = '...';

  const { data, error } = await sb.rpc('registrar_contagem_estoque', {
    p_produto_id: id,
    p_quantidade: novaQty,
    p_voltagem: null
  });

  if (error) {
    btn.disabled = false;
    btn.textContent = 'Salvar';
    showToast(error.message || 'Nao foi possivel salvar.');
    return;
  }

  const produtoAtualizado = Array.isArray(data) ? data[0] : null;
  if (produtoAtualizado) {
    prod.quantidade = produtoAtualizado.quantidade;
    prod.quantidade_110v = produtoAtualizado.quantidade_110v;
    prod.quantidade_220v = produtoAtualizado.quantidade_220v;
  } else {
    prod.quantidade = novaQty;
  }

  btn.classList.add('saved');
  btn.textContent = 'Salvo';
  showToast(`${prod.nome} -> ${novaQty}`);
  setTimeout(() => {
    btn.disabled = false;
    btn.classList.remove('saved');
    btn.textContent = 'Salvar';
    renderCards();
  }, 1500);
}

// ─── PRODUTOS COM VOLTAGEM ────────────────────────────────
function adjVolt(id, volt, delta) {
  const input = document.getElementById(`qty-${id}-${volt === 'v110' ? '110' : '220'}`);
  const val = Math.max(0, (parseInt(input.value) || 0) + delta);
  input.value = val;
  if (!newQtysVolt[id]) newQtysVolt[id] = {};
  newQtysVolt[id][volt] = val;
}
function onQtyInputVolt(id, volt, val) {
  if (!newQtysVolt[id]) newQtysVolt[id] = {};
  newQtysVolt[id][volt] = parseInt(val) || 0;
}

async function saveQtyVolt(id, volt) {
  const prod = products.find(p => p.id === id);
  if (!prod) return;

  const novaQty = newQtysVolt[id]?.[volt];
  if (novaQty === undefined) return;

  const suffix = volt === 'v110' ? '110' : '220';
  const voltLabel = volt === 'v110' ? '110V' : '220V';
  const rpcVolt = volt === 'v110' ? '110v' : '220v';

  const btn = document.getElementById(`btn-${id}-${suffix}`);
  btn.disabled = true;
  btn.textContent = '...';

  const { data, error } = await sb.rpc('registrar_contagem_estoque', {
    p_produto_id: id,
    p_quantidade: novaQty,
    p_voltagem: rpcVolt
  });

  if (error) {
    btn.disabled = false;
    btn.textContent = `Salvar ${voltLabel}`;
    showToast(error.message || 'Nao foi possivel salvar.');
    return;
  }

  const produtoAtualizado = Array.isArray(data) ? data[0] : null;
  if (produtoAtualizado) {
    prod.quantidade = produtoAtualizado.quantidade;
    prod.quantidade_110v = produtoAtualizado.quantidade_110v;
    prod.quantidade_220v = produtoAtualizado.quantidade_220v;
  } else if (volt === 'v110') {
    prod.quantidade_110v = novaQty;
  } else {
    prod.quantidade_220v = novaQty;
  }

  btn.classList.add('saved');
  btn.textContent = `${voltLabel} salvo`;
  showToast(`${prod.nome} (${voltLabel}) -> ${novaQty}`);
  setTimeout(() => {
    btn.disabled = false;
    btn.classList.remove('saved');
    btn.textContent = `Salvar ${voltLabel}`;
    renderCards();
  }, 1500);
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

document.getElementById('login-pass').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
checkSession();
