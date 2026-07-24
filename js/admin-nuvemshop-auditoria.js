let nuvemshopAuditRows = [];
let nuvemshopAuditLoaded = false;
let nuvemshopAuditUser = null;
let nuvemshopAuditPage = 1;
let nuvemshopAuditPageSize = 10;
let nuvemshopAuditTotal = 0;
let nuvemshopAuditSearchTimer = null;
const nuvemshopExpandedAudits = new Set();

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
      const pageSize = 1000;
      let itemPage = 0;
      while (true) {
        const fromItem = itemPage * pageSize;
        const itemsResult = await sb.from('nuvemshop_sincronizacao_itens')
          .select('id, sincronizacao_id, produto_id, voltagem, nuvemshop_produto_id, nuvemshop_variante_id, unidades_por_venda, estoque_local_base, estoque_anterior, estoque_destino, resultado_previsto, diferenca, status, erro, processado_em')
          .in('sincronizacao_id', historyIds)
          .order('id', { ascending: true })
          .range(fromItem, fromItem + pageSize - 1);
        if (itemsResult.error) throw itemsResult.error;

        const pageItems = itemsResult.data || [];
        items.push(...pageItems);
        if (pageItems.length < pageSize) break;
        itemPage += 1;
      }
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
      <thead><tr><th>Produto local</th><th>Voltagem</th><th>Regra</th><th>Estoque anterior</th><th>Destino previsto</th><th>Diferenca</th><th>Resultado</th></tr></thead>
      <tbody>${visibleItems.map(item => {
        const product = products.find(candidate => candidate.id === item.produto_id);
        const productName = product?.nome || `Produto #${item.produto_id}`;
        const difference = item.diferenca == null ? '-' : `${item.diferenca > 0 ? '+' : ''}${item.diferenca}`;
        const resultClass = item.resultado_previsto || 'erro';
        return `<tr>
          <td><strong>${escapeHtml(productName)}</strong><div class="nuvemshop-local-meta">ID ${escapeHtml(item.produto_id)}</div></td>
          <td>${escapeHtml(item.voltagem || 'Unica')}</td>
          <td><strong>${escapeHtml(item.unidades_por_venda || 1)} un./venda</strong><div class="nuvemshop-local-meta">Base fisica ${escapeHtml(item.estoque_local_base ?? '-')}</div></td>
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
