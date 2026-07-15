begin;

alter table public.baixas_csv_lotes
  add column if not exists data_movimento date,
  add column if not exists arquivo_hash text;

create unique index if not exists baixas_csv_lotes_movimento_hash_uidx
on public.baixas_csv_lotes (data_movimento, arquivo_hash)
where data_movimento is not null
  and arquivo_hash is not null;

create or replace function public.registrar_fechamento_csv_produtos(
  p_itens jsonb,
  p_arquivo_nome text,
  p_resumo jsonb,
  p_arquivo_hash text,
  p_data_movimento date
)
returns table (
  lote_id bigint,
  produto_id integer,
  produto_nome text,
  quantidade_anterior integer,
  quantidade_nova integer,
  quantidade_baixada integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hash text := lower(trim(coalesce(p_arquivo_hash, '')));
  v_lote_id bigint;
  v_result record;
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  if not public.eh_admin() then
    raise exception 'Somente admin pode aplicar fechamento por CSV.';
  end if;

  if p_data_movimento is null then
    raise exception 'Informe a data do movimento.';
  end if;

  if p_data_movimento > current_date then
    raise exception 'A data do movimento nao pode estar no futuro.';
  end if;

  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Identificacao do arquivo CSV invalida.';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(p_data_movimento::text || ':' || v_hash, 0)
  );

  if exists (
    select 1
    from public.baixas_csv_lotes
    where data_movimento = p_data_movimento
      and arquivo_hash = v_hash
  ) then
    raise exception 'Este arquivo CSV ja foi aplicado no fechamento de %.',
      to_char(p_data_movimento, 'DD/MM/YYYY');
  end if;

  for v_result in
    select *
    from public.registrar_baixa_csv_produtos(
      p_itens,
      p_arquivo_nome,
      coalesce(p_resumo, '{}'::jsonb)
    )
  loop
    if v_lote_id is null then
      v_lote_id := v_result.lote_id;
    end if;

    lote_id := v_result.lote_id;
    produto_id := v_result.produto_id;
    produto_nome := v_result.produto_nome;
    quantidade_anterior := v_result.quantidade_anterior;
    quantidade_nova := v_result.quantidade_nova;
    quantidade_baixada := v_result.quantidade_baixada;
    return next;
  end loop;

  if v_lote_id is null then
    raise exception 'Nenhum produto aplicado no fechamento.';
  end if;

  update public.baixas_csv_lotes
  set
    data_movimento = p_data_movimento,
    arquivo_hash = v_hash
  where id = v_lote_id;
end;
$$;

revoke all on function public.registrar_fechamento_csv_produtos(jsonb, text, jsonb, text, date) from public;
grant execute on function public.registrar_fechamento_csv_produtos(jsonb, text, jsonb, text, date) to authenticated;

notify pgrst, 'reload schema';

commit;
