begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

alter table public.produtos
  add column if not exists ativo boolean not null default true;

create table if not exists public.produto_status_eventos (
  id bigserial primary key,
  produto_id integer not null
    references public.produtos(id) on delete restrict,
  ativo boolean not null,
  motivo text,
  alterado_por uuid
    references auth.users(id) on delete set null,
  created_at timestamp with time zone not null default now(),
  constraint produto_status_eventos_motivo_check
    check (ativo or nullif(btrim(motivo), '') is not null)
);

create index if not exists produto_status_eventos_produto_created_idx
on public.produto_status_eventos (produto_id, created_at desc);

alter table public.produto_status_eventos enable row level security;

revoke all on public.produto_status_eventos from public, anon, authenticated;
grant select on public.produto_status_eventos to authenticated;

drop policy if exists "Produto status: admin pode ler"
on public.produto_status_eventos;

create policy "Produto status: admin pode ler"
on public.produto_status_eventos
for select
to authenticated
using (public.eh_admin());

create or replace function public.proteger_estado_produto()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if not new.ativo then
      raise exception 'Produto deve ser criado ativo.'
        using errcode = '23514';
    end if;
    return new;
  end if;

  if new.ativo is distinct from old.ativo then
    if not new.ativo
       and (
         coalesce(new.quantidade, 0) > 0
         or coalesce(new.quantidade_110v, 0) > 0
         or coalesce(new.quantidade_220v, 0) > 0
       ) then
      raise exception 'Produto com estoque positivo nao pode ser inativado.'
        using errcode = '23514';
    end if;

    if current_setting('app.alterar_status_produto', true)
       is distinct from 'permitido' then
      raise exception 'Altere o status do produto somente pela funcao segura.'
        using errcode = '42501';
    end if;
  end if;

  if not old.ativo
     and (
       new.quantidade is distinct from old.quantidade
       or new.quantidade_110v is distinct from old.quantidade_110v
       or new.quantidade_220v is distinct from old.quantidade_220v
     ) then
    raise exception 'Produto inativo nao pode ter o estoque alterado.'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function public.proteger_estado_produto()
from public, anon, authenticated;

drop trigger if exists proteger_estado_produto on public.produtos;

create trigger proteger_estado_produto
before insert or update of
  ativo,
  quantidade,
  quantidade_110v,
  quantidade_220v
on public.produtos
for each row execute function public.proteger_estado_produto();

