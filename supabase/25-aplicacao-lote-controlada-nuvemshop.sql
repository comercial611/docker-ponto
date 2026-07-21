begin;

create or replace function public.validar_janela_antes_aplicacao_nuvemshop()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_conexao public.nuvemshop_conexoes%rowtype;
begin
  if new.modo <> 'aplicacao' then
    return new;
  end if;

  select c.*
    into v_conexao
  from public.nuvemshop_conexoes c
  where c.store_id = new.store_id
  for update;

  if not found
     or not v_conexao.escrita_habilitada
     or v_conexao.escrita_habilitada_ate is null
     or v_conexao.escrita_habilitada_ate <= clock_timestamp()
     or v_conexao.limite_aplicacao not between 1 and 5
     or new.total_itens is distinct from v_conexao.limite_aplicacao
     or new.origem_simulacao_id is distinct from v_conexao.escrita_simulacao_id
     or new.solicitado_por is distinct from v_conexao.escrita_habilitada_por then
    raise exception 'A janela temporaria de escrita esta fechada, expirada ou com limite divergente.'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace function public.configurar_janela_lote_nuvemshop(
  p_store_id bigint,
  p_simulacao_id uuid,
  p_solicitado_por uuid,
  p_habilitar boolean,
  p_limite integer default null,
  p_confirmacao text default null
)
returns timestamp with time zone
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_habilitada_ate timestamp with time zone;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A janela do lote so pode ser configurada pelo servidor.'
      using errcode = '42501';
  end if;

  if not p_habilitar then
    perform public.configurar_janela_piloto_nuvemshop(
      p_store_id,
      p_simulacao_id,
      p_solicitado_por,
      false,
      null
    );

    update public.nuvemshop_conexoes
    set limite_aplicacao = 1
    where store_id = p_store_id;

    return null;
  end if;

  if p_limite not between 2 and 5 then
    raise exception 'O lote controlado deve conter de dois a cinco itens.';
  end if;

  if p_confirmacao is distinct from (
    'LIBERAR LOTE DE ' || p_limite::text || ' ITENS POR 5 MINUTOS'
  ) then
    raise exception 'Confirmacao da janela do lote invalida.';
  end if;

  update public.nuvemshop_conexoes
  set limite_aplicacao = 1
  where store_id = p_store_id
    and not (
      escrita_habilitada
      and escrita_habilitada_ate > clock_timestamp()
    );

  select public.configurar_janela_piloto_nuvemshop(
    p_store_id,
    p_simulacao_id,
    p_solicitado_por,
    true,
    'LIBERAR PILOTO POR 5 MINUTOS'
  )
  into v_habilitada_ate;

  update public.nuvemshop_conexoes
  set limite_aplicacao = p_limite
  where store_id = p_store_id;

  return v_habilitada_ate;
end;
$$;

