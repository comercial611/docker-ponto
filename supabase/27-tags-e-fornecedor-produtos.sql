begin;

alter table public.produtos
  add column if not exists tags text[] not null default '{}'::text[],
  add column if not exists fornecedor_status text not null default 'normal',
  add column if not exists fornecedor_observacao text;

alter table public.produtos
  drop constraint if exists produtos_tags_max_10_check,
  add constraint produtos_tags_max_10_check
    check (cardinality(tags) <= 10),
  drop constraint if exists produtos_tags_sem_html_check,
  add constraint produtos_tags_sem_html_check
    check (array_to_string(tags, E'\x1F') !~ '[<>]'),
  drop constraint if exists produtos_fornecedor_status_check,
  add constraint produtos_fornecedor_status_check
    check (fornecedor_status in ('normal', 'atencao', 'em_falta')),
  drop constraint if exists produtos_fornecedor_observacao_check,
  add constraint produtos_fornecedor_observacao_check
    check (
      fornecedor_status = 'normal'
      or nullif(btrim(fornecedor_observacao), '') is not null
    );

create index if not exists produtos_tags_gin_idx
  on public.produtos using gin (tags);

comment on column public.produtos.tags is 'Tags livres de busca do produto, limitadas a dez por produto.';
comment on column public.produtos.fornecedor_status is 'Situacao do fornecedor: normal, atencao ou em_falta.';
comment on column public.produtos.fornecedor_observacao is 'Observacao vinculada a situacao do fornecedor.';

notify pgrst, 'reload schema';

commit;
