begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

create table public.estoque_operacoes (
  id bigserial primary key,
  chave_operacao uuid not null unique,
  tipo text not null default 'entrada',
  motivo text not null,
  data_movimento date not null,
  solicitado_por uuid not null references auth.users(id) on delete restrict,
  solicitado_email text not null,
  payload_normalizado jsonb not null,
  criado_em timestamp with time zone not null default clock_timestamp(),
  constraint estoque_operacoes_tipo_check
    check (tipo = 'entrada'),
  constraint estoque_operacoes_motivo_check
    check (length(btrim(motivo)) between 1 and 500),
  constraint estoque_operacoes_payload_check
    check (jsonb_typeof(payload_normalizado) = 'object')
);

create table public.estoque_operacao_itens (
  id bigserial primary key,
  operacao_id bigint not null
    references public.estoque_operacoes(id) on delete restrict,
  produto_id integer not null
    references public.produtos(id) on delete restrict,
  voltagem text,
  quantidade integer not null,
  quantidade_anterior integer not null,
  quantidade_nova integer not null,
  historico_id integer not null unique
    references public.historico(id) on delete restrict,
  criado_em timestamp with time zone not null default clock_timestamp(),
  constraint estoque_operacao_itens_voltagem_check
    check (voltagem is null or voltagem in ('110v', '220v')),
  constraint estoque_operacao_itens_quantidade_check
    check (quantidade > 0),
  constraint estoque_operacao_itens_saldos_check
    check (
      quantidade_anterior >= 0
      and quantidade_nova = quantidade_anterior + quantidade
    )
);

create unique index estoque_operacao_itens_destino_unique
  on public.estoque_operacao_itens (
    operacao_id,
    produto_id,
    coalesce(voltagem, '')
  );

create index estoque_operacoes_movimento_idx
  on public.estoque_operacoes (data_movimento desc, criado_em desc);

create index estoque_operacao_itens_produto_idx
  on public.estoque_operacao_itens (produto_id, criado_em desc);

alter table public.estoque_operacoes enable row level security;
alter table public.estoque_operacao_itens enable row level security;

revoke all on public.estoque_operacoes
  from public, anon, authenticated;
revoke all on public.estoque_operacao_itens
  from public, anon, authenticated;
revoke all on sequence public.estoque_operacoes_id_seq
  from public, anon, authenticated;
revoke all on sequence public.estoque_operacao_itens_id_seq
  from public, anon, authenticated;

grant select on public.estoque_operacoes to authenticated;
grant select on public.estoque_operacao_itens to authenticated;

create policy "Estoque operacoes: admin pode ler"
on public.estoque_operacoes
for select
to authenticated
using (public.eh_admin());

create policy "Estoque operacao itens: admin pode ler"
on public.estoque_operacao_itens
for select
to authenticated
using (public.eh_admin());

create or replace function public.bloquear_mutacao_estoque_operacao()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'Operacoes de estoque sao imutaveis; registre uma nova operacao para reverter.'
    using errcode = '55000';
end;
$$;

revoke all on function public.bloquear_mutacao_estoque_operacao()
  from public, anon, authenticated;

create trigger bloquear_mutacao_estoque_operacoes
before update or delete on public.estoque_operacoes
for each row execute function public.bloquear_mutacao_estoque_operacao();

create trigger bloquear_mutacao_estoque_operacao_itens
before update or delete on public.estoque_operacao_itens
for each row execute function public.bloquear_mutacao_estoque_operacao();

