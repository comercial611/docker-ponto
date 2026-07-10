begin;

create table if not exists public.baixas_csv_lotes (
  id bigserial primary key,
  arquivo_nome text,
  aplicado_por uuid,
  aplicado_email text,
  total_linhas integer not null default 0,
  produtos_encontrados integer not null default 0,
  maquinas_ignoradas integer not null default 0,
  nao_encontrados integer not null default 0,
  estoque_insuficiente integer not null default 0,
  total_csv integer not null default 0,
  total_aplicado integer not null default 0,
  created_at timestamp with time zone not null default now()
);

create table if not exists public.baixas_csv_itens (
  id bigserial primary key,
  lote_id bigint not null references public.baixas_csv_lotes(id) on delete cascade,
  produto_id integer references public.produtos(id),
  produto_nome text not null,
  referencia text,
  codigo_barras text,
  descricao_csv text,
  match_by text,
  quantidade_csv integer not null,
  quantidade_anterior integer not null,
  quantidade_nova integer not null,
  created_at timestamp with time zone not null default now()
);

alter table public.baixas_csv_lotes enable row level security;
alter table public.baixas_csv_itens enable row level security;

revoke all on public.baixas_csv_lotes from anon;
revoke all on public.baixas_csv_itens from anon;
revoke all on public.baixas_csv_lotes from authenticated;
revoke all on public.baixas_csv_itens from authenticated;

grant select on public.baixas_csv_lotes to authenticated;
grant select on public.baixas_csv_itens to authenticated;

drop policy if exists "Baixas CSV: admin pode ler lotes" on public.baixas_csv_lotes;
drop policy if exists "Baixas CSV: admin pode ler itens" on public.baixas_csv_itens;

create policy "Baixas CSV: admin pode ler lotes"
on public.baixas_csv_lotes
for select
to authenticated
using (public.eh_admin());

create policy "Baixas CSV: admin pode ler itens"
on public.baixas_csv_itens
for select
to authenticated
using (public.eh_admin());

drop function if exists public.registrar_baixa_csv_produtos(jsonb);

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

  select public.usuario_tipo()
  into v_tipo;

  if v_tipo <> 'admin' then
    raise exception 'Somente admin pode aplicar baixa por CSV.';
  end if;

  if p_itens is null or jsonb_typeof(p_itens) <> 'array' or jsonb_array_length(p_itens) = 0 then
    raise exception 'Nenhum item valido para baixa.';
  end if;

  if jsonb_array_length(p_itens) > 500 then
    raise exception 'CSV muito grande. Aplique no maximo 500 itens por vez.';
  end if;

  insert into public.baixas_csv_lotes (
    arquivo_nome,
    aplicado_por,
    aplicado_email,
    total_linhas,
    produtos_encontrados,
    maquinas_ignoradas,
    nao_encontrados,
    estoque_insuficiente,
    total_csv
  )
  values (
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

  for v_item in
    select value from jsonb_array_elements(p_itens)
  loop
    v_produto_id := nullif(v_item->>'produto_id', '')::integer;
    v_quantidade := nullif(v_item->>'quantidade', '')::integer;

    if v_produto_id is null then
      raise exception 'Item sem produto_id.';
    end if;

    if v_quantidade is null or v_quantidade <= 0 then
      raise exception 'Quantidade invalida no produto %.', v_produto_id;
    end if;

    select *
    into v_produto
    from public.produtos
    where id = v_produto_id
    for update;

    if not found then
      raise exception 'Produto % nao encontrado.', v_produto_id;
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
    set
      quantidade = v_quantidade_nova,
      ultima_baixa_vendedor = 'CSV PDV',
      ultima_baixa_em = now(),
      ultima_baixa_voltagem = null
    where id = v_produto_id;

    insert into public.historico (
      produto_id,
      quantidade_anterior,
      quantidade_nova,
      usuario,
      voltagem,
      tipo,
      vendedor
    )
    values (
      v_produto_id,
      v_produto.quantidade,
      v_quantidade_nova,
      auth.email(),
      null,
      'baixa_csv_produto',
      'CSV PDV'
    );

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
      quantidade_nova
    )
    values (
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

grant execute on function public.registrar_baixa_csv_produtos(jsonb, text, jsonb) to authenticated;

notify pgrst, 'reload schema';

commit;
