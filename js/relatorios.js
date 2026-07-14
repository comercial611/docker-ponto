let products = [];
let historyRows = [];
let csvLots = [];
let attentionLists = {};

async function checkSession() {
  const { data: { session } } = await sb.auth.getSession();
  if (session) await enterReportsArea();
}

sb.auth.onAuthStateChange((event) => {
  if (event === 'SIGNED_OUT') {
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('login-screen').style.display = 'flex';
  }
});

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const password = document.getElementById('login-pass').value;
  document.getElementById('login-error').textContent = '';

  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) {
    document.getElementById('login-error').textContent = 'E-mail ou senha incorretos.';
    return;
  }

  await enterReportsArea();
}

async function doLogout() {
  await sb.auth.signOut();
}

async function enterReportsArea() {
  const { data: tipo, error } = await sb.rpc('usuario_tipo');
  if (error || tipo !== 'admin') {
    await sb.auth.signOut();
    document.getElementById('login-error').textContent = 'Acesso permitido apenas para administradores.';
    return false;
  }

  showApp();
  await loadData();
  return true;
}

function showApp() {
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = 'block';
}

async function loadData() {
  setLoadingState();

  const [productsRes, historyRes, csvRes] = await Promise.all([
    sb.from('produtos').select('*').order('nome'),
    sb.from('historico').select('*, produtos(id,nome,imagem_url,categoria)').order('created_at', { ascending: false }).limit(500),
    sb.from('baixas_csv_lotes').select('*, baixas_csv_itens(*)').order('created_at', { ascending: false }).limit(12)
  ]);

  products = productsRes.data || [];
  historyRows = historyRes.data || [];
  csvLots = csvRes.data || [];

  if (productsRes.error) showLoadError(productsRes.error.message);
  if (historyRes.error) historyRows = [];
  if (csvRes.error) csvLots = [];

  renderAll();
}

function setLoadingState() {
  ['stat-produtos', 'stat-maquinas', 'stat-baixo', 'stat-zerado', 'stat-csv'].forEach(id => {
    document.getElementById(id).textContent = '-';
  });
  ['machine-stat-total', 'machine-stat-units', 'machine-stat-low', 'machine-stat-out', 'machine-stat-sales'].forEach(id => {
    document.getElementById(id).textContent = '-';
  });
  document.getElementById('purchase-tbody').innerHTML = '<tr><td colspan="6" class="empty-state">Carregando relatorio...</td></tr>';
  document.getElementById('top-products-list').innerHTML = '<div class="empty-state">Carregando...</div>';
  document.getElementById('csv-lots-list').innerHTML = '<div class="empty-state">Carregando...</div>';
  document.getElementById('attention-grid').innerHTML = '';
  document.getElementById('machine-purchase-tbody').innerHTML = '<tr><td colspan="8" class="empty-state">Carregando relatorio...</td></tr>';
  document.getElementById('top-machines-list').innerHTML = '<div class="empty-state">Carregando...</div>';
  document.getElementById('machine-sales-list').innerHTML = '<div class="empty-state">Carregando...</div>';
  document.getElementById('machine-attention-grid').innerHTML = '';
}

function showLoadError(message) {
  document.getElementById('purchase-tbody').innerHTML = `<tr><td colspan="6" class="empty-state">${escapeHtml(message)}</td></tr>`;
}

function renderAll() {
  renderStats();
  renderPurchaseSuggestions();
  renderTopProducts();
  renderCsvLots();
  renderAttention();
  renderMachineReport();
}

function switchReportTab(tab) {
  ['produtos', 'maquinas'].forEach(name => {
    document.getElementById(`report-tab-${name}`).classList.toggle('active', name === tab);
    document.getElementById(`report-panel-${name}`).classList.toggle('active', name === tab);
  });
}

function productCategory(product) {
  return product.categoria || 'maquina';
}

function totalQty(product) {
  return product.tem_voltagem
    ? (Number(product.quantidade_110v) || 0) + (Number(product.quantidade_220v) || 0)
    : Number(product.quantidade) || 0;
}

function getVoltageIssues(product) {
  if (!product.tem_voltagem) return [];

  const issues = [];
  if ((Number(product.quantidade_110v) || 0) === 0) issues.push('110V');
  if ((Number(product.quantidade_220v) || 0) === 0) issues.push('220V');
  return issues;
}

