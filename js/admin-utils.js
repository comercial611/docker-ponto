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

function validUnitsPerSale(value) {
  const units = Number(value);
  return Number.isInteger(units) && units >= 1 && units <= 10000 ? units : null;
}

function inferUnitsPerSale(row) {
  const texts = [row?.variantLabel, row?.remoteName]
    .map(value => String(value || '').trim())
    .filter(Boolean);
  for (const text of texts) {
    const explicitUnits = text.match(/(?:^|\D)(\d{1,5})\s*(?:unidade|unidades|un|und)(?:\D|$)/i);
    const parsed = validUnitsPerSale(explicitUnits?.[1]);
    if (parsed) return { value: parsed, source: 'nome da oferta' };
  }

  const skuSuffix = String(row?.sku || '').trim().match(/[-_/](\d{1,5})$/);
  const parsedSuffix = validUnitsPerSale(skuSuffix?.[1]);
  if (parsedSuffix) return { value: parsedSuffix, source: 'final do SKU' };

  return { value: 1, source: 'padrao seguro' };
}

function packageDestinationStock(localStock, unitsPerSale) {
  const stock = Number(localStock);
  const units = validUnitsPerSale(unitsPerSale);
  if (!Number.isInteger(stock) || stock < 0 || !units) return null;
  return Math.floor(stock / units);
}
