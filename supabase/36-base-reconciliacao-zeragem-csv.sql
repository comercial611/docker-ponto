begin;

set local lock_timeout = '10s';
set local statement_timeout = '90s';

alter table public.baixas_csv_lotes
  add column validacao_versao smallint not null default 1,
  add column payload_normalizado jsonb;

-- O legado permanece v1 e nao participa da unicidade por competencia. Apenas
-- fechamentos oficiais novos (v2) passam a ser unicos e identificaveis.
create unique index baixas_csv_lotes_competencia_uidx
  on public.baixas_csv_lotes (data_movimento)
  where validacao_versao >= 2
    and data_movimento is not null;

alter table public.baixas_csv_lotes
  add constraint baixas_csv_lotes_validacao_versao_check
    check (validacao_versao in (1, 2)),
  add constraint baixas_csv_lotes_payload_v2_check
    check (
      validacao_versao <> 2
      or (
        payload_normalizado is not null
        and jsonb_typeof(payload_normalizado) = 'object'
        and data_movimento is not null
        and nullif(btrim(arquivo_hash), '') is not null
      )
    );

-- A tabela e apenas a fundacao para a futura RPC de zeragem. Esta migration
-- nao oferece INSERT a nenhum papel e nao cria uma operacao de zeragem.
create table public.estoque_coberturas_csv (
  id bigserial primary key,
  operacao_item_id bigint not null unique
    references public.estoque_operacao_itens(id) on delete restrict,
  produto_id integer not null
    references public.produtos(id) on delete restrict,
  voltagem text,
  competencia date not null,
  causa text not null default 'venda_aguardando_csv',
  quantidade_coberta integer not null,
  criado_por uuid not null references auth.users(id) on delete restrict,
  criado_email text not null,
  criado_em timestamp with time zone not null default clock_timestamp(),
  constraint estoque_coberturas_csv_voltagem_check
    check (voltagem is null or voltagem in ('110v', '220v')),
  constraint estoque_coberturas_csv_causa_check
    check (causa = 'venda_aguardando_csv'),
  constraint estoque_coberturas_csv_quantidade_check
    check (quantidade_coberta > 0),
  constraint estoque_coberturas_csv_email_check
    check (length(btrim(criado_email)) > 0)
);

create unique index estoque_coberturas_csv_destino_competencia_uidx
  on public.estoque_coberturas_csv (
    produto_id,
    coalesce(voltagem, ''),
    competencia
  );

create index estoque_coberturas_csv_competencia_idx
  on public.estoque_coberturas_csv (competencia, produto_id);

create table public.estoque_cobertura_csv_eventos (
  id bigserial primary key,
  cobertura_id bigint not null unique
    references public.estoque_coberturas_csv(id) on delete restrict,
  tipo text not null default 'reconciliada',
  lote_id bigint not null
    references public.baixas_csv_lotes(id) on delete restrict,
  lote_item_id bigint not null unique
    references public.baixas_csv_itens(id) on delete restrict,
  quantidade_csv integer not null,
  registrado_por uuid not null references auth.users(id) on delete restrict,
  registrado_email text not null,
  criado_em timestamp with time zone not null default clock_timestamp(),
  constraint estoque_cobertura_csv_eventos_tipo_check
    check (tipo = 'reconciliada'),
  constraint estoque_cobertura_csv_eventos_quantidade_check
    check (quantidade_csv > 0),
  constraint estoque_cobertura_csv_eventos_email_check
    check (length(btrim(registrado_email)) > 0)
);

alter table public.baixas_csv_itens
  add column modo_aplicacao text not null default 'baixa',
  add column cobertura_id bigint
    references public.estoque_coberturas_csv(id) on delete restrict;

alter table public.baixas_csv_itens
  add constraint baixas_csv_itens_modo_aplicacao_check
    check (modo_aplicacao in ('baixa', 'reconciliacao_cobertura')),
  add constraint baixas_csv_itens_cobertura_check
    check (
      (modo_aplicacao = 'baixa' and cobertura_id is null)
      or (modo_aplicacao = 'reconciliacao_cobertura' and cobertura_id is not null)
    );

alter table public.estoque_coberturas_csv enable row level security;
alter table public.estoque_cobertura_csv_eventos enable row level security;

