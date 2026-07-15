begin;

alter table public.produtos
  add column if not exists codigo_fabricante_110v text,
  add column if not exists codigo_fabricante_220v text,
  add column if not exists codigo_interno_110v text,
  add column if not exists codigo_interno_220v text,
  add column if not exists codigo_referencia_110v text,
  add column if not exists codigo_referencia_220v text,
  add column if not exists codigo_barras_110v text,
  add column if not exists codigo_barras_220v text;

comment on column public.produtos.codigo_fabricante_110v is 'Codigo do fabricante da variacao 110V.';
comment on column public.produtos.codigo_fabricante_220v is 'Codigo do fabricante da variacao 220V.';
comment on column public.produtos.codigo_interno_110v is 'Codigo interno da variacao 110V.';
comment on column public.produtos.codigo_interno_220v is 'Codigo interno da variacao 220V.';
comment on column public.produtos.codigo_referencia_110v is 'Codigo de referencia da variacao 110V.';
comment on column public.produtos.codigo_referencia_220v is 'Codigo de referencia da variacao 220V.';
comment on column public.produtos.codigo_barras_110v is 'Codigo de barras da variacao 110V.';
comment on column public.produtos.codigo_barras_220v is 'Codigo de barras da variacao 220V.';

notify pgrst, 'reload schema';

commit;

select
  id,
  nome,
  codigo_interno_110v,
  codigo_interno_220v,
  codigo_referencia_110v,
  codigo_referencia_220v
from public.produtos
where tem_voltagem
order by nome;