create or replace function public.registrar_entrada_estoque(
  p_chave_operacao uuid,
  p_motivo text,
  p_data_movimento date,
  p_itens jsonb
)
returns table (
  operacao_id bigint,
  chave_operacao uuid,
  produto_id integer,
  produto_nome text,
  voltagem text,
  quantidade integer,
  quantidade_anterior integer,
  quantidade_nova integer,
  historico_id integer,
  repetida boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usuario_id uuid := auth.uid();
  v_usuario_email text := auth.jwt()->>'email';
  v_motivo text := nullif(btrim(p_motivo), '');
  v_itens_normalizados jsonb;
  v_payload_normalizado jsonb;
  v_operacao public.estoque_operacoes%rowtype;
  v_item record;
  v_produto public.produtos%rowtype;
  v_voltagem text;
  v_quantidade_anterior integer;
  v_quantidade_nova bigint;
  v_historico_id integer;
begin
  if v_usuario_id is null then
    raise exception 'Autenticacao necessaria.'
      using errcode = '42501';
  end if;

  if public.eh_admin() is not true then
    raise exception 'Somente administradores podem registrar entrada de mercadoria.'
      using errcode = '42501';
  end if;

  if p_chave_operacao is null then
    raise exception 'Chave da operacao obrigatoria.';
  end if;

  if v_motivo is null or length(v_motivo) > 500 then
    raise exception 'Informe um motivo com ate 500 caracteres.';
  end if;

  if p_data_movimento is null then
    raise exception 'Informe a data do movimento.';
  end if;

  if p_data_movimento > current_date then
    raise exception 'A data do movimento nao pode estar no futuro.';
  end if;

  if p_itens is null
     or jsonb_typeof(p_itens) <> 'array'
     or jsonb_array_length(p_itens) < 1
     or jsonb_array_length(p_itens) > 100 then
    raise exception 'Informe de 1 a 100 itens para a entrada.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_itens) as raw(item)
    where jsonb_typeof(raw.item) <> 'object'
       or raw.item - array['produto_id', 'quantidade', 'voltagem']::text[] <> '{}'::jsonb
       or jsonb_typeof(raw.item->'produto_id') <> 'number'
       or jsonb_typeof(raw.item->'quantidade') <> 'number'
       or coalesce(raw.item->>'produto_id', '') !~ '^[1-9][0-9]*$'
       or coalesce(raw.item->>'quantidade', '') !~ '^[1-9][0-9]*$'
       or case
         when jsonb_typeof(raw.item->'produto_id') = 'number'
              and coalesce(raw.item->>'produto_id', '') ~ '^[1-9][0-9]*$'
         then (raw.item->>'produto_id')::numeric > 2147483647
         else false
       end
       or case
         when jsonb_typeof(raw.item->'quantidade') = 'number'
              and coalesce(raw.item->>'quantidade', '') ~ '^[1-9][0-9]*$'
         then (raw.item->>'quantidade')::numeric > 2147483647
         else false
       end
       or (
         raw.item->>'voltagem' is not null
         and lower(btrim(raw.item->>'voltagem')) not in ('110v', '220v')
       )
  ) then
    raise exception 'Existe item com produto, quantidade ou voltagem invalida.';
  end if;

  select jsonb_agg(
    jsonb_build_object(
      'produto_id', (raw.item->>'produto_id')::integer,
      'quantidade', (raw.item->>'quantidade')::integer,
      'voltagem', case
        when raw.item->>'voltagem' is null then null
        else lower(btrim(raw.item->>'voltagem'))
      end
    )
    order by
      (raw.item->>'produto_id')::integer,
      coalesce(lower(btrim(raw.item->>'voltagem')), '')
  )
  into v_itens_normalizados
  from jsonb_array_elements(p_itens) as raw(item);

  if exists (
    select 1
    from jsonb_to_recordset(v_itens_normalizados) as item(
      produto_id integer,
      quantidade integer,
      voltagem text
    )
    group by item.produto_id, item.voltagem
    having count(*) > 1
  ) then
    raise exception 'Nao repita o mesmo produto e voltagem na entrada.';
  end if;

  v_payload_normalizado := jsonb_build_object(
    'tipo', 'entrada',
    'motivo', v_motivo,
    'data_movimento', p_data_movimento::text,
    'itens', v_itens_normalizados
  );

  perform pg_advisory_xact_lock(
    hashtextextended(p_chave_operacao::text, 0)
  );

  select *
    into v_operacao
  from public.estoque_operacoes o
  where o.chave_operacao = p_chave_operacao;

  if found then
    if v_operacao.payload_normalizado is distinct from v_payload_normalizado then
      raise exception 'A chave desta operacao ja foi usada com dados diferentes.'
        using errcode = '23505';
    end if;

    return query
    select
      o.id,
      o.chave_operacao,
      i.produto_id,
      p.nome,
      i.voltagem,
      i.quantidade,
      i.quantidade_anterior,
      i.quantidade_nova,
      i.historico_id,
      true
    from public.estoque_operacoes o
    join public.estoque_operacao_itens i on i.operacao_id = o.id
    join public.produtos p on p.id = i.produto_id
    where o.id = v_operacao.id
    order by i.produto_id, coalesce(i.voltagem, '');
    return;
  end if;

  insert into public.estoque_operacoes (
    chave_operacao,
    tipo,
    motivo,
    data_movimento,
    solicitado_por,
    solicitado_email,
    payload_normalizado
  ) values (
    p_chave_operacao,
    'entrada',
    v_motivo,
    p_data_movimento,
    v_usuario_id,
    coalesce(nullif(btrim(v_usuario_email), ''), v_usuario_id::text),
    v_payload_normalizado
  )
  returning * into v_operacao;

  for v_item in
    select item.produto_id, item.quantidade, item.voltagem
    from jsonb_to_recordset(v_itens_normalizados) as item(
      produto_id integer,
      quantidade integer,
      voltagem text
    )
    order by item.produto_id, coalesce(item.voltagem, '')
  loop
    select *
      into v_produto
    from public.produtos p
    where p.id = v_item.produto_id
    for update;

    if not found then
      raise exception 'Produto % nao encontrado.', v_item.produto_id;
    end if;

    if v_produto.ativo is not true then
      raise exception 'Produto inativo nao pode receber entrada: %.', v_produto.nome;
    end if;

    if v_produto.tem_voltagem then
      if v_item.voltagem is null
         or v_item.voltagem not in ('110v', '220v') then
        raise exception 'Selecione 110V ou 220V para %.', v_produto.nome;
      end if;
      v_voltagem := v_item.voltagem;
    else
      if v_item.voltagem is not null then
        raise exception 'Produto sem voltagem deve usar o estoque simples: %.', v_produto.nome;
      end if;
      v_voltagem := null;
    end if;

    if v_voltagem = '110v' then
      v_quantidade_anterior := coalesce(v_produto.quantidade_110v, 0);
    elsif v_voltagem = '220v' then
      v_quantidade_anterior := coalesce(v_produto.quantidade_220v, 0);
    else
      v_quantidade_anterior := coalesce(v_produto.quantidade, 0);
    end if;

    v_quantidade_nova := v_quantidade_anterior::bigint + v_item.quantidade::bigint;
    if v_quantidade_nova > 2147483647 then
      raise exception 'O novo saldo de % excede o limite permitido.', v_produto.nome;
    end if;

    if v_voltagem = '110v' then
      update public.produtos
      set quantidade_110v = v_quantidade_nova::integer
      where id = v_produto.id;
    elsif v_voltagem = '220v' then
      update public.produtos
      set quantidade_220v = v_quantidade_nova::integer
      where id = v_produto.id;
    else
      update public.produtos
      set quantidade = v_quantidade_nova::integer
      where id = v_produto.id;
    end if;

    insert into public.historico (
      produto_id,
      quantidade_anterior,
      quantidade_nova,
      usuario,
      vendedor,
      voltagem,
      tipo
    ) values (
      v_produto.id,
      v_quantidade_anterior,
      v_quantidade_nova::integer,
      coalesce(nullif(btrim(v_usuario_email), ''), v_usuario_id::text),
      coalesce(nullif(btrim(v_usuario_email), ''), v_usuario_id::text),
      v_voltagem,
      'entrada_mercadoria'
    )
    returning id into v_historico_id;

    insert into public.estoque_operacao_itens (
      operacao_id,
      produto_id,
      voltagem,
      quantidade,
      quantidade_anterior,
      quantidade_nova,
      historico_id
    ) values (
      v_operacao.id,
      v_produto.id,
      v_voltagem,
      v_item.quantidade,
      v_quantidade_anterior,
      v_quantidade_nova::integer,
      v_historico_id
    );
  end loop;

  return query
  select
    o.id,
    o.chave_operacao,
    i.produto_id,
    p.nome,
    i.voltagem,
    i.quantidade,
    i.quantidade_anterior,
    i.quantidade_nova,
    i.historico_id,
    false
  from public.estoque_operacoes o
  join public.estoque_operacao_itens i on i.operacao_id = o.id
  join public.produtos p on p.id = i.produto_id
  where o.id = v_operacao.id
  order by i.produto_id, coalesce(i.voltagem, '');
end;
$$;

revoke all on function public.registrar_entrada_estoque(uuid, text, date, jsonb)
  from public, anon, authenticated;
grant execute on function public.registrar_entrada_estoque(uuid, text, date, jsonb)
  to authenticated;

comment on table public.estoque_operacoes is
  'Ledger imutavel e auditavel das operacoes causais no estoque fisico local.';
comment on table public.estoque_operacao_itens is
  'Itens imutaveis das operacoes de estoque, com saldos anterior e novo e referencia ao historico.';
comment on function public.registrar_entrada_estoque(uuid, text, date, jsonb) is
  'Registra entrada local atomica, auditada e idempotente; nao publica nem consulta estoque externo.';

notify pgrst, 'reload schema';

commit;
