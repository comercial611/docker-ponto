create or replace function public.registrar_baixa_csv_produtos(
  p_itens jsonb
)
returns table (
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
  v_total integer := 0;
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

    produto_id := v_produto_id;
    produto_nome := v_produto.nome;
    quantidade_anterior := v_produto.quantidade;
    quantidade_nova := v_quantidade_nova;
    quantidade_baixada := v_quantidade;
    v_total := v_total + 1;
    return next;
  end loop;

  if v_total = 0 then
    raise exception 'Nenhum produto aplicado.';
  end if;
end;
$$;

grant execute on function public.registrar_baixa_csv_produtos(jsonb) to authenticated;
