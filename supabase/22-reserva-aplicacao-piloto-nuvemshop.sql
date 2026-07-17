begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

alter table public.nuvemshop_sincronizacoes
  add column if not exists origem_simulacao_id uuid;

alter table public.nuvemshop_sincronizacao_itens
  add column if not exists origem_item_id bigint,
  add column if not exists estoque_confirmado integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_sincronizacoes_origem_simulacao_fkey'
      and conrelid = 'public.nuvemshop_sincronizacoes'::regclass
  ) then
    alter table public.nuvemshop_sincronizacoes
      add constraint nuvemshop_sincronizacoes_origem_simulacao_fkey
      foreign key (origem_simulacao_id)
      references public.nuvemshop_sincronizacoes(id)
      on delete restrict;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_sincronizacoes_origem_diferente_check'
      and conrelid = 'public.nuvemshop_sincronizacoes'::regclass
  ) then
    alter table public.nuvemshop_sincronizacoes
      add constraint nuvemshop_sincronizacoes_origem_diferente_check
      check (origem_simulacao_id is null or origem_simulacao_id <> id);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_sincronizacao_itens_origem_item_fkey'
      and conrelid = 'public.nuvemshop_sincronizacao_itens'::regclass
  ) then
    alter table public.nuvemshop_sincronizacao_itens
      add constraint nuvemshop_sincronizacao_itens_origem_item_fkey
      foreign key (origem_item_id)
      references public.nuvemshop_sincronizacao_itens(id)
      on delete restrict;
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_sincronizacao_itens_origem_diferente_check'
      and conrelid = 'public.nuvemshop_sincronizacao_itens'::regclass
  ) then
    alter table public.nuvemshop_sincronizacao_itens
      add constraint nuvemshop_sincronizacao_itens_origem_diferente_check
      check (origem_item_id is null or origem_item_id <> id);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_sincronizacao_itens_confirmado_check'
      and conrelid = 'public.nuvemshop_sincronizacao_itens'::regclass
  ) then
    alter table public.nuvemshop_sincronizacao_itens
      add constraint nuvemshop_sincronizacao_itens_confirmado_check
      check (estoque_confirmado is null or estoque_confirmado >= 0);
  end if;
end;
$$;

create unique index if not exists nuvemshop_aplicacao_origem_simulacao_uidx
on public.nuvemshop_sincronizacoes (origem_simulacao_id)
where modo = 'aplicacao' and origem_simulacao_id is not null;

create unique index if not exists nuvemshop_aplicacao_origem_item_uidx
on public.nuvemshop_sincronizacao_itens (origem_item_id)
where origem_item_id is not null;

comment on column public.nuvemshop_sincronizacoes.origem_simulacao_id is
  'Simulacao recente que autorizou esta aplicacao. Uma simulacao so pode originar uma aplicacao.';
comment on column public.nuvemshop_sincronizacao_itens.origem_item_id is
  'Item alteraria selecionado na simulacao de origem.';
comment on column public.nuvemshop_sincronizacao_itens.estoque_confirmado is
  'Estoque lido novamente na Nuvemshop depois da tentativa de aplicacao.';

create or replace function public.iniciar_aplicacao_piloto_nuvemshop(
  p_chave_operacao uuid,
  p_simulacao_id uuid,
  p_item_simulacao_id bigint,
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
  v_estoque_local integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A aplicacao piloto so pode ser iniciada pelo servidor.'
      using errcode = '42501';
  end if;

  if p_chave_operacao is null
     or p_simulacao_id is null
     or p_item_simulacao_id is null
     or p_store_id is null
     or p_solicitado_por is null then
    raise exception 'Parametros obrigatorios da aplicacao piloto ausentes.';
  end if;

  select c.*
    into v_conexao
  from public.nuvemshop_conexoes c
  where c.store_id = p_store_id
  for update;

  if not found then
    raise exception 'Conexao Nuvemshop nao encontrada.';
  end if;

  if not v_conexao.escrita_habilitada then
    raise exception 'Interruptor de escrita da loja esta desligado.'
      using errcode = '42501';
  end if;

  if v_conexao.limite_aplicacao <> 1 then
    raise exception 'O piloto exige limite de exatamente um item.';
  end if;

  if nullif(btrim(v_conexao.local_estoque_id), '') is null then
    raise exception 'Local de estoque da loja nao esta confirmado.';
  end if;

  if not exists (
    select 1
    from regexp_split_to_table(
      coalesce(v_conexao.escopos, ''),
      '[[:space:],]+'
    ) as escopo(valor)
    where lower(escopo.valor) = 'write_products'
  ) then
    raise exception 'A conexao nao possui o escopo write_products.'
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

  if not found then
    raise exception 'Simulacao de origem nao encontrada.';
  end if;

  if v_simulacao.modo <> 'simulacao'
     or v_simulacao.status <> 'concluida'
     or v_simulacao.total_itens < 1
     or v_simulacao.itens_sucesso <> v_simulacao.total_itens
     or v_simulacao.itens_falha <> 0
     or v_simulacao.concluido_em is null
     or v_simulacao.store_id <> p_store_id
     or v_simulacao.solicitado_por <> p_solicitado_por
     or v_simulacao.local_estoque_id is distinct from v_conexao.local_estoque_id
     or v_simulacao.created_at < now() - interval '15 minutes'
     or v_simulacao.created_at > now() + interval '1 minute' then
    raise exception 'A simulacao nao atende aos requisitos de validade do piloto.';
  end if;

  select i.*
    into v_item
  from public.nuvemshop_sincronizacao_itens i
  where i.id = p_item_simulacao_id
    and i.sincronizacao_id = p_simulacao_id
  for update;

  if not found then
    raise exception 'Item nao pertence a simulacao informada.';
  end if;

  if v_item.status <> 'concluido'
     or v_item.resultado_previsto <> 'alteraria'
     or v_item.vinculo_id is null
     or v_item.estoque_anterior is null
     or v_item.estoque_destino is null
     or v_item.estoque_anterior = v_item.estoque_destino
     or v_item.diferenca is distinct from (
       v_item.estoque_destino - v_item.estoque_anterior
     ) then
    raise exception 'Item da simulacao nao esta apto para aplicacao.';
  end if;

  if not exists (
    select 1
    from public.nuvemshop_vinculos v
    where v.id = v_item.vinculo_id
      and v.store_id = p_store_id
      and v.ativo
      and v.produto_id = v_item.produto_id
      and v.voltagem is not distinct from v_item.voltagem
      and v.nuvemshop_produto_id = v_item.nuvemshop_produto_id
      and v.nuvemshop_variante_id is not distinct from v_item.nuvemshop_variante_id
  ) then
    raise exception 'Vinculo do item mudou desde a simulacao.';
  end if;

  select case v_item.voltagem
    when '110V' then p.quantidade_110v
    when '220V' then p.quantidade_220v
    else p.quantidade
  end
    into v_estoque_local
  from public.produtos p
  where p.id = v_item.produto_id;

  if not found or v_estoque_local is distinct from v_item.estoque_destino then
    raise exception 'Estoque local mudou desde a simulacao. Gere uma nova previa.';
  end if;

  if exists (
    select 1
    from public.nuvemshop_sincronizacoes s
    where s.modo = 'aplicacao'
      and s.origem_simulacao_id = p_simulacao_id
  ) or exists (
    select 1
    from public.nuvemshop_sincronizacao_itens i
    where i.origem_item_id = p_item_simulacao_id
  ) then
    raise exception 'Esta simulacao ja foi reservada para uma aplicacao.';
  end if;

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
    1,
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
    estoque_anterior,
    estoque_destino,
    resultado_previsto,
    diferenca,
    status,
    origem_item_id
  ) values (
    v_aplicacao_id,
    v_item.vinculo_id,
    v_item.produto_id,
    v_item.voltagem,
    v_item.nuvemshop_produto_id,
    v_item.nuvemshop_variante_id,
    v_item.estoque_anterior,
    v_item.estoque_destino,
    'alteraria',
    v_item.diferenca,
    'processando',
    p_item_simulacao_id
  );

  return v_aplicacao_id;
exception
  when unique_violation then
    raise exception 'A operacao ou simulacao ja possui uma reserva de aplicacao.';
end;
$$;

create or replace function public.finalizar_aplicacao_piloto_nuvemshop(
  p_aplicacao_id uuid,
  p_resultado text,
  p_estoque_confirmado integer default null,
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
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A aplicacao piloto so pode ser finalizada pelo servidor.'
      using errcode = '42501';
  end if;

  if p_aplicacao_id is null
     or p_resultado is null
     or p_resultado not in ('concluida', 'parcial', 'falhou') then
    raise exception 'Resultado de aplicacao invalido.';
  end if;

  if p_estoque_confirmado is not null and p_estoque_confirmado < 0 then
    raise exception 'Estoque confirmado invalido.';
  end if;

  select s.*
    into v_aplicacao
  from public.nuvemshop_sincronizacoes s
  where s.id = p_aplicacao_id
  for update;

  if not found then
    raise exception 'Aplicacao piloto nao encontrada.';
  end if;

  if v_aplicacao.modo <> 'aplicacao'
     or v_aplicacao.total_itens <> 1
     or v_aplicacao.origem_simulacao_id is null then
    raise exception 'Registro nao corresponde a uma aplicacao piloto valida.';
  end if;

  if v_aplicacao.status not in ('preparando', 'processando') then
    raise exception 'Aplicacao piloto ja foi finalizada.';
  end if;

  select i.*
    into v_item
  from public.nuvemshop_sincronizacao_itens i
  where i.sincronizacao_id = p_aplicacao_id
  for update;

  if not found then
    raise exception 'Item da aplicacao piloto nao encontrado.';
  end if;

  if p_resultado = 'concluida'
     and p_estoque_confirmado is distinct from v_item.estoque_destino then
    raise exception 'Estoque confirmado difere do destino reservado.';
  end if;

  if p_resultado <> 'concluida'
     and nullif(btrim(p_erro), '') is null then
    raise exception 'Informe o motivo da aplicacao nao concluida.';
  end if;

  update public.nuvemshop_sincronizacao_itens
  set status = case
        when p_resultado = 'concluida' then 'concluido'
        else 'falhou'
      end,
      estoque_confirmado = p_estoque_confirmado,
      erro = case
        when p_resultado = 'concluida' then null
        else btrim(p_erro)
      end,
      processado_em = now()
  where id = v_item.id;

  update public.nuvemshop_sincronizacoes
  set status = p_resultado,
      itens_sucesso = case when p_resultado = 'concluida' then 1 else 0 end,
      itens_falha = case when p_resultado = 'concluida' then 0 else 1 end,
      erro = case
        when p_resultado = 'concluida' then null
        else btrim(p_erro)
      end,
      concluido_em = now()
  where id = p_aplicacao_id;
end;
$$;

revoke all on function public.iniciar_aplicacao_piloto_nuvemshop(
  uuid, uuid, bigint, bigint, uuid
) from public, anon, authenticated;

grant execute on function public.iniciar_aplicacao_piloto_nuvemshop(
  uuid, uuid, bigint, bigint, uuid
) to service_role;

revoke all on function public.finalizar_aplicacao_piloto_nuvemshop(
  uuid, text, integer, text
) from public, anon, authenticated;

grant execute on function public.finalizar_aplicacao_piloto_nuvemshop(
  uuid, text, integer, text
) to service_role;

notify pgrst, 'reload schema';

commit;

select
  p.proname as funcao,
  pg_get_function_identity_arguments(p.oid) as argumentos
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in (
    'iniciar_aplicacao_piloto_nuvemshop',
    'finalizar_aplicacao_piloto_nuvemshop'
  )
order by p.proname;
