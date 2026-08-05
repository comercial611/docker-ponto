function normalizeProductSearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .trim();
}

function productSearchFields(product) {
  const tags = Array.isArray(product?.tags) ? product.tags : [];
  return [
    product?.nome,
    ...tags,
    product?.codigo_fabricante,
    product?.codigo_interno,
    product?.codigo_referencia,
    product?.codigo_barras,
    product?.sku,
    product?.codigo_fabricante_110v,
    product?.codigo_fabricante_220v,
    product?.codigo_interno_110v,
    product?.codigo_interno_220v,
    product?.codigo_referencia_110v,
    product?.codigo_referencia_220v,
    product?.codigo_barras_110v,
    product?.codigo_barras_220v
  ].filter(value => value != null && String(value).trim() !== '');
}

function productSearchText(product) {
  return productSearchFields(product).map(normalizeProductSearch).join(' ');
}

function productMatchesSearch(product, query) {
  const normalizedQuery = normalizeProductSearch(query);
  return !normalizedQuery || productSearchText(product).includes(normalizedQuery);
}