create or replace function public.alterar_status_produto(
  p_produto_id integer,
  p_ativo boolean,
  p_motivo text default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_produto public.produtos%rowtype;
  v_motivo text := nullif(btrim(p_motivo), '');
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.'
      using errcode = '42501';
  end if;

  if not public.eh_admin() then
    raise exception 'Somente admin pode alterar o status do produto.'
      using errcode = '42501';
  end if;

  if p_produto_id is null or p_ativo is null then
    raise exception 'Produto e estado desejado sao obrigatorios.';
  end if;

  select *
    into v_produto
  from public.produtos
  where id = p_produto_id
  for update;

  if not found then
    raise exception 'Produto nao encontrado.';
  end if;

  if v_produto.ativo is not distinct from p_ativo then
    return false;
  end if;

  if not p_ativo then
    if v_motivo is null then
      raise exception 'Informe o motivo da inativacao.';
    end if;

    if coalesce(v_produto.quantidade, 0) > 0
       or coalesce(v_produto.quantidade_110v, 0) > 0
       or coalesce(v_produto.quantidade_220v, 0) > 0 then
      raise exception 'Produto com estoque positivo nao pode ser inativado.';
    end if;

    if exists (
      select 1
      from public.nuvemshop_vinculos v
      where v.produto_id = p_produto_id
        and v.ativo
    ) then
      raise exception 'Produto possui vinculo Nuvemshop ativo. Zere o estoque externo antes de inativar.';
    end if;
  end if;

  perform set_config('app.alterar_status_produto', 'permitido', true);

  update public.produtos
  set ativo = p_ativo
  where id = p_produto_id;

  insert into public.produto_status_eventos (
    produto_id,
    ativo,
    motivo,
    alterado_por
  )
  values (
    p_produto_id,
    p_ativo,
    v_motivo,
    auth.uid()
  );

  return true;
end;
$$;

revoke all on function public.alterar_status_produto(integer, boolean, text)
from public, anon, authenticated;
grant execute on function public.alterar_status_produto(integer, boolean, text)
to authenticated;

create or replace function public.validar_vinculo_nuvemshop()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tem_voltagem boolean;
  v_produto_ativo boolean;
begin
  select tem_voltagem, ativo
    into v_tem_voltagem, v_produto_ativo
  from public.produtos
  where id = new.produto_id
  for key share;

  if not found then
    raise exception 'Produto local nao encontrado.';
  end if;

  if not v_produto_ativo
     and (
       (tg_op = 'INSERT' and coalesce(new.ativo, false))
       or (
         tg_op = 'UPDATE'
         and (
           new.produto_id is distinct from old.produto_id
           or (coalesce(new.ativo, false) and not coalesce(old.ativo, false))
         )
       )
     ) then
    raise exception 'Produto inativo nao pode receber vinculo Nuvemshop ativo.';
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

revoke all on function public.validar_vinculo_nuvemshop()
from public, anon, authenticated;

create or replace function public.registrar_baixa_venda(
  p_produto_id integer,
  p_quantidade integer,
  p_voltagem text default null
)
returns table (
  produto_id integer,
  quantidade integer,
  quantidade_110v integer,
  quantidade_220v integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_produto public.produtos%rowtype;
  v_tipo text;
  v_nome_vendedor text;
  v_quantidade_anterior integer;
  v_quantidade_nova integer;
  v_voltagem_normalizada text;
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  select public.usuario_tipo() into v_tipo;

  if v_tipo not in ('admin', 'vendedor') then
    raise exception 'Usuario sem permissao para registrar baixa de venda.';
  end if;

  if p_quantidade is null or p_quantidade <= 0 then
    raise exception 'Quantidade invalida.';
  end if;

  select * into v_produto
  from public.produtos
  where id = p_produto_id
  for update;

  if not found then
    raise exception 'Produto nao encontrado.';
  end if;

  if not v_produto.ativo then
    raise exception 'Produto inativo nao pode receber baixa de venda.';
  end if;

  if coalesce(v_produto.categoria, 'maquina') <> 'maquina' then
    raise exception 'Produtos devem ser baixados pelo CSV ou pela baixa manual com senha.';
  end if;

  select coalesce(v.nome, p.nome, auth.email())
    into v_nome_vendedor
  from public.perfis p
  left join public.vendedores v on v.auth_user_id = p.user_id
  where p.user_id = auth.uid();

  v_voltagem_normalizada := lower(coalesce(p_voltagem, ''));

  if v_produto.tem_voltagem then
    if v_voltagem_normalizada in ('110', '110v') then
      v_quantidade_anterior := v_produto.quantidade_110v;
      v_quantidade_nova := v_produto.quantidade_110v - p_quantidade;
      if v_quantidade_nova < 0 then
        raise exception 'Estoque insuficiente para 110v.';
      end if;
      update public.produtos
      set quantidade_110v = v_quantidade_nova,
          ultima_baixa_vendedor = v_nome_vendedor,
          ultima_baixa_em = now(),
          ultima_baixa_voltagem = '110v'
      where id = p_produto_id;
      insert into public.historico (
        produto_id, quantidade_anterior, quantidade_nova,
        usuario, voltagem, tipo, vendedor
      ) values (
        p_produto_id, v_quantidade_anterior, v_quantidade_nova,
        auth.email(), '110v', 'baixa', v_nome_vendedor
      );
    elsif v_voltagem_normalizada in ('220', '220v') then
      v_quantidade_anterior := v_produto.quantidade_220v;
      v_quantidade_nova := v_produto.quantidade_220v - p_quantidade;
      if v_quantidade_nova < 0 then
        raise exception 'Estoque insuficiente para 220v.';
      end if;
      update public.produtos
      set quantidade_220v = v_quantidade_nova,
          ultima_baixa_vendedor = v_nome_vendedor,
          ultima_baixa_em = now(),
          ultima_baixa_voltagem = '220v'
      where id = p_produto_id;
      insert into public.historico (
        produto_id, quantidade_anterior, quantidade_nova,
        usuario, voltagem, tipo, vendedor
      ) values (
        p_produto_id, v_quantidade_anterior, v_quantidade_nova,
        auth.email(), '220v', 'baixa', v_nome_vendedor
      );
    else
      raise exception 'Voltagem obrigatoria para este produto.';
    end if;
  else
    v_quantidade_anterior := v_produto.quantidade;
    v_quantidade_nova := v_produto.quantidade - p_quantidade;
    if v_quantidade_nova < 0 then
      raise exception 'Estoque insuficiente.';
    end if;
    update public.produtos
    set quantidade = v_quantidade_nova,
        ultima_baixa_vendedor = v_nome_vendedor,
        ultima_baixa_em = now(),
        ultima_baixa_voltagem = null
    where id = p_produto_id;
    insert into public.historico (
      produto_id, quantidade_anterior, quantidade_nova,
      usuario, voltagem, tipo, vendedor
    ) values (
      p_produto_id, v_quantidade_anterior, v_quantidade_nova,
      auth.email(), null, 'baixa', v_nome_vendedor
    );
  end if;

  return query
  select p.id, p.quantidade, p.quantidade_110v, p.quantidade_220v
  from public.produtos p
  where p.id = p_produto_id;
end;
$$;

create or replace function public.registrar_baixa_produto_manual(
  p_produto_id integer,
  p_quantidade integer,
  p_senha text,
  p_voltagem text default null
)
returns table (
  produto_id integer,
  quantidade integer,
  quantidade_110v integer,
  quantidade_220v integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_produto public.produtos%rowtype;
  v_tipo text;
  v_senha text;
  v_nome_vendedor text;
  v_quantidade_anterior integer;
  v_quantidade_nova integer;
  v_voltagem_normalizada text;
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  select public.usuario_tipo() into v_tipo;

  if v_tipo not in ('admin', 'vendedor') then
    raise exception 'Usuario sem permissao para registrar baixa manual de produto.';
  end if;

  if p_quantidade is null or p_quantidade <= 0 then
    raise exception 'Quantidade invalida.';
  end if;

  select valor into v_senha
  from public.configuracoes_sistema
  where chave = 'senha_baixa_produto';

  if v_senha is null or v_senha = 'TROQUE-ESTA-SENHA' then
    raise exception 'Senha de baixa manual de produto nao configurada.';
  end if;

  if p_senha is null or p_senha <> v_senha then
    raise exception 'Senha de autorizacao invalida.';
  end if;

  select * into v_produto
  from public.produtos
  where id = p_produto_id
  for update;

  if not found then
    raise exception 'Produto nao encontrado.';
  end if;

  if not v_produto.ativo then
    raise exception 'Produto inativo nao pode receber baixa manual.';
  end if;

  if coalesce(v_produto.categoria, 'maquina') <> 'produto' then
    raise exception 'Esta funcao e exclusiva para baixa manual de produtos.';
  end if;

  select coalesce(v.nome, p.nome, auth.email())
    into v_nome_vendedor
  from public.perfis p
  left join public.vendedores v on v.auth_user_id = p.user_id
  where p.user_id = auth.uid();

  v_voltagem_normalizada := lower(coalesce(p_voltagem, ''));

  if v_produto.tem_voltagem then
    if v_voltagem_normalizada in ('110', '110v') then
      v_quantidade_anterior := v_produto.quantidade_110v;
      v_quantidade_nova := v_produto.quantidade_110v - p_quantidade;
      if v_quantidade_nova < 0 then
        raise exception 'Estoque insuficiente para 110v.';
      end if;
      update public.produtos
      set quantidade_110v = v_quantidade_nova,
          ultima_baixa_vendedor = v_nome_vendedor,
          ultima_baixa_em = now(),
          ultima_baixa_voltagem = '110v'
      where id = p_produto_id;
      insert into public.historico (
        produto_id, quantidade_anterior, quantidade_nova,
        usuario, voltagem, tipo, vendedor
      ) values (
        p_produto_id, v_quantidade_anterior, v_quantidade_nova,
        auth.email(), '110v', 'baixa_manual_produto', v_nome_vendedor
      );
    elsif v_voltagem_normalizada in ('220', '220v') then
      v_quantidade_anterior := v_produto.quantidade_220v;
      v_quantidade_nova := v_produto.quantidade_220v - p_quantidade;
      if v_quantidade_nova < 0 then
        raise exception 'Estoque insuficiente para 220v.';
      end if;
      update public.produtos
      set quantidade_220v = v_quantidade_nova,
          ultima_baixa_vendedor = v_nome_vendedor,
          ultima_baixa_em = now(),
          ultima_baixa_voltagem = '220v'
      where id = p_produto_id;
      insert into public.historico (
        produto_id, quantidade_anterior, quantidade_nova,
        usuario, voltagem, tipo, vendedor
      ) values (
        p_produto_id, v_quantidade_anterior, v_quantidade_nova,
        auth.email(), '220v', 'baixa_manual_produto', v_nome_vendedor
      );
    else
      raise exception 'Voltagem obrigatoria para este produto.';
    end if;
  else
    v_quantidade_anterior := v_produto.quantidade;
    v_quantidade_nova := v_produto.quantidade - p_quantidade;
    if v_quantidade_nova < 0 then
      raise exception 'Estoque insuficiente.';
    end if;
    update public.produtos
    set quantidade = v_quantidade_nova,
        ultima_baixa_vendedor = v_nome_vendedor,
        ultima_baixa_em = now(),
        ultima_baixa_voltagem = null
    where id = p_produto_id;
    insert into public.historico (
      produto_id, quantidade_anterior, quantidade_nova,
      usuario, voltagem, tipo, vendedor
    ) values (
      p_produto_id, v_quantidade_anterior, v_quantidade_nova,
      auth.email(), null, 'baixa_manual_produto', v_nome_vendedor
    );
  end if;

  return query
  select p.id, p.quantidade, p.quantidade_110v, p.quantidade_220v
  from public.produtos p
  where p.id = p_produto_id;
end;
$$;

create or replace function public.registrar_contagem_estoque(
  p_produto_id integer,
  p_quantidade integer,
  p_voltagem text default null
)
returns table (
  produto_id integer,
  quantidade integer,
  quantidade_110v integer,
  quantidade_220v integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_produto public.produtos%rowtype;
  v_tipo text;
  v_quantidade_anterior integer;
  v_voltagem_normalizada text;
begin
  if auth.uid() is null then
    raise exception 'Usuário não autenticado.';
  end if;

  select public.usuario_tipo() into v_tipo;

  if v_tipo not in ('admin', 'funcionario') then
    raise exception 'Usuário sem permissão para registrar contagem de estoque.';
  end if;

  if p_quantidade is null or p_quantidade < 0 then
    raise exception 'Quantidade inválida.';
  end if;

  select * into v_produto
  from public.produtos
  where id = p_produto_id
  for update;

  if not found then
    raise exception 'Produto não encontrado.';
  end if;

  if not v_produto.ativo then
    raise exception 'Produto inativo nao pode receber contagem de estoque.';
  end if;

  v_voltagem_normalizada := lower(coalesce(p_voltagem, ''));

  if v_produto.tem_voltagem then
    if v_voltagem_normalizada in ('110', '110v') then
      v_quantidade_anterior := v_produto.quantidade_110v;
      update public.produtos
      set quantidade_110v = p_quantidade
      where id = p_produto_id;
      insert into public.historico (
        produto_id, quantidade_anterior, quantidade_nova,
        usuario, voltagem, tipo
      ) values (
        p_produto_id, v_quantidade_anterior, p_quantidade,
        auth.email(), '110v', 'contagem'
      );
    elsif v_voltagem_normalizada in ('220', '220v') then
      v_quantidade_anterior := v_produto.quantidade_220v;
      update public.produtos
      set quantidade_220v = p_quantidade
      where id = p_produto_id;
      insert into public.historico (
        produto_id, quantidade_anterior, quantidade_nova,
        usuario, voltagem, tipo
      ) values (
        p_produto_id, v_quantidade_anterior, p_quantidade,
        auth.email(), '220v', 'contagem'
      );
    else
      raise exception 'Voltagem obrigatória para este produto.';
    end if;
  else
    v_quantidade_anterior := v_produto.quantidade;
    update public.produtos
    set quantidade = p_quantidade
    where id = p_produto_id;
    insert into public.historico (
      produto_id, quantidade_anterior, quantidade_nova,
      usuario, voltagem, tipo
    ) values (
      p_produto_id, v_quantidade_anterior, p_quantidade,
      auth.email(), null, 'contagem'
    );
  end if;

  return query
  select p.id, p.quantidade, p.quantidade_110v, p.quantidade_220v
  from public.produtos p
  where p.id = p_produto_id;
end;
$$;

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
set search_path = public
as $$
declare
  v_tipo text;
  v_item jsonb;
  v_produto public.produtos%rowtype;
  v_produto_id integer;
  v_quantidade integer;
  v_quantidade_nova integer;
  v_lote_id bigint;
  v_total_aplicado integer := 0;
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  select public.usuario_tipo() into v_tipo;
  if v_tipo <> 'admin' then
    raise exception 'Somente admin pode aplicar baixa por CSV.';
  end if;

  if p_itens is null
     or jsonb_typeof(p_itens) <> 'array'
     or jsonb_array_length(p_itens) = 0 then
    raise exception 'Nenhum item valido para baixa.';
  end if;

  if jsonb_array_length(p_itens) > 500 then
    raise exception 'CSV muito grande. Aplique no maximo 500 itens por vez.';
  end if;

  insert into public.baixas_csv_lotes (
    arquivo_nome, aplicado_por, aplicado_email, total_linhas,
    produtos_encontrados, maquinas_ignoradas, nao_encontrados,
    estoque_insuficiente, total_csv
  ) values (
    nullif(trim(p_arquivo_nome), ''),
    auth.uid(),
    auth.email(),
    coalesce((p_resumo->>'total_linhas')::integer, jsonb_array_length(p_itens)),
    coalesce((p_resumo->>'produtos_encontrados')::integer, jsonb_array_length(p_itens)),
    coalesce((p_resumo->>'maquinas_ignoradas')::integer, 0),
    coalesce((p_resumo->>'nao_encontrados')::integer, 0),
    coalesce((p_resumo->>'estoque_insuficiente')::integer, 0),
    coalesce((p_resumo->>'total_csv')::integer, 0)
  )
  returning id into v_lote_id;

  for v_item in select value from jsonb_array_elements(p_itens)
  loop
    v_produto_id := nullif(v_item->>'produto_id', '')::integer;
    v_quantidade := nullif(v_item->>'quantidade', '')::integer;

    if v_produto_id is null then
      raise exception 'Item sem produto_id.';
    end if;
    if v_quantidade is null or v_quantidade <= 0 then
      raise exception 'Quantidade invalida no produto %.', v_produto_id;
    end if;

    select * into v_produto
    from public.produtos
    where id = v_produto_id
    for update;

    if not found then
      raise exception 'Produto % nao encontrado.', v_produto_id;
    end if;
    if not v_produto.ativo then
      raise exception 'Produto inativo nao pode receber baixa por CSV: %.', v_produto.nome;
    end if;
    if coalesce(v_produto.categoria, 'maquina') <> 'produto' then
      raise exception 'O item % nao esta cadastrado como produto.', v_produto.nome;
    end if;
    if v_produto.tem_voltagem then
      raise exception 'Produto com voltagem nao pode ser baixado por CSV: %.', v_produto.nome;
    end if;

    v_quantidade_nova := v_produto.quantidade - v_quantidade;
    if v_quantidade_nova < 0 then
      raise exception 'Estoque insuficiente para %.', v_produto.nome;
    end if;

    update public.produtos
    set quantidade = v_quantidade_nova,
        ultima_baixa_vendedor = 'CSV PDV',
        ultima_baixa_em = now(),
        ultima_baixa_voltagem = null
    where id = v_produto_id;

    insert into public.historico (
      produto_id, quantidade_anterior, quantidade_nova,
      usuario, voltagem, tipo, vendedor
    ) values (
      v_produto_id, v_produto.quantidade, v_quantidade_nova,
      auth.email(), null, 'baixa_csv_produto', 'CSV PDV'
    );

    insert into public.baixas_csv_itens (
      lote_id, produto_id, produto_nome, referencia, codigo_barras,
      descricao_csv, match_by, quantidade_csv,
      quantidade_anterior, quantidade_nova
    ) values (
      v_lote_id,
      v_produto_id,
      v_produto.nome,
      nullif(v_item->>'referencia', ''),
      nullif(v_item->>'codigo_barras', ''),
      nullif(v_item->>'descricao', ''),
      nullif(v_item->>'match_by', ''),
      v_quantidade,
      v_produto.quantidade,
      v_quantidade_nova
    );

    lote_id := v_lote_id;
    produto_id := v_produto_id;
    produto_nome := v_produto.nome;
    quantidade_anterior := v_produto.quantidade;
    quantidade_nova := v_quantidade_nova;
    quantidade_baixada := v_quantidade;
    v_total_aplicado := v_total_aplicado + v_quantidade;
    return next;
  end loop;

  if v_total_aplicado = 0 then
    raise exception 'Nenhum produto aplicado.';
  end if;

  update public.baixas_csv_lotes
  set total_aplicado = v_total_aplicado
  where id = v_lote_id;
end;
$$;

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
  set data_movimento = p_data_movimento,
      arquivo_hash = v_hash
  where id = v_lote_id;
end;
$$;

grant execute on function public.registrar_baixa_venda(integer, integer, text)
to authenticated;
grant execute on function public.registrar_baixa_produto_manual(integer, integer, text, text)
to authenticated;
grant execute on function public.registrar_contagem_estoque(integer, integer, text)
to authenticated;
grant execute on function public.registrar_baixa_csv_produtos(jsonb, text, jsonb)
to authenticated;
revoke all on function public.registrar_fechamento_csv_produtos(jsonb, text, jsonb, text, date)
from public;
grant execute on function public.registrar_fechamento_csv_produtos(jsonb, text, jsonb, text, date)
to authenticated;

comment on column public.produtos.ativo is
  'Define se o produto pode participar dos fluxos operacionais do ERP.';
comment on table public.produto_status_eventos is
  'Auditoria administrativa protegida das alteracoes de estado dos produtos.';

notify pgrst, 'reload schema';

commit;
