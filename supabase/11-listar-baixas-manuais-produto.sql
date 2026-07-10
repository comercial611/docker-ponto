create or replace function public.listar_minhas_baixas_vendedor(
  p_limite integer default 30
)
returns table (
  id integer,
  produto_id integer,
  produto_nome text,
  quantidade_anterior integer,
  quantidade_nova integer,
  quantidade_movimentada integer,
  voltagem text,
  vendedor text,
  created_at timestamp with time zone
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo text;
  v_nome_vendedor text;
  v_email text;
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  select public.usuario_tipo()
  into v_tipo;

  if v_tipo not in ('vendedor', 'admin') then
    raise exception 'Usuario sem permissao para consultar baixas de venda.';
  end if;

  select auth.email()
  into v_email;

  select v.nome
  into v_nome_vendedor
  from public.vendedores v
  where v.auth_user_id = auth.uid();

  return query
  select
    h.id,
    h.produto_id,
    coalesce(p.nome, 'Produto removido') as produto_nome,
    h.quantidade_anterior,
    h.quantidade_nova,
    greatest(h.quantidade_anterior - h.quantidade_nova, 0) as quantidade_movimentada,
    h.voltagem,
    h.vendedor,
    h.created_at
  from public.historico h
  left join public.produtos p on p.id = h.produto_id
  where h.tipo in ('baixa', 'baixa_manual_produto')
    and (
      h.usuario = v_email
      or (v_nome_vendedor is not null and h.vendedor = v_nome_vendedor)
    )
  order by h.created_at desc
  limit least(greatest(coalesce(p_limite, 30), 1), 100);
end;
$$;

grant execute on function public.listar_minhas_baixas_vendedor(integer) to authenticated;
