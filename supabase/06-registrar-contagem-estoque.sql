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

  select public.usuario_tipo()
  into v_tipo;

  if v_tipo not in ('admin', 'funcionario') then
    raise exception 'Usuário sem permissão para registrar contagem de estoque.';
  end if;

  if p_quantidade is null or p_quantidade < 0 then
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

  v_voltagem_normalizada := lower(coalesce(p_voltagem, ''));

  if v_produto.tem_voltagem then
    if v_voltagem_normalizada in ('110', '110v') then
      v_quantidade_anterior := v_produto.quantidade_110v;

      update public.produtos
      set quantidade_110v = p_quantidade
      where id = p_produto_id;

      insert into public.historico (
        produto_id,
        quantidade_anterior,
        quantidade_nova,
        usuario,
        voltagem,
        tipo
      )
      values (
        p_produto_id,
        v_quantidade_anterior,
        p_quantidade,
        auth.email(),
        '110v',
        'contagem'
      );

    elsif v_voltagem_normalizada in ('220', '220v') then
      v_quantidade_anterior := v_produto.quantidade_220v;

      update public.produtos
      set quantidade_220v = p_quantidade
      where id = p_produto_id;

      insert into public.historico (
        produto_id,
        quantidade_anterior,
        quantidade_nova,
        usuario,
        voltagem,
        tipo
      )
      values (
        p_produto_id,
        v_quantidade_anterior,
        p_quantidade,
        auth.email(),
        '220v',
        'contagem'
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
      produto_id,
      quantidade_anterior,
      quantidade_nova,
      usuario,
      voltagem,
      tipo
    )
    values (
      p_produto_id,
      v_quantidade_anterior,
      p_quantidade,
      auth.email(),
      null,
      'contagem'
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

grant execute on function public.registrar_contagem_estoque(integer, integer, text) to authenticated;