function getStatus(product) {
  const qty = totalQty(product);
  const minimo = Number(product.minimo) || 0;
  if (qty === 0) return { cls: 'out', label: 'Sem estoque' };
  if (qty <= minimo) return { cls: 'low', label: 'Estoque baixo' };
  return { cls: 'ok', label: 'OK' };
}

function renderStats() {
  const productItems = products.filter(p => productCategory(p) === 'produto');
  const machineItems = products.filter(p => productCategory(p) !== 'produto');
  const lowItems = productItems.filter(p => getStatus(p).cls === 'low');
  const outItems = productItems.filter(p => getStatus(p).cls === 'out');
  const csvTotal = csvLots.reduce((sum, lot) => sum + (Number(lot.total_aplicado) || 0), 0);

  document.getElementById('stat-produtos').textContent = productItems.length;
  document.getElementById('stat-maquinas').textContent = machineItems.length;
  document.getElementById('stat-baixo').textContent = lowItems.length;
  document.getElementById('stat-zerado').textContent = outItems.length;
  document.getElementById('stat-csv').textContent = formatNumber(csvTotal);
}

function renderPurchaseSuggestions() {
  const rows = products
    .filter(p => productCategory(p) === 'produto')
    .map(p => {
      const qty = totalQty(p);
      const minimo = Number(p.minimo) || 0;
      return { product: p, qty, minimo, suggested: Math.max(minimo - qty, 0), status: getStatus(p) };
    })
    .filter(item => item.status.cls !== 'ok')
    .sort((a, b) => {
      if (a.status.cls !== b.status.cls) return a.status.cls === 'out' ? -1 : 1;
      return b.suggested - a.suggested;
    });

  document.getElementById('purchase-count').textContent = `${rows.length} ${rows.length === 1 ? 'item' : 'itens'}`;

  const tbody = document.getElementById('purchase-tbody');
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty-state">Nenhum produto comum abaixo do minimo.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(({ product, qty, minimo, suggested, status }) => `
    <tr>
      <td>${productIdentityHTML(product, true)}</td>
      <td>${codesHTML(product)}</td>
      <td><span class="strong-number">${formatNumber(qty)}</span></td>
      <td>${formatNumber(minimo)}</td>
      <td><span class="strong-number">${formatNumber(suggested)}</span></td>
      <td><span class="badge ${status.cls}">${status.label}</span></td>
    </tr>
  `).join('');
}

function renderTopProducts() {
  const totals = new Map();

  csvLots.forEach(lot => {
    (lot.baixas_csv_itens || []).forEach(item => {
      addTopProduct(totals, item.produto_id, item.produto_nome, Number(item.quantidade_csv) || 0);
    });
  });

  historyRows
    .filter(row => String(row.tipo || '').startsWith('baixa') && row.tipo !== 'baixa_csv_produto')
    .forEach(row => {
      const product = findProduct(row.produto_id, row.produtos?.nome);
      if (product && productCategory(product) !== 'produto') return;
      addTopProduct(totals, row.produto_id, row.produtos?.nome || 'Produto', Math.abs((row.quantidade_nova || 0) - (row.quantidade_anterior || 0)));
    });

  const rows = Array.from(totals.values())
    .filter(item => item.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);

  const el = document.getElementById('top-products-list');
  if (!rows.length) {
    el.innerHTML = '<div class="empty-state">Ainda nao ha baixas suficientes para montar o ranking.</div>';
    return;
  }

  const max = rows[0].total || 1;
  el.innerHTML = rows.map(item => {
    const width = Math.max(4, Math.round((item.total / max) * 100));
    return `<div class="bar-row">
      <div class="bar-row-top">
        ${rankingIdentityHTML(item)}
        <div class="bar-value">${formatNumber(item.total)}</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${width}%"></div></div>
    </div>`;
  }).join('');
}

function addTopProduct(map, id, name, qty) {
  if (!qty) return;
  const key = id || normalizeText(name || '');
  const current = map.get(key) || { id, name: name || 'Produto', total: 0 };
  current.total += qty;
  map.set(key, current);
}

function renderCsvLots() {
  const el = document.getElementById('csv-lots-list');
  if (!csvLots.length) {
    el.innerHTML = '<div class="empty-state">Nenhuma importacao CSV registrada ainda.</div>';
    return;
  }

  el.innerHTML = csvLots.slice(0, 6).map(lot => `
    <div class="csv-card">
      <div class="csv-title">${escapeHtml(lot.arquivo_nome || 'CSV aplicado')}</div>
      <div class="csv-meta">${formatDate(lot.created_at)} - ${escapeHtml(lot.aplicado_email || 'admin')}</div>
      <div class="csv-stats">
        <div class="csv-stat"><strong>${formatNumber(lot.produtos_encontrados || 0)}</strong>encontrados</div>
        <div class="csv-stat"><strong>${formatNumber(lot.total_aplicado || 0)}</strong>pecas</div>
        <div class="csv-stat"><strong>${formatNumber(lot.estoque_insuficiente || 0)}</strong>insuficiente</div>
      </div>
    </div>
  `).join('');
}

function renderAttention() {
  const productItems = products.filter(p => productCategory(p) === 'produto');
  const outItems = productItems.filter(p => getStatus(p).cls === 'out');
  const lowItems = productItems.filter(p => getStatus(p).cls === 'low');
  const withoutMinItems = productItems.filter(p => (Number(p.minimo) || 0) === 0);
  const withoutCodesItems = productItems.filter(p => !p.codigo_referencia && !p.codigo_interno && !p.sku);
  const csvProblems = csvLots.reduce((sum, lot) => sum + (Number(lot.nao_encontrados) || 0) + (Number(lot.estoque_insuficiente) || 0), 0);
  const lastCsv = csvLots[0] ? formatDate(csvLots[0].created_at) : 'Sem importacao';

  attentionLists.productOut = outItems;
  attentionLists.productLow = lowItems;
  attentionLists.productWithoutCodes = withoutCodesItems;
  attentionLists.productWithoutMin = withoutMinItems;

  document.getElementById('attention-grid').innerHTML = `
    <div class="attention-card red">
      <span>Reposicao urgente</span>
      <strong>${formatNumber(outItems.length)}</strong>
      <p>Produtos comuns sem estoque no momento.</p>
      ${attentionButton('productOut', 'Reposicao urgente', outItems.length)}
    </div>
    <div class="attention-card yellow">
      <span>Comprar em breve</span>
      <strong>${formatNumber(lowItems.length)}</strong>
      <p>Produtos comuns abaixo ou no minimo cadastrado.</p>
      ${attentionButton('productLow', 'Produtos para comprar em breve', lowItems.length)}
    </div>
    <div class="attention-card">
      <span>Cadastro incompleto</span>
      <strong>${formatNumber(withoutCodesItems.length)}</strong>
      <p>Produtos sem codigo interno, referencia ou barras.</p>
      ${attentionButton('productWithoutCodes', 'Produtos com cadastro incompleto', withoutCodesItems.length)}
    </div>
    <div class="attention-card">
      <span>Sem minimo</span>
      <strong>${formatNumber(withoutMinItems.length)}</strong>
      <p>Produtos comuns sem alerta minimo configurado.</p>
      ${attentionButton('productWithoutMin', 'Produtos sem minimo configurado', withoutMinItems.length)}
    </div>
    <div class="attention-card yellow">
      <span>CSV com alerta</span>
      <strong>${formatNumber(csvProblems)}</strong>
      <p>Linhas nao encontradas ou com estoque insuficiente nos lotes recentes.</p>
    </div>
    <div class="attention-card green">
      <span>Ultimo fechamento</span>
      <strong>${escapeHtml(lastCsv)}</strong>
      <p>Ultima importacao CSV registrada no sistema.</p>
    </div>
  `;
}

function renderMachineReport() {
  const machineItems = products.filter(p => productCategory(p) !== 'produto');
  const machineSales = getMachineSales();
  const low = machineItems.filter(p => getStatus(p).cls === 'low');
  const out = machineItems.filter(p => getStatus(p).cls === 'out');

  document.getElementById('machine-stat-total').textContent = formatNumber(machineItems.length);
  document.getElementById('machine-stat-units').textContent = formatNumber(machineItems.reduce((sum, p) => sum + totalQty(p), 0));
  document.getElementById('machine-stat-low').textContent = formatNumber(low.length);
  document.getElementById('machine-stat-out').textContent = formatNumber(out.length);
  document.getElementById('machine-stat-sales').textContent = formatNumber(machineSales.reduce((sum, row) => sum + row.qty, 0));

  renderMachinePurchaseSuggestions(machineItems);
  renderTopMachines(machineSales);
  renderMachineSales(machineSales);
  renderMachineAttention(machineItems, machineSales);
}

function getMachineSales() {
  return historyRows
    .filter(row => {
      if (!String(row.tipo || '').startsWith('baixa') || row.tipo === 'baixa_csv_produto') return false;
      const product = findProduct(row.produto_id, row.produtos?.nome);
      return product && productCategory(product) !== 'produto';
    })
    .map(row => ({
      row,
      product: findProduct(row.produto_id, row.produtos?.nome),
      qty: Math.abs((Number(row.quantidade_nova) || 0) - (Number(row.quantidade_anterior) || 0))
    }))
    .filter(item => item.qty > 0);
}

function renderMachinePurchaseSuggestions(machineItems) {
  const rows = machineItems
    .map(product => {
      const qty = totalQty(product);
      const minimo = Number(product.minimo) || 0;
      const voltageIssues = getVoltageIssues(product);
      const generalStatus = getStatus(product);
      const status = voltageIssues.length
        ? { cls: qty === 0 ? 'out' : 'low', label: `${voltageIssues.join(' e ')} sem estoque` }
        : generalStatus;
      return {
        product,
        qty,
        minimo,
        suggested: Math.max(minimo - qty, 0),
        generalStatus,
        status,
        voltageIssues
      };
    })
    .filter(item => item.generalStatus.cls !== 'ok' || item.voltageIssues.length)
    .sort((a, b) => {
      if (a.status.cls !== b.status.cls) return a.status.cls === 'out' ? -1 : 1;
      if (a.voltageIssues.length !== b.voltageIssues.length) return b.voltageIssues.length - a.voltageIssues.length;
      return b.suggested - a.suggested;
    });

  document.getElementById('machine-purchase-count').textContent = `${rows.length} ${rows.length === 1 ? 'item' : 'itens'}`;
  const tbody = document.getElementById('machine-purchase-tbody');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty-state">Nenhuma maquina ou prensa abaixo do minimo.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(({ product, qty, minimo, suggested, status, voltageIssues }) => `
    <tr>
      <td>${productIdentityHTML(product, true)}</td>
      <td>${codesHTML(product)}</td>
      <td>${product.tem_voltagem ? formatNumber(product.quantidade_110v) : '-'}</td>
      <td>${product.tem_voltagem ? formatNumber(product.quantidade_220v) : '-'}</td>
      <td><span class="strong-number">${formatNumber(qty)}</span></td>
      <td>${formatNumber(minimo)}</td>
      <td>${machineSuggestionHTML(suggested, voltageIssues)}</td>
      <td><span class="badge ${status.cls}">${status.label}</span></td>
    </tr>
  `).join('');
}

function machineSuggestionHTML(suggested, voltageIssues) {
  if (!voltageIssues.length) return `<span class="strong-number">${formatNumber(suggested)}</span>`;

  if (voltageIssues.length > 1) {
    return '<span class="voltage-restock">A definir</span><div class="muted">110V e 220V zeradas</div>';
  }

  const voltageText = voltageIssues.join(' e ');
  if (suggested > 0) {
    return `<span class="strong-number">${formatNumber(suggested)}</span><div class="muted">Repor em ${voltageText}</div>`;
  }
  return `<span class="voltage-restock">Repor ${voltageText}</span><div class="muted">Quantidade a definir</div>`;
}

function renderTopMachines(machineSales) {
  const totals = new Map();
  machineSales.forEach(item => addTopProduct(totals, item.product.id, item.product.nome, item.qty));

  const rows = Array.from(totals.values())
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
  const el = document.getElementById('top-machines-list');

  if (!rows.length) {
    el.innerHTML = '<div class="empty-state">Ainda nao ha baixas de maquinas para montar o ranking.</div>';
    return;
  }

  const max = rows[0].total || 1;
  el.innerHTML = rows.map(item => `
    <div class="bar-row">
      <div class="bar-row-top">
        ${rankingIdentityHTML(item)}
        <div class="bar-value">${formatNumber(item.total)}</div>
      </div>
      <div class="bar-track"><div class="bar-fill" style="width:${Math.max(4, Math.round((item.total / max) * 100))}%"></div></div>
    </div>
  `).join('');
}

function renderMachineSales(machineSales) {
  const el = document.getElementById('machine-sales-list');
  if (!machineSales.length) {
    el.innerHTML = '<div class="empty-state">Nenhuma baixa de maquina encontrada.</div>';
    return;
  }

  el.innerHTML = machineSales.slice(0, 8).map(({ row, product, qty }) => {
    const voltage = row.voltagem ? ` - ${escapeHtml(row.voltagem)}` : '';
    const seller = row.vendedor || row.usuario || 'Vendedor';
    return `<div class="sale-card">
      <div class="sale-product">
        ${productPhotoHTML(product, 'small')}
        <div class="sale-product-text">
          <div class="sale-name">${escapeHtml(product.nome)}</div>
          <div class="sale-meta">${escapeHtml(seller)}${voltage} - ${formatDate(row.created_at)}</div>
        </div>
      </div>
      <div class="sale-qty">${formatNumber(qty)}<span>unidades</span></div>
    </div>`;
  }).join('');
}

function renderMachineAttention(machineItems, machineSales) {
  const outItems = machineItems.filter(p => getStatus(p).cls === 'out');
  const lowItems = machineItems.filter(p => getStatus(p).cls === 'low');
  const withoutMinItems = machineItems.filter(p => (Number(p.minimo) || 0) === 0);
  const withoutCodesItems = machineItems.filter(p => !p.codigo_referencia && !p.codigo_interno && !p.sku);
  const voltageOutItems = machineItems.filter(p => getVoltageIssues(p).length > 0);
  const lastSale = machineSales[0] ? formatDate(machineSales[0].row.created_at) : 'Sem baixas';

  attentionLists.machineOut = outItems;
  attentionLists.machineLow = lowItems;
  attentionLists.machineVoltageOut = voltageOutItems;
  attentionLists.machineWithoutCodes = withoutCodesItems;
  attentionLists.machineWithoutMin = withoutMinItems;

  document.getElementById('machine-attention-grid').innerHTML = `
    <div class="attention-card red">
      <span>Reposicao urgente</span>
      <strong>${formatNumber(outItems.length)}</strong>
      <p>Maquinas e prensas sem nenhuma unidade em estoque.</p>
      ${attentionButton('machineOut', 'Maquinas para reposicao urgente', outItems.length)}
    </div>
    <div class="attention-card yellow">
      <span>Comprar em breve</span>
      <strong>${formatNumber(lowItems.length)}</strong>
      <p>Maquinas e prensas abaixo ou no minimo cadastrado.</p>
      ${attentionButton('machineLow', 'Maquinas para comprar em breve', lowItems.length)}
    </div>
    <div class="attention-card yellow">
      <span>Voltagem zerada</span>
      <strong>${formatNumber(voltageOutItems.length)}</strong>
      <p>Maquinas com estoque zerado em 110V ou 220V.</p>
      ${attentionButton('machineVoltageOut', 'Maquinas com voltagem zerada', voltageOutItems.length)}
    </div>
    <div class="attention-card">
      <span>Cadastro incompleto</span>
      <strong>${formatNumber(withoutCodesItems.length)}</strong>
      <p>Maquinas sem codigo interno, referencia ou barras.</p>
      ${attentionButton('machineWithoutCodes', 'Maquinas com cadastro incompleto', withoutCodesItems.length)}
    </div>
    <div class="attention-card">
      <span>Sem minimo</span>
      <strong>${formatNumber(withoutMinItems.length)}</strong>
      <p>Maquinas sem alerta minimo configurado.</p>
      ${attentionButton('machineWithoutMin', 'Maquinas sem minimo configurado', withoutMinItems.length)}
    </div>
    <div class="attention-card green">
      <span>Ultima venda</span>
      <strong>${escapeHtml(lastSale)}</strong>
      <p>Ultima baixa manual de maquina registrada.</p>
    </div>
  `;
}

function attentionButton(key, title, count) {
  if (!count) return '';
  return `<button class="attention-card-action" type="button" onclick="openAttentionModal('${key}', '${title}')">Ver produtos</button>`;
}

function openAttentionModal(key, title) {
  const items = attentionLists[key] || [];
  document.getElementById('attention-modal-title').textContent = title;
  document.getElementById('attention-modal-subtitle').textContent = `${items.length} ${items.length === 1 ? 'item encontrado' : 'itens encontrados'}`;
  document.getElementById('attention-modal-list').innerHTML = items.length
    ? items.map(attentionProductHTML).join('')
    : '<div class="empty-state">Nenhum item encontrado.</div>';
  document.getElementById('attention-modal').classList.add('open');
  document.body.classList.add('modal-open');
}

function attentionProductHTML(product) {
  const qty = totalQty(product);
  const stockDetails = product.tem_voltagem
    ? `<div class="modal-stock-item"><span>110V</span><strong>${formatNumber(product.quantidade_110v)}</strong></div>
       <div class="modal-stock-item"><span>220V</span><strong>${formatNumber(product.quantidade_220v)}</strong></div>`
    : '';

  return `<div class="modal-product">
    <div class="modal-product-identity">
      ${productPhotoHTML(product)}
      <div>
        <div class="modal-product-name">${escapeHtml(product.nome)}</div>
        <div class="modal-product-codes">${plainCodes(product)}</div>
      </div>
    </div>
    <div class="modal-product-stock">
      ${stockDetails}
      <div class="modal-stock-item"><span>Atual</span><strong>${formatNumber(qty)}</strong></div>
      <div class="modal-stock-item"><span>Minimo</span><strong>${formatNumber(product.minimo)}</strong></div>
    </div>
  </div>`;
}

function plainCodes(product) {
  const codes = [
    product.codigo_interno ? `Int: ${product.codigo_interno}` : '',
    product.codigo_referencia ? `Ref: ${product.codigo_referencia}` : '',
    product.sku ? `Barras: ${product.sku}` : ''
  ].filter(Boolean);
  return codes.length ? escapeHtml(codes.join(' - ')) : 'Sem codigos cadastrados';
}

function productIdentityHTML(product, showNotes = false) {
  const notes = showNotes && product.observacoes
    ? `<div class="muted product-notes">${escapeHtml(product.observacoes)}</div>`
    : '';

  return `<div class="product-identity">
    ${productPhotoHTML(product)}
    <div class="product-identity-text">
      <strong>${escapeHtml(product.nome)}</strong>
      ${notes}
    </div>
  </div>`;
}

function rankingIdentityHTML(item) {
  const product = findProduct(item.id, item.name);
  return `<div class="bar-product">
    ${product ? productPhotoHTML(product, 'small') : ''}
    <div class="bar-name">${escapeHtml(item.name)}</div>
  </div>`;
}

function productPhotoHTML(product, size = '') {
  const name = String(product.nome || 'Produto').trim();
  const initial = escapeHtml(name.charAt(0).toUpperCase() || '?');
  const sizeClass = size ? ` ${size}` : '';

  if (!product.imagem_url) {
    return `<div class="product-thumb${sizeClass}"><span class="product-thumb-fallback visible">${initial}</span></div>`;
  }

  return `<div class="product-thumb${sizeClass}">
    <img src="${escapeHtml(product.imagem_url)}" alt="" loading="lazy" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
    <span class="product-thumb-fallback">${initial}</span>
  </div>`;
}

function closeAttentionModal() {
  document.getElementById('attention-modal').classList.remove('open');
  document.body.classList.remove('modal-open');
}

function closeAttentionModalOnOverlay(event) {
  if (event.target === event.currentTarget) closeAttentionModal();
}

document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeAttentionModal();
});

function codesHTML(product) {
  const codes = [
    product.codigo_interno ? `Int: ${product.codigo_interno}` : '',
    product.codigo_referencia ? `Ref: ${product.codigo_referencia}` : '',
    product.sku ? `Barras: ${product.sku}` : ''
  ].filter(Boolean);

  if (!codes.length) return '<span class="muted">Sem codigos</span>';
  return `<div class="code-tags">${codes.map(code => `<span class="code-tag">${escapeHtml(code)}</span>`).join('')}</div>`;
}

function findProduct(id, name) {
  if (id) {
    const byId = products.find(p => p.id === id);
    if (byId) return byId;
  }
  const normalized = normalizeText(name || '');
  return products.find(p => normalizeText(p.nome) === normalized);
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString('pt-BR');
}

function formatDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

checkSession();
