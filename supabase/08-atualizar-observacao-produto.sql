create or replace function public.atualizar_observacao_produto(
  p_produto_id integer,
  p_observacoes text
)
returns table (
  produto_id integer,
  observacoes text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tipo text;
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  select public.usuario_tipo()
  into v_tipo;

  if v_tipo not in ('admin', 'funcionario') then
    raise exception 'Usuario sem permissao para atualizar observacoes.';
  end if;

  update public.produtos
  set observacoes = nullif(trim(coalesce(p_observacoes, '')), '')
  where id = p_produto_id;

  if not found then
    raise exception 'Produto nao encontrado.';
  end if;

  return query
  select p.id, p.observacoes
  from public.produtos p
  where p.id = p_produto_id;
end;
$$;

grant execute on function public.atualizar_observacao_produto(integer, text) to authenticated;