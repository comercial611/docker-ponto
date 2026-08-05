-- Baixa administrativa atomica: atualiza o estoque e grava o historico na mesma transacao.
create or replace function public.registrar_baixa_administrativa(
  p_produto_id integer,
  p_quantidade integer,
  p_vendedor text,
  p_voltagem text default null
)
returns table (
  produto_id integer,
  quantidade integer,
  quantidade_110v integer,
  quantidade_220v integer,
  historico_id integer,
  quantidade_anterior integer,
  quantidade_nova integer,
  usuario text,
  vendedor text,
  voltagem text,
  tipo text,
  created_at timestamp with time zone
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_produto public.produtos%rowtype;
  v_quantidade_anterior integer;
  v_quantidade_nova integer;
  v_voltagem_normalizada text;
  v_voltagem_registrada text;
  v_historico_id integer;
  v_historico_created_at timestamp with time zone;
begin
  if auth.uid() is null then
    raise exception 'Autenticacao necessaria.';
  end if;

  if not public.eh_admin() then
    raise exception 'Somente administradores podem registrar baixa administrativa.';
  end if;

  if p_quantidade is null or p_quantidade <= 0 then
    raise exception 'Informe uma quantidade valida.';
  end if;

  if coalesce(trim(p_vendedor), '') = '' then
    raise exception 'Selecione o vendedor responsavel.';
  end if;

  select *
    into v_produto
    from public.produtos
   where id = p_produto_id
   for update;

  if not found then
    raise exception 'Produto nao encontrado.';
  end if;

  v_voltagem_normalizada := lower(trim(coalesce(p_voltagem, '')));

  if v_produto.tem_voltagem then
    if v_voltagem_normalizada in ('110', '110v') then
      v_quantidade_anterior := v_produto.quantidade_110v;
      v_quantidade_nova := v_quantidade_anterior - p_quantidade;

      if v_quantidade_nova < 0 then
        raise exception 'Quantidade maior que o estoque disponivel (%).', v_quantidade_anterior;
      end if;

      v_voltagem_registrada := '110v';

      update public.produtos
         set quantidade_110v = v_quantidade_nova,
             ultima_baixa_vendedor = trim(p_vendedor),
             ultima_baixa_em = now(),
             ultima_baixa_voltagem = v_voltagem_registrada
       where id = v_produto.id
       returning * into v_produto;
    elsif v_voltagem_normalizada in ('220', '220v') then
      v_quantidade_anterior := v_produto.quantidade_220v;
      v_quantidade_nova := v_quantidade_anterior - p_quantidade;

      if v_quantidade_nova < 0 then
        raise exception 'Quantidade maior que o estoque disponivel (%).', v_quantidade_anterior;
      end if;

      v_voltagem_registrada := '220v';

      update public.produtos
         set quantidade_220v = v_quantidade_nova,
             ultima_baixa_vendedor = trim(p_vendedor),
             ultima_baixa_em = now(),
             ultima_baixa_voltagem = v_voltagem_registrada
       where id = v_produto.id
       returning * into v_produto;
    else
      raise exception 'Selecione uma voltagem valida.';
    end if;
  else
    v_quantidade_anterior := v_produto.quantidade;
    v_quantidade_nova := v_quantidade_anterior - p_quantidade;

    if v_quantidade_nova < 0 then
      raise exception 'Quantidade maior que o estoque disponivel (%).', v_quantidade_anterior;
    end if;

    v_voltagem_registrada := null;

    update public.produtos
       set quantidade = v_quantidade_nova,
           ultima_baixa_vendedor = trim(p_vendedor),
           ultima_baixa_em = now(),
           ultima_baixa_voltagem = null
     where id = v_produto.id
     returning * into v_produto;
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
    v_quantidade_nova,
    trim(p_vendedor),
    trim(p_vendedor),
    v_voltagem_registrada,
    'baixa'
  )
  returning id, created_at into v_historico_id, v_historico_created_at;

  return query
  select
    v_produto.id,
    v_produto.quantidade,
    v_produto.quantidade_110v,
    v_produto.quantidade_220v,
    v_historico_id,
    v_quantidade_anterior,
    v_quantidade_nova,
    trim(p_vendedor),
    trim(p_vendedor),
    v_voltagem_registrada,
    'baixa'::text,
    v_historico_created_at;
end;
$$;

revoke all on function public.registrar_baixa_administrativa(integer, integer, text, text) from public;
grant execute on function public.registrar_baixa_administrativa(integer, integer, text, text) to authenticated;
