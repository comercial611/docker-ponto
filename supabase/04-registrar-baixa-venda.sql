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
    raise exception 'Usuário não autenticado.';
  end if;

  select public.usuario_tipo()
  into v_tipo;

  if v_tipo not in ('admin', 'vendedor') then
    raise exception 'Usuário sem permissão para registrar baixa de venda.';
  end if;

  if p_quantidade is null or p_quantidade <= 0 then
    raise exception 'Quantidade inválida.';
  end if;

  select *
  into v_produto
  from public.produtos
  where id = p_produto_id
  for update;

  if not found then
    raise exception 'Produto não encontrado.';
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
      set
        quantidade_110v = v_quantidade_nova,
        ultima_baixa_vendedor = v_nome_vendedor,
        ultima_baixa_em = now(),
        ultima_baixa_voltagem = '110v'
      where id = p_produto_id;

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
        p_produto_id,
        v_quantidade_anterior,
        v_quantidade_nova,
        auth.email(),
        '110v',
        'baixa',
        v_nome_vendedor
      );

    elsif v_voltagem_normalizada in ('220', '220v') then
      v_quantidade_anterior := v_produto.quantidade_220v;
      v_quantidade_nova := v_produto.quantidade_220v - p_quantidade;

      if v_quantidade_nova < 0 then
        raise exception 'Estoque insuficiente para 220v.';
      end if;

      update public.produtos
      set
        quantidade_220v = v_quantidade_nova,
        ultima_baixa_vendedor = v_nome_vendedor,
        ultima_baixa_em = now(),
        ultima_baixa_voltagem = '220v'
      where id = p_produto_id;

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
        p_produto_id,
        v_quantidade_anterior,
        v_quantidade_nova,
        auth.email(),
        '220v',
        'baixa',
        v_nome_vendedor
      );

    else
      raise exception 'Voltagem obrigatória para este produto.';
    end if;

  else
    v_quantidade_anterior := v_produto.quantidade;
    v_quantidade_nova := v_produto.quantidade - p_quantidade;

    if v_quantidade_nova < 0 then
      raise exception 'Estoque insuficiente.';
    end if;

    update public.produtos
    set
      quantidade = v_quantidade_nova,
      ultima_baixa_vendedor = v_nome_vendedor,
      ultima_baixa_em = now(),
      ultima_baixa_voltagem = null
    where id = p_produto_id;

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
      p_produto_id,
      v_quantidade_anterior,
      v_quantidade_nova,
      auth.email(),
      null,
      'baixa',
      v_nome_vendedor
    );
  end if;

  return query
  select
    p.id,
    p.quantidade,
    p.quantidade_110v,
    p.quantidade_220v
  from public.produtos p
  where p.id = p_produto_id;
end;
$$;

grant execute on function public.registrar_baixa_venda(integer, integer, text) to authenticated;