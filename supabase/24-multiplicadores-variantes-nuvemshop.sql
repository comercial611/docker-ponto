begin;

set local lock_timeout = '10s';
set local statement_timeout = '120s';

alter table public.nuvemshop_vinculos
  add column if not exists unidades_por_venda integer;

update public.nuvemshop_vinculos
set unidades_por_venda = 1
where unidades_por_venda is null;

alter table public.nuvemshop_vinculos
  alter column unidades_por_venda set default 1,
  alter column unidades_por_venda set not null;

alter table public.nuvemshop_sincronizacao_itens
  add column if not exists unidades_por_venda integer,
  add column if not exists estoque_local_base integer;

update public.nuvemshop_sincronizacao_itens
set unidades_por_venda = 1
where unidades_por_venda is null;

alter table public.nuvemshop_sincronizacao_itens
  alter column unidades_por_venda set default 1,
  alter column unidades_por_venda set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_vinculos_unidades_venda_check'
      and conrelid = 'public.nuvemshop_vinculos'::regclass
  ) then
    alter table public.nuvemshop_vinculos
      add constraint nuvemshop_vinculos_unidades_venda_check
      check (unidades_por_venda between 1 and 10000);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_sincronizacao_itens_unidades_venda_check'
      and conrelid = 'public.nuvemshop_sincronizacao_itens'::regclass
  ) then
    alter table public.nuvemshop_sincronizacao_itens
      add constraint nuvemshop_sincronizacao_itens_unidades_venda_check
      check (unidades_por_venda between 1 and 10000);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_sincronizacao_itens_estoque_base_check'
      and conrelid = 'public.nuvemshop_sincronizacao_itens'::regclass
  ) then
    alter table public.nuvemshop_sincronizacao_itens
      add constraint nuvemshop_sincronizacao_itens_estoque_base_check
      check (estoque_local_base is null or estoque_local_base >= 0);
  end if;
end;
$$;

-- Uma oferta externa continua unica, mas varias ofertas podem consumir o
-- mesmo produto fisico local com quantidades diferentes.
drop index if exists public.nuvemshop_vinculos_local_ativo_uidx;

create index if not exists nuvemshop_vinculos_local_ativo_idx
on public.nuvemshop_vinculos (
  store_id,
  produto_id,
  coalesce(voltagem, '')
)
where ativo;

create or replace function public.validar_vinculo_nuvemshop()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tem_voltagem boolean;
begin
  select tem_voltagem
  into v_tem_voltagem
  from public.produtos
  where id = new.produto_id;

  if not found then
    raise exception 'Produto local nao encontrado.';
  end if;

  new.voltagem := nullif(upper(trim(new.voltagem)), '');
  new.nuvemshop_sku := nullif(trim(new.nuvemshop_sku), '');
  new.unidades_por_venda := coalesce(new.unidades_por_venda, 1);

  if new.unidades_por_venda < 1 or new.unidades_por_venda > 10000 then
    raise exception 'Unidades por venda deve ficar entre 1 e 10000.';
  end if;

  if v_tem_voltagem and new.voltagem is null then
    raise exception 'Informe 110V ou 220V para este produto.';
  end if;

  if not v_tem_voltagem and new.voltagem is not null then
    raise exception 'Produto sem voltagem deve usar vinculo unico.';
  end if;

  return new;
end;
$$;

create or replace function public.validar_item_sincronizacao_nuvemshop()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_unidades_por_venda integer;
  v_estoque_local integer;
  v_estoque_destino integer;
begin
  if new.vinculo_id is null then
    return new;
  end if;

  select v.unidades_por_venda
    into v_unidades_por_venda
  from public.nuvemshop_vinculos v
  where v.id = new.vinculo_id
    and v.ativo
    and v.produto_id = new.produto_id
    and v.voltagem is not distinct from new.voltagem
    and v.nuvemshop_produto_id = new.nuvemshop_produto_id
    and v.nuvemshop_variante_id is not distinct from new.nuvemshop_variante_id;

  if not found then
    raise exception 'Vinculo da sincronizacao nao foi encontrado.';
  end if;

  select case new.voltagem
    when '110V' then p.quantidade_110v
    when '220V' then p.quantidade_220v
    else p.quantidade
  end
    into v_estoque_local
  from public.produtos p
  where p.id = new.produto_id;

  if not found or v_estoque_local is null or v_estoque_local < 0 then
    raise exception 'Estoque fisico local invalido.';
  end if;

  v_estoque_destino := floor(
    v_estoque_local::numeric / v_unidades_por_venda
  )::integer;

  if new.estoque_destino is not null
     and new.estoque_destino <> v_estoque_destino then
    raise exception
      'Estoque de destino divergente. Esperado % para % unidade(s) por venda.',
      v_estoque_destino,
      v_unidades_por_venda;
  end if;

  new.unidades_por_venda := v_unidades_por_venda;
  new.estoque_local_base := v_estoque_local;
  return new;
end;
$$;

revoke all on function public.validar_item_sincronizacao_nuvemshop()
from public, anon, authenticated;

drop trigger if exists validar_item_sincronizacao_nuvemshop
on public.nuvemshop_sincronizacao_itens;

create trigger validar_item_sincronizacao_nuvemshop
before insert or update of
  vinculo_id,
  produto_id,
  voltagem,
  nuvemshop_produto_id,
  nuvemshop_variante_id,
  estoque_destino,
  unidades_por_venda
on public.nuvemshop_sincronizacao_itens
for each row execute function public.validar_item_sincronizacao_nuvemshop();

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
  v_estoque_destino integer;
  v_unidades_por_venda integer;
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
     or v_unidades_por_venda is distinct from v_item.unidades_por_venda then
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

  if not found
     or v_estoque_local is null
     or v_estoque_local < 0 then
    raise exception 'Estoque fisico local invalido.';
  end if;

  v_estoque_destino := floor(
    v_estoque_local::numeric / v_unidades_por_venda
  )::integer;

  if v_estoque_local is distinct from v_item.estoque_local_base
     or v_estoque_destino is distinct from v_item.estoque_destino then
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
    unidades_por_venda,
    estoque_local_base,
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
    v_item.unidades_por_venda,
    v_item.estoque_local_base,
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

comment on column public.nuvemshop_vinculos.unidades_por_venda is
  'Quantidade fisica do produto local consumida por uma venda desta oferta externa.';
comment on column public.nuvemshop_sincronizacao_itens.unidades_por_venda is
  'Multiplicador confirmado no vinculo no momento da simulacao.';
comment on column public.nuvemshop_sincronizacao_itens.estoque_local_base is
  'Estoque fisico local usado para calcular o destino externo.';

notify pgrst, 'reload schema';

commit;

select
  store_id,
  produto_id,
  voltagem,
  count(*) filter (where ativo) as ofertas_ativas,
  min(unidades_por_venda) filter (where ativo) as menor_pacote,
  max(unidades_por_venda) filter (where ativo) as maior_pacote
from public.nuvemshop_vinculos
group by store_id, produto_id, voltagem
order by store_id, produto_id, voltagem;