create or replace function public.iniciar_aplicacao_lote_nuvemshop(
  p_chave_operacao uuid,
  p_simulacao_id uuid,
  p_itens_simulacao_ids bigint[],
  p_store_id bigint,
  p_solicitado_por uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_aplicacao_id uuid;
  v_conexao public.nuvemshop_conexoes%rowtype;
  v_simulacao public.nuvemshop_sincronizacoes%rowtype;
  v_item public.nuvemshop_sincronizacao_itens%rowtype;
  v_item_id bigint;
  v_total integer;
  v_total_distinto integer;
  v_estoque_local integer;
  v_estoque_destino integer;
  v_unidades_por_venda integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A aplicacao em lote so pode ser iniciada pelo servidor.'
      using errcode = '42501';
  end if;

  v_total := coalesce(cardinality(p_itens_simulacao_ids), 0);
  select count(distinct selected.item_id)
    into v_total_distinto
  from unnest(
    coalesce(p_itens_simulacao_ids, array[]::bigint[])
  ) as selected(item_id);

  if p_chave_operacao is null
     or p_simulacao_id is null
     or p_store_id is null
     or p_solicitado_por is null
     or v_total not between 2 and 5
     or v_total_distinto <> v_total then
    raise exception 'O lote exige de dois a cinco itens distintos.';
  end if;

  select c.*
    into v_conexao
  from public.nuvemshop_conexoes c
  where c.store_id = p_store_id
  for update;

  if not found
     or not v_conexao.escrita_habilitada
     or v_conexao.escrita_habilitada_ate is null
     or v_conexao.escrita_habilitada_ate <= clock_timestamp()
     or v_conexao.escrita_simulacao_id is distinct from p_simulacao_id
     or v_conexao.escrita_habilitada_por is distinct from p_solicitado_por
     or v_conexao.limite_aplicacao is distinct from v_total then
    raise exception 'A janela do lote esta fechada, expirada ou com limite divergente.'
      using errcode = '42501';
  end if;

  if nullif(btrim(v_conexao.local_estoque_id), '') is null
     or not exists (
       select 1
       from regexp_split_to_table(
         coalesce(v_conexao.escopos, ''),
         '[[:space:],]+'
       ) as escopo(valor)
       where lower(escopo.valor) = 'write_products'
     ) then
    raise exception 'A conexao nao possui local confirmado ou permissao de escrita.'
      using errcode = '42501';
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

  select s.*
    into v_simulacao
  from public.nuvemshop_sincronizacoes s
  where s.id = p_simulacao_id
  for update;

  if not found
     or v_simulacao.modo <> 'simulacao'
     or v_simulacao.status <> 'concluida'
     or v_simulacao.itens_sucesso <> v_simulacao.total_itens
     or v_simulacao.itens_falha <> 0
     or v_simulacao.store_id <> p_store_id
     or v_simulacao.solicitado_por <> p_solicitado_por
     or v_simulacao.local_estoque_id is distinct from v_conexao.local_estoque_id
     or v_simulacao.created_at < now() - interval '15 minutes'
     or v_simulacao.created_at > now() + interval '1 minute' then
    raise exception 'A simulacao nao atende aos requisitos do lote.';
  end if;

  if exists (
    select 1
    from public.nuvemshop_sincronizacoes s
    where s.modo = 'aplicacao'
      and (
        s.origem_simulacao_id = p_simulacao_id
        or (
          s.store_id = p_store_id
          and s.status in ('preparando', 'processando')
        )
      )
  ) then
    raise exception 'A simulacao ja foi aplicada ou existe outra aplicacao em andamento.';
  end if;

  foreach v_item_id in array p_itens_simulacao_ids loop
    select i.*
      into v_item
    from public.nuvemshop_sincronizacao_itens i
    where i.id = v_item_id
      and i.sincronizacao_id = p_simulacao_id
    for update;

    if not found
       or v_item.status <> 'concluido'
       or v_item.resultado_previsto <> 'alteraria'
       or v_item.vinculo_id is null
       or v_item.estoque_anterior is null
       or v_item.estoque_destino is null then
      raise exception 'Um dos itens selecionados nao esta apto para aplicacao.';
    end if;

    select v.unidades_por_venda
      into v_unidades_por_venda
    from public.nuvemshop_vinculos v
    where v.id = v_item.vinculo_id
      and v.store_id = p_store_id
      and v.ativo
      and v.produto_id = v_item.produto_id
      and v.voltagem is not distinct from v_item.voltagem
      and v.nuvemshop_produto_id = v_item.nuvemshop_produto_id
      and v.nuvemshop_variante_id is not distinct from v_item.nuvemshop_variante_id;

    if not found
       or v_unidades_por_venda is null
       or v_unidades_por_venda < 1
       or v_unidades_por_venda is distinct from v_item.unidades_por_venda then
      raise exception 'Um vinculo mudou desde a simulacao.';
    end if;

    select case v_item.voltagem
      when '110V' then p.quantidade_110v
      when '220V' then p.quantidade_220v
      else p.quantidade
    end
      into v_estoque_local
    from public.produtos p
    where p.id = v_item.produto_id;

    v_estoque_destino := floor(
      v_estoque_local::numeric / v_unidades_por_venda
    )::integer;

    if v_estoque_local is null
       or v_estoque_local < 0
       or v_estoque_local is distinct from v_item.estoque_local_base
       or v_estoque_destino is distinct from v_item.estoque_destino
       or exists (
         select 1
         from public.nuvemshop_sincronizacao_itens i
         where i.origem_item_id = v_item_id
       ) then
      raise exception 'Um item mudou desde a simulacao. Gere uma nova previa.';
    end if;
  end loop;

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
    origem_simulacao_id
  ) values (
    p_chave_operacao,
    p_store_id,
    v_conexao.local_estoque_id,
    'aplicacao',
    'processando',
    p_solicitado_por,
    v_total,
    0,
    0,
    p_simulacao_id
  )
  returning id into v_aplicacao_id;

  insert into public.nuvemshop_sincronizacao_itens (
    sincronizacao_id,
    vinculo_id,
    produto_id,
    voltagem,
    nuvemshop_produto_id,
    nuvemshop_variante_id,
    unidades_por_venda,
    estoque_local_base,
    estoque_anterior,
    estoque_destino,
    resultado_previsto,
    diferenca,
    status,
    origem_item_id
  )
  select
    v_aplicacao_id,
    i.vinculo_id,
    i.produto_id,
    i.voltagem,
    i.nuvemshop_produto_id,
    i.nuvemshop_variante_id,
    i.unidades_por_venda,
    i.estoque_local_base,
    i.estoque_anterior,
    i.estoque_destino,
    'alteraria',
    i.diferenca,
    'pendente',
    i.id
  from public.nuvemshop_sincronizacao_itens i
  join unnest(p_itens_simulacao_ids) with ordinality selected(id, ordem)
    on selected.id = i.id
  order by selected.ordem;

  return v_aplicacao_id;
