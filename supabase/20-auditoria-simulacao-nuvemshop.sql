begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

alter table public.nuvemshop_sincronizacoes
  add column if not exists modo text not null default 'aplicacao';

alter table public.nuvemshop_sincronizacao_itens
  add column if not exists resultado_previsto text,
  add column if not exists diferenca integer;

-- Uma falha de validacao pode nao ter estoque de destino calculavel.
alter table public.nuvemshop_sincronizacao_itens
  alter column estoque_destino drop not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_sincronizacoes_modo_check'
      and conrelid = 'public.nuvemshop_sincronizacoes'::regclass
  ) then
    alter table public.nuvemshop_sincronizacoes
      add constraint nuvemshop_sincronizacoes_modo_check
      check (modo in ('simulacao', 'aplicacao'));
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_sincronizacao_itens_resultado_check'
      and conrelid = 'public.nuvemshop_sincronizacao_itens'::regclass
  ) then
    alter table public.nuvemshop_sincronizacao_itens
      add constraint nuvemshop_sincronizacao_itens_resultado_check
      check (
        resultado_previsto is null
        or resultado_previsto in ('igual', 'alteraria', 'sem_controle', 'erro')
      );
  end if;
end;
$$;

create or replace function public.registrar_auditoria_simulacao_nuvemshop(
  p_chave_operacao uuid,
  p_store_id bigint,
  p_local_estoque_id text,
  p_solicitado_por uuid,
  p_itens jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sincronizacao_id uuid;
  v_total integer;
  v_falhas integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A auditoria so pode ser registrada pelo servidor.'
      using errcode = '42501';
  end if;

  if p_chave_operacao is null then
    raise exception 'Chave da operacao obrigatoria.';
  end if;

  if not exists (
    select 1
    from public.nuvemshop_conexoes c
    where c.store_id = p_store_id
      and c.local_estoque_id = p_local_estoque_id
  ) then
    raise exception 'Loja ou local de estoque nao confirmado.';
  end if;

  if not exists (
    select 1
    from public.perfis p
    where p.user_id = p_solicitado_por
      and p.tipo = 'admin'
  ) then
    raise exception 'Solicitante nao e administrador.'
      using errcode = '42501';
  end if;

  if p_itens is null or jsonb_typeof(p_itens) <> 'array' then
    raise exception 'Itens da auditoria em formato invalido.';
  end if;

  v_total := jsonb_array_length(p_itens);
  if v_total < 1 or v_total > 500 then
    raise exception 'Quantidade de itens fora do limite de seguranca: %.', v_total;
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_itens) as item(
      vinculo_id bigint,
      produto_id integer,
      voltagem text,
      nuvemshop_produto_id bigint,
      nuvemshop_variante_id bigint,
      estoque_atual integer,
      estoque_destino integer,
      diferenca integer,
      status text,
      erro text
    )
    where item.vinculo_id is null
       or item.produto_id is null
       or item.nuvemshop_produto_id is null
       or item.status is null
       or item.status not in ('igual', 'alteraria', 'sem_controle', 'erro')
       or not exists (
         select 1
         from public.nuvemshop_vinculos v
         where v.id = item.vinculo_id
           and v.store_id = p_store_id
           and v.ativo
           and v.produto_id = item.produto_id
           and v.nuvemshop_produto_id = item.nuvemshop_produto_id
           and v.nuvemshop_variante_id is not distinct from item.nuvemshop_variante_id
           and v.voltagem is not distinct from item.voltagem
       )
       or (
         item.status = 'igual'
         and (
           item.estoque_atual is null
           or item.estoque_destino is null
           or item.estoque_atual <> item.estoque_destino
           or item.diferenca is distinct from 0
         )
       )
       or (
         item.status = 'alteraria'
         and (
           item.estoque_atual is null
           or item.estoque_destino is null
           or item.estoque_atual = item.estoque_destino
           or item.diferenca is distinct from (item.estoque_destino - item.estoque_atual)
         )
       )
       or (
         item.status = 'sem_controle'
         and (item.estoque_atual is not null or item.estoque_destino is null)
       )
       or (
         item.status = 'erro'
         and nullif(btrim(item.erro), '') is null
       )
  ) then
    raise exception 'Existe item incompleto ou com resultado invalido.';
  end if;

  select count(*)
    into v_falhas
  from jsonb_to_recordset(p_itens) as item(status text)
  where item.status = 'erro';

  insert into public.nuvemshop_sincronizacoes (
    chave_operacao,
    store_id,
    local_estoque_id,
    modo,
    status,
    solicitado_por,
    total_itens,
    itens_sucesso,
    itens_falha,
    concluido_em
  ) values (
    p_chave_operacao,
    p_store_id,
    p_local_estoque_id,
    'simulacao',
    case
      when v_falhas = 0 then 'concluida'
      when v_falhas = v_total then 'falhou'
      else 'parcial'
    end,
    p_solicitado_por,
    v_total,
    v_total - v_falhas,
    v_falhas,
    now()
  )
  returning id into v_sincronizacao_id;

  insert into public.nuvemshop_sincronizacao_itens (
    sincronizacao_id,
    vinculo_id,
    produto_id,
    voltagem,
    nuvemshop_produto_id,
    nuvemshop_variante_id,
    estoque_anterior,
    estoque_destino,
    resultado_previsto,
    diferenca,
    status,
    erro,
    processado_em
  )
  select
    v_sincronizacao_id,
    item.vinculo_id,
    item.produto_id,
    item.voltagem,
    item.nuvemshop_produto_id,
    item.nuvemshop_variante_id,
    case when item.estoque_atual >= 0 then item.estoque_atual else null end,
    case when item.estoque_destino >= 0 then item.estoque_destino else null end,
    item.status,
    item.diferenca,
    case
      when item.status in ('igual', 'alteraria') then 'concluido'
      when item.status = 'sem_controle' then 'ignorado'
      else 'falhou'
    end,
    item.erro,
    now()
  from jsonb_to_recordset(p_itens) as item(
    vinculo_id bigint,
    produto_id integer,
    voltagem text,
    nuvemshop_produto_id bigint,
    nuvemshop_variante_id bigint,
    estoque_atual integer,
    estoque_destino integer,
    diferenca integer,
    status text,
    erro text
  );

  return v_sincronizacao_id;
end;
$$;

revoke all on function public.registrar_auditoria_simulacao_nuvemshop(
  uuid, bigint, text, uuid, jsonb
) from public, anon, authenticated;

grant execute on function public.registrar_auditoria_simulacao_nuvemshop(
  uuid, bigint, text, uuid, jsonb
) to service_role;

notify pgrst, 'reload schema';

commit;

select
  modo,
  status,
  count(*) as total
from public.nuvemshop_sincronizacoes
group by modo, status
order by modo, status;