revoke all on public.estoque_coberturas_csv
  from public, anon, authenticated;
revoke all on public.estoque_cobertura_csv_eventos
  from public, anon, authenticated;
revoke all on sequence public.estoque_coberturas_csv_id_seq
  from public, anon, authenticated;
revoke all on sequence public.estoque_cobertura_csv_eventos_id_seq
  from public, anon, authenticated;

grant select on public.estoque_coberturas_csv to authenticated;
grant select on public.estoque_cobertura_csv_eventos to authenticated;

create policy "Estoque coberturas CSV: admin pode ler"
on public.estoque_coberturas_csv
for select
to authenticated
using (public.eh_admin());

create policy "Estoque cobertura CSV eventos: admin pode ler"
on public.estoque_cobertura_csv_eventos
for select
to authenticated
using (public.eh_admin());

create or replace function public.validar_estoque_cobertura_csv()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item_produto_id integer;
  v_item_voltagem text;
  v_item_quantidade_anterior integer;
  v_item_quantidade_nova integer;
  v_tipo text;
begin
  select
    i.produto_id,
    i.voltagem,
    i.quantidade_anterior,
    i.quantidade_nova,
    o.tipo
  into
    v_item_produto_id,
    v_item_voltagem,
    v_item_quantidade_anterior,
    v_item_quantidade_nova,
    v_tipo
  from public.estoque_operacao_itens i
  join public.estoque_operacoes o on o.id = i.operacao_id
  where i.id = new.operacao_item_id;

  if not found
     or v_tipo <> 'zeragem'
     or v_item_produto_id <> new.produto_id
     or v_item_voltagem is distinct from new.voltagem
     or v_item_quantidade_anterior <> new.quantidade_coberta
     or v_item_quantidade_nova <> 0 then
    raise exception 'A cobertura deve corresponder integralmente a um item de zeragem confirmado.';
  end if;

  return new;
end;
$$;

revoke all on function public.validar_estoque_cobertura_csv()
  from public, anon, authenticated, service_role;

create trigger validar_estoque_cobertura_csv
before insert on public.estoque_coberturas_csv
for each row execute function public.validar_estoque_cobertura_csv();

create or replace function public.validar_estoque_cobertura_csv_evento()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_cobertura public.estoque_coberturas_csv%rowtype;
  v_lote public.baixas_csv_lotes%rowtype;
  v_item public.baixas_csv_itens%rowtype;
begin
  select * into v_cobertura
  from public.estoque_coberturas_csv c
  where c.id = new.cobertura_id;

  select * into v_lote
  from public.baixas_csv_lotes l
  where l.id = new.lote_id;

  select * into v_item
  from public.baixas_csv_itens i
  where i.id = new.lote_item_id;

  if v_cobertura.id is null
     or v_lote.id is null
     or v_item.id is null
     or v_lote.data_movimento is distinct from v_cobertura.competencia
     or v_item.lote_id <> v_lote.id
     or v_item.produto_id <> v_cobertura.produto_id
     or v_item.cobertura_id is distinct from v_cobertura.id
     or v_item.modo_aplicacao <> 'reconciliacao_cobertura'
     or v_item.quantidade_csv <> v_cobertura.quantidade_coberta
     or new.quantidade_csv <> v_cobertura.quantidade_coberta then
    raise exception 'O evento deve corresponder exatamente a cobertura, lote e item reconciliados.';
  end if;

  return new;
end;
$$;

revoke all on function public.validar_estoque_cobertura_csv_evento()
  from public, anon, authenticated, service_role;

create trigger validar_estoque_cobertura_csv_evento
before insert on public.estoque_cobertura_csv_eventos
for each row execute function public.validar_estoque_cobertura_csv_evento();

create trigger bloquear_mutacao_estoque_coberturas_csv
before update or delete on public.estoque_coberturas_csv
for each row execute function public.bloquear_mutacao_estoque_operacao();

create trigger bloquear_mutacao_estoque_cobertura_csv_eventos
before update or delete on public.estoque_cobertura_csv_eventos
for each row execute function public.bloquear_mutacao_estoque_operacao();