exception
  when unique_violation then
    raise exception 'A operacao, simulacao ou item ja possui reserva de aplicacao.';
end;
$$;

create or replace function public.finalizar_item_aplicacao_lote_nuvemshop(
  p_aplicacao_id uuid,
  p_item_aplicacao_id bigint,
  p_resultado text,
  p_estoque_confirmado integer,
  p_erro text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_aplicacao public.nuvemshop_sincronizacoes%rowtype;
  v_item public.nuvemshop_sincronizacao_itens%rowtype;
  v_sucesso integer;
  v_falha integer;
  v_pendente integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A finalizacao do lote so pode ser feita pelo servidor.'
      using errcode = '42501';
  end if;

  if p_resultado not in ('concluido', 'falhou')
     or (p_resultado = 'falhou' and nullif(btrim(p_erro), '') is null) then
    raise exception 'Resultado do item do lote invalido.';
  end if;

  select s.*
    into v_aplicacao
  from public.nuvemshop_sincronizacoes s
  where s.id = p_aplicacao_id
  for update;

  if not found
     or v_aplicacao.modo <> 'aplicacao'
     or v_aplicacao.total_itens not between 2 and 5
     or v_aplicacao.status <> 'processando' then
    raise exception 'Aplicacao em lote nao esta em processamento.';
  end if;

  select i.*
    into v_item
  from public.nuvemshop_sincronizacao_itens i
  where i.id = p_item_aplicacao_id
    and i.sincronizacao_id = p_aplicacao_id
  for update;

  if not found or v_item.status not in ('pendente', 'processando') then
    raise exception 'Item do lote nao esta disponivel para finalizacao.';
  end if;

  if p_resultado = 'concluido'
     and p_estoque_confirmado is distinct from v_item.estoque_destino then
    raise exception 'Estoque confirmado difere do destino reservado.';
  end if;

  update public.nuvemshop_sincronizacao_itens
  set status = p_resultado,
      estoque_confirmado = p_estoque_confirmado,
      erro = case when p_resultado = 'falhou' then btrim(p_erro) else null end,
      processado_em = now()
  where id = p_item_aplicacao_id;

  select
    count(*) filter (where status = 'concluido'),
    count(*) filter (where status in ('falhou', 'ignorado')),
    count(*) filter (where status in ('pendente', 'processando'))
  into v_sucesso, v_falha, v_pendente
  from public.nuvemshop_sincronizacao_itens
  where sincronizacao_id = p_aplicacao_id;

  update public.nuvemshop_sincronizacoes
  set itens_sucesso = v_sucesso,
      itens_falha = v_falha
  where id = p_aplicacao_id;

  if v_pendente = 0 then
    update public.nuvemshop_sincronizacoes
    set status = case
          when v_falha = 0 then 'concluida'
          when v_sucesso = 0 then 'falhou'
          else 'parcial'
        end,
        erro = case
          when v_falha = 0 then null
          else 'O lote foi interrompido ou possui item nao confirmado.'
        end,
        concluido_em = now()
    where id = p_aplicacao_id;
  end if;
end;
$$;

create or replace function public.interromper_aplicacao_lote_nuvemshop(
  p_aplicacao_id uuid,
  p_motivo text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sucesso integer;
  v_falha integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A interrupcao do lote so pode ser feita pelo servidor.'
      using errcode = '42501';
  end if;

  if nullif(btrim(p_motivo), '') is null then
    raise exception 'Informe o motivo da interrupcao.';
  end if;

  perform 1
  from public.nuvemshop_sincronizacoes
  where id = p_aplicacao_id
    and modo = 'aplicacao'
    and total_itens between 2 and 5
    and status = 'processando'
  for update;

  if not found then
    raise exception 'Aplicacao em lote nao esta em processamento.';
  end if;

  update public.nuvemshop_sincronizacao_itens
  set status = 'ignorado',
      erro = btrim(p_motivo),
      processado_em = now()
  where sincronizacao_id = p_aplicacao_id
    and status in ('pendente', 'processando');

  select
    count(*) filter (where status = 'concluido'),
    count(*) filter (where status in ('falhou', 'ignorado'))
  into v_sucesso, v_falha
  from public.nuvemshop_sincronizacao_itens
  where sincronizacao_id = p_aplicacao_id;

  update public.nuvemshop_sincronizacoes
  set status = case when v_sucesso = 0 then 'falhou' else 'parcial' end,
      itens_sucesso = v_sucesso,
      itens_falha = v_falha,
      erro = btrim(p_motivo),
      concluido_em = now()
  where id = p_aplicacao_id;
end;
$$;

revoke all on function public.configurar_janela_lote_nuvemshop(
  bigint, uuid, uuid, boolean, integer, text
) from public, anon, authenticated;
grant execute on function public.configurar_janela_lote_nuvemshop(
  bigint, uuid, uuid, boolean, integer, text
) to service_role;

revoke all on function public.iniciar_aplicacao_lote_nuvemshop(
  uuid, uuid, bigint[], bigint, uuid
) from public, anon, authenticated;
grant execute on function public.iniciar_aplicacao_lote_nuvemshop(
  uuid, uuid, bigint[], bigint, uuid
) to service_role;

revoke all on function public.finalizar_item_aplicacao_lote_nuvemshop(
  uuid, bigint, text, integer, text
) from public, anon, authenticated;
grant execute on function public.finalizar_item_aplicacao_lote_nuvemshop(
  uuid, bigint, text, integer, text
) to service_role;

revoke all on function public.interromper_aplicacao_lote_nuvemshop(
  uuid, text
) from public, anon, authenticated;
grant execute on function public.interromper_aplicacao_lote_nuvemshop(
  uuid, text
) to service_role;

revoke all on function public.validar_janela_antes_aplicacao_nuvemshop()
from public, anon, authenticated;

notify pgrst, 'reload schema';

commit;

select
  p.proname as funcao,
  pg_get_function_identity_arguments(p.oid) as argumentos
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'configurar_janela_lote_nuvemshop',
    'iniciar_aplicacao_lote_nuvemshop',
    'finalizar_item_aplicacao_lote_nuvemshop',
    'interromper_aplicacao_lote_nuvemshop'
  )
order by p.proname;