-- A antiga funcao inferior deixa de ser uma fronteira mutavel. Ela permanece
-- apenas para produzir um erro explicito a qualquer integracao antiga.
create or replace function public.registrar_baixa_csv_produtos(
  p_itens jsonb,
  p_arquivo_nome text default null,
  p_resumo jsonb default '{}'::jsonb
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
set search_path = public, pg_temp
as $$
begin
  raise exception 'Use registrar_fechamento_csv_produtos; a baixa CSV inferior nao aceita chamadas diretas.'
    using errcode = '42501';
end;
$$;

revoke all on function public.registrar_baixa_csv_produtos(jsonb, text, jsonb)
  from public, anon, authenticated, service_role;

revoke all on function public.registrar_fechamento_csv_produtos(jsonb, text, jsonb, text, date)
  from public, anon, authenticated, service_role;
drop function public.registrar_fechamento_csv_produtos(jsonb, text, jsonb, text, date);

create or replace function public.registrar_fechamento_csv_produtos(
  p_linhas jsonb,
  p_arquivo_nome text,
  p_arquivo_hash text,
  p_data_movimento date,
  p_usuario_id uuid
)
returns table (
  lote_id bigint,
  produto_id integer,
  produto_nome text,
  quantidade_anterior integer,
  quantidade_nova integer,
  quantidade_baixada integer,
  repetida boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_usuario_id uuid := p_usuario_id;
  v_usuario_email text;
  v_arquivo_nome text := nullif(btrim(p_arquivo_nome), '');
  v_hash text := lower(btrim(coalesce(p_arquivo_hash, '')));
  v_payload jsonb;
  v_lote public.baixas_csv_lotes%rowtype;
  v_produto public.produtos%rowtype;
  v_item record;
  v_lote_id bigint;
  v_lote_item_id bigint;
  v_historico_id integer;
  v_anterior integer;
  v_nova integer;
  v_total_linhas integer;
  v_produtos_encontrados integer;
  v_maquinas_ignoradas integer;
  v_nao_encontrados integer;
  v_estoque_insuficiente integer;
  v_total_csv integer;
  v_total_aplicado integer := 0;
begin
  if p_usuario_id is null then
    raise exception 'Usuario administrativo invalido.' using errcode = '42501';
  end if;

  select u.email
  into v_usuario_email
  from auth.users u
  join public.perfis p on p.user_id = u.id
  where u.id = p_usuario_id
    and p.tipo = 'admin';

  if not found then
    raise exception 'Usuario administrativo invalido.' using errcode = '42501';
  end if;

  if p_data_movimento is null then
    raise exception 'Informe a competencia do CSV.';
  end if;

  if p_data_movimento > current_date then
    raise exception 'A competencia do CSV nao pode estar no futuro.';
  end if;

  if v_arquivo_nome is null or length(v_arquivo_nome) > 255 then
    raise exception 'Informe um nome de arquivo CSV valido.';
  end if;

  if v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'Identificacao do arquivo CSV invalida.';
  end if;

  if p_linhas is null
     or jsonb_typeof(p_linhas) <> 'array'
     or jsonb_array_length(p_linhas) < 1
     or jsonb_array_length(p_linhas) > 500 then
    raise exception 'O CSV deve conter de 1 a 500 linhas completas.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_linhas) as raw(item)
    where jsonb_typeof(raw.item) <> 'object'
       or raw.item - array[
         'referencia', 'codigo_barras', 'descricao', 'quantidade_original'
       ]::text[] <> '{}'::jsonb
       or (
         raw.item ? 'referencia'
         and raw.item->'referencia' <> 'null'::jsonb
         and jsonb_typeof(raw.item->'referencia') <> 'string'
       )
       or (
         raw.item ? 'codigo_barras'
         and raw.item->'codigo_barras' <> 'null'::jsonb
         and jsonb_typeof(raw.item->'codigo_barras') <> 'string'
       )
       or (
         raw.item ? 'descricao'
         and raw.item->'descricao' <> 'null'::jsonb
         and jsonb_typeof(raw.item->'descricao') <> 'string'
       )
       or not (raw.item ? 'quantidade_original')
       or jsonb_typeof(raw.item->'quantidade_original') <> 'string'
       or length(coalesce(raw.item->>'referencia', '')) > 200
       or length(coalesce(raw.item->>'codigo_barras', '')) > 200
       or length(coalesce(raw.item->>'descricao', '')) > 1000
       or length(coalesce(raw.item->>'quantidade_original', '')) > 50
       or (
         nullif(btrim(raw.item->>'referencia'), '') is null
         and nullif(btrim(raw.item->>'codigo_barras'), '') is null
         and nullif(btrim(raw.item->>'descricao'), '') is null
       )
       or btrim(raw.item->>'quantidade_original')
          !~ '^\+?([0-9]+|[0-9]{1,3}(\.[0-9]{3})+)(,0+)?$'
  ) then
    raise exception 'O CSV contem linha incompleta, quantidade invalida ou campo inesperado.';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_linhas) as raw(item)
    where replace(
      split_part(ltrim(btrim(raw.item->>'quantidade_original'), '+'), ',', 1),
      '.', ''
    )::numeric not between 1 and 2147483647
  ) then
    raise exception 'O CSV contem quantidade fora do limite inteiro positivo.';
  end if;

  create temporary table csv_linhas_normalizadas (
    linha_ordem integer primary key,
    referencia text,
    codigo_barras text,
    descricao text,
    quantidade integer not null
  ) on commit drop;

  insert into csv_linhas_normalizadas (
    linha_ordem, referencia, codigo_barras, descricao, quantidade
  )
  select
    raw.ordem::integer,
    nullif(btrim(raw.item->>'referencia'), ''),
    nullif(btrim(raw.item->>'codigo_barras'), ''),
    nullif(btrim(raw.item->>'descricao'), ''),
    replace(
      split_part(ltrim(btrim(raw.item->>'quantidade_original'), '+'), ',', 1),
      '.', ''
    )::integer
  from jsonb_array_elements(p_linhas) with ordinality as raw(item, ordem);

  select jsonb_build_object(
    'versao', 2,
    'arquivo_nome', v_arquivo_nome,
    'arquivo_hash', v_hash,
    'competencia', p_data_movimento::text,
    'linhas', jsonb_agg(
      jsonb_build_object(
        'referencia', referencia,
        'codigo_barras', codigo_barras,
        'descricao', descricao,
        'quantidade', quantidade
      ) order by linha_ordem
    )
  )
  into v_payload
  from csv_linhas_normalizadas;

  -- A competencia e o arquivo sao serializados sempre na mesma ordem para
  -- evitar duas aplicacoes concorrentes com hashes diferentes.
  perform pg_advisory_xact_lock(
    hashtextextended('csv-competencia:' || p_data_movimento::text, 0)
  );
  perform pg_advisory_xact_lock(
    hashtextextended('csv-arquivo:' || v_hash, 0)
  );

  select *
  into v_lote
  from public.baixas_csv_lotes l
  where lower(btrim(l.arquivo_hash)) = v_hash
  for share;

  if found then
    if v_lote.validacao_versao <> 2
       or v_lote.data_movimento is distinct from p_data_movimento
       or v_lote.payload_normalizado is distinct from v_payload then
      raise exception 'O hash do CSV ja esta associado a outro fechamento ou payload.'
        using errcode = '23505';
    end if;

    return query
    select
      l.id,
      i.produto_id,
      i.produto_nome,
      i.quantidade_anterior,
      i.quantidade_nova,
      case when i.modo_aplicacao = 'baixa' then i.quantidade_csv else 0 end,
      true
    from public.baixas_csv_lotes l
    join public.baixas_csv_itens i on i.lote_id = l.id
    where l.id = v_lote.id
    order by i.produto_id;
    return;
  end if;

  if exists (
    select 1
    from public.baixas_csv_lotes l
    where l.validacao_versao >= 2
      and l.data_movimento = p_data_movimento
  ) then
    raise exception 'A competencia % ja possui CSV oficial. Arquivos corretivos exigem revisao manual auditada.',
      to_char(p_data_movimento, 'DD/MM/YYYY')
      using errcode = '23505';
  end if;

  create temporary table csv_linhas_classificadas
  on commit drop
  as
  with candidatos as (
    select
      l.linha_ordem,
      p.id as produto_id,
      coalesce(p.categoria, 'maquina') as categoria,
      p.ativo is true as produto_ativo,
      case
        when l.referencia is not null and (
          lower(btrim(coalesce(p.codigo_referencia, ''))) = lower(l.referencia)
          or lower(btrim(coalesce(p.codigo_interno, ''))) = lower(l.referencia)
          or p.id::text = lower(l.referencia)
        ) then 'Referencia'
        else 'Codigo de barras'
      end as match_by
    from csv_linhas_normalizadas l
    join public.produtos p on (
      l.referencia is not null and (
        lower(btrim(coalesce(p.codigo_referencia, ''))) = lower(l.referencia)
        or lower(btrim(coalesce(p.codigo_interno, ''))) = lower(l.referencia)
        or p.id::text = lower(l.referencia)
      )
    ) or (
      l.codigo_barras is not null and (
        lower(btrim(coalesce(p.sku, ''))) = lower(l.codigo_barras)
        or lower(btrim(coalesce(p.codigo_interno, ''))) = lower(l.codigo_barras)
        or lower(btrim(coalesce(p.codigo_referencia, ''))) = lower(l.codigo_barras)
      )
    )
  )
  select
    l.*,
    count(c.produto_id) filter (where c.categoria = 'produto')::integer
      as candidatos_produto,
    count(c.produto_id) filter (
      where c.categoria = 'produto' and c.produto_ativo
    )::integer as candidatos_produto_ativo,
    count(c.produto_id) filter (where c.categoria <> 'produto')::integer
      as candidatos_maquina,
    min(c.produto_id) filter (
      where c.categoria = 'produto' and c.produto_ativo
    )
      as produto_id,
    min(c.match_by) filter (
      where c.categoria = 'produto' and c.produto_ativo
    )
      as match_by
  from csv_linhas_normalizadas l
  left join candidatos c on c.linha_ordem = l.linha_ordem
  group by
    l.linha_ordem, l.referencia, l.codigo_barras, l.descricao, l.quantidade;

  if exists (
    select 1
    from csv_linhas_classificadas
    where candidatos_produto > 0 and candidatos_maquina > 0
  ) then
    raise exception 'O CSV contem codigo ambiguo entre produto e maquina. Corrija o cadastro antes do fechamento.';
  end if;

  if exists (
    select 1
    from csv_linhas_classificadas
    where candidatos_produto > 0 and candidatos_produto_ativo = 0
  ) then
    raise exception 'O CSV contem codigo correspondente somente a produto inativo. Nenhuma linha foi aplicada.';
  end if;

  if exists (
    select 1 from csv_linhas_classificadas where candidatos_produto_ativo > 1
  ) then
    raise exception 'O CSV contem codigo ambiguo para mais de um produto ativo. Corrija o cadastro antes do fechamento.';
  end if;

  create temporary table csv_produtos_agregados
  on commit drop
  as
  select
    c.produto_id,
    sum(c.quantidade)::bigint as quantidade,
    min(c.referencia) as referencia,
    min(c.codigo_barras) as codigo_barras,
    min(c.descricao) as descricao,
    min(c.match_by) as match_by,
    null::bigint as cobertura_id
  from csv_linhas_classificadas c
  where c.candidatos_produto_ativo = 1
    and c.candidatos_maquina = 0
  group by c.produto_id;

  if not exists (select 1 from csv_produtos_agregados) then
    raise exception 'Nenhum produto valido foi localizado no CSV.';
  end if;

  if exists (
    select 1 from csv_produtos_agregados where quantidade > 2147483647
  ) then
    raise exception 'A quantidade agregada de um produto excede o limite permitido.';
  end if;

  -- Bloqueio deterministico antes de validar saldo ou cobertura.
  perform p.id
  from public.produtos p
  join csv_produtos_agregados a on a.produto_id = p.id
  order by p.id
  for update of p;

  if exists (
    select 1
    from csv_produtos_agregados a
    join public.produtos p on p.id = a.produto_id
    where p.ativo is not true
  ) then
    raise exception 'Produto inativo nao pode receber baixa por CSV.';
  end if;

  if exists (
    select 1
    from csv_produtos_agregados a
    join public.produtos p on p.id = a.produto_id
    where coalesce(p.categoria, 'maquina') <> 'produto'
  ) then
    raise exception 'O CSV contem item que nao esta cadastrado como produto.';
  end if;

  if exists (
    select 1
    from csv_produtos_agregados a
    join public.produtos p on p.id = a.produto_id
    where p.tem_voltagem is true
  ) then
    raise exception 'Produto com voltagem nao pode ser baixado nem reconciliado automaticamente pelo CSV atual.';
  end if;

  -- Nenhuma competencia pode ser fechada enquanto houver cobertura pendente de
  -- outra competencia ou de variante que o CSV atual nao identifica. A guarda
  -- e global: o produto coberto nao precisa aparecer no novo arquivo.
  if exists (
    select 1
    from public.estoque_coberturas_csv c
    where not exists (
      select 1
      from public.estoque_cobertura_csv_eventos e
      where e.cobertura_id = c.id
    )
      and (c.competencia <> p_data_movimento or c.voltagem is not null)
  ) then
    raise exception 'Existe cobertura pendente fora da competencia ou sem variante identificavel. Revise antes de qualquer novo fechamento CSV.';
  end if;

  update csv_produtos_agregados a
  set cobertura_id = c.id
  from public.estoque_coberturas_csv c
  where c.produto_id = a.produto_id
    and c.voltagem is null
    and c.competencia = p_data_movimento
    and not exists (
      select 1
      from public.estoque_cobertura_csv_eventos e
      where e.cobertura_id = c.id
    );

  if exists (
    select 1
    from public.estoque_coberturas_csv c
    where c.competencia = p_data_movimento
      and not exists (
        select 1
        from public.estoque_cobertura_csv_eventos e
        where e.cobertura_id = c.id
      )
      and not exists (
        select 1
        from csv_produtos_agregados a
        where a.produto_id = c.produto_id
          and c.voltagem is null
      )
  ) then
    raise exception 'O CSV oficial nao contem todos os produtos com cobertura pendente desta competencia.';
  end if;

  if exists (
    select 1
    from csv_produtos_agregados a
    join public.estoque_coberturas_csv c on c.id = a.cobertura_id
    where a.quantidade <> c.quantidade_coberta
  ) then
    raise exception 'A quantidade do CSV diverge da cobertura pendente. O fechamento exige correspondencia exata.';
  end if;

  select count(*)::integer
  into v_estoque_insuficiente
  from csv_produtos_agregados a
  join public.produtos p on p.id = a.produto_id
  where a.cobertura_id is null
    and p.quantidade < a.quantidade;

  if v_estoque_insuficiente > 0 then
    raise exception 'Existe produto com estoque insuficiente. Nenhuma linha do CSV foi aplicada.';
  end if;

  select
    count(*)::integer,
    count(*) filter (
      where candidatos_produto_ativo = 1 and candidatos_maquina = 0
    )::integer,
    count(*) filter (
      where candidatos_produto = 0 and candidatos_maquina > 0
    )::integer,
    count(*) filter (
      where candidatos_produto_ativo = 0 and candidatos_maquina = 0
    )::integer,
    coalesce(sum(quantidade), 0)::integer
  into
    v_total_linhas,
    v_produtos_encontrados,
    v_maquinas_ignoradas,
    v_nao_encontrados,
    v_total_csv
  from csv_linhas_classificadas;

  insert into public.baixas_csv_lotes (
    arquivo_nome,
    aplicado_por,
    aplicado_email,
    total_linhas,
    produtos_encontrados,
    maquinas_ignoradas,
    nao_encontrados,
    estoque_insuficiente,
    total_csv,
    total_aplicado,
    data_movimento,
    arquivo_hash,
    validacao_versao,
    payload_normalizado
  ) values (
    v_arquivo_nome,
    v_usuario_id,
    coalesce(nullif(btrim(v_usuario_email), ''), v_usuario_id::text),
    v_total_linhas,
    v_produtos_encontrados,
    v_maquinas_ignoradas,
    v_nao_encontrados,
    0,
    v_total_csv,
    0,
    p_data_movimento,
    v_hash,
    2,
    v_payload
  )
  returning id into v_lote_id;

  for v_item in
    select *
    from csv_produtos_agregados
    order by produto_id
  loop
    select *
    into v_produto
    from public.produtos p
    where p.id = v_item.produto_id
    for update;

    v_anterior := coalesce(v_produto.quantidade, 0);

    if v_item.cobertura_id is null then
      v_nova := v_anterior - v_item.quantidade::integer;

      update public.produtos
      set quantidade = v_nova,
          ultima_baixa_vendedor = 'CSV PDV',
          ultima_baixa_em = clock_timestamp(),
          ultima_baixa_voltagem = null
      where id = v_produto.id;

      insert into public.historico (
        produto_id,
        quantidade_anterior,
        quantidade_nova,
        usuario,
        voltagem,
        tipo,
        vendedor
      ) values (
        v_produto.id,
        v_anterior,
        v_nova,
        coalesce(nullif(btrim(v_usuario_email), ''), v_usuario_id::text),
        null,
        'baixa_csv_produto',
        'CSV PDV'
      )
      returning id into v_historico_id;
    else
      -- A entrada posterior permanece intacta: reconciliar a cobertura registra
      -- o fechamento, mas nao altera novamente o saldo local.
      v_nova := v_anterior;

      insert into public.historico (
        produto_id,
        quantidade_anterior,
        quantidade_nova,
        usuario,
        voltagem,
        tipo,
        vendedor
      ) values (
        v_produto.id,
        v_anterior,
        v_nova,
        coalesce(nullif(btrim(v_usuario_email), ''), v_usuario_id::text),
        null,
        'reconciliacao_csv_cobertura',
        'CSV PDV'
      )
      returning id into v_historico_id;
    end if;

    insert into public.baixas_csv_itens (
      lote_id,
      produto_id,
      produto_nome,
      referencia,
      codigo_barras,
      descricao_csv,
      match_by,
      quantidade_csv,
      quantidade_anterior,
      quantidade_nova,
      modo_aplicacao,
      cobertura_id
    ) values (
      v_lote_id,
      v_produto.id,
      v_produto.nome,
      v_item.referencia,
      v_item.codigo_barras,
      v_item.descricao,
      v_item.match_by,
      v_item.quantidade::integer,
      v_anterior,
      v_nova,
      case
        when v_item.cobertura_id is null then 'baixa'
        else 'reconciliacao_cobertura'
      end,
      v_item.cobertura_id
    )
    returning id into v_lote_item_id;

    if v_item.cobertura_id is not null then
      insert into public.estoque_cobertura_csv_eventos (
        cobertura_id,
        tipo,
        lote_id,
        lote_item_id,
        quantidade_csv,
        registrado_por,
        registrado_email
      ) values (
        v_item.cobertura_id,
        'reconciliada',
        v_lote_id,
        v_lote_item_id,
        v_item.quantidade::integer,
        v_usuario_id,
        coalesce(nullif(btrim(v_usuario_email), ''), v_usuario_id::text)
      );
    end if;

    v_total_aplicado := v_total_aplicado + v_item.quantidade::integer;

    lote_id := v_lote_id;
    produto_id := v_produto.id;
    produto_nome := v_produto.nome;
    quantidade_anterior := v_anterior;
    quantidade_nova := v_nova;
    quantidade_baixada := case
      when v_item.cobertura_id is null then v_item.quantidade::integer
      else 0
    end;
    repetida := false;
    return next;
  end loop;

  update public.baixas_csv_lotes
  set total_aplicado = v_total_aplicado
  where id = v_lote_id;
end;
$$;

revoke all on function public.registrar_fechamento_csv_produtos(jsonb, text, text, date, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.registrar_fechamento_csv_produtos(jsonb, text, text, date, uuid)
  to service_role;

comment on table public.estoque_coberturas_csv is
  'Fundacao imutavel para coberturas futuras de zeragem por venda aguardando CSV; a migration 36 nao cria coberturas.';
comment on table public.estoque_cobertura_csv_eventos is
  'Auditoria imutavel da reconciliacao exata entre cobertura e CSV oficial da mesma competencia.';
comment on function public.registrar_fechamento_csv_produtos(jsonb, text, text, date, uuid) is
  'Fronteira CSV exclusiva de service_role: revalida o admin informado, deriva sua identidade do banco, valida linhas completas e aplica ou reconcilia atomicamente sem Nuvemshop.';

notify pgrst, 'reload schema';

commit;
