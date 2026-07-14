begin;

do $$
declare
  v_user_id constant uuid := 'ea08e6bf-24fa-448e-a34d-b5b999c06c71';
  v_email text;
begin
  select email
  into v_email
  from auth.users
  where id = v_user_id;

  if lower(coalesce(v_email, '')) <> 'vendas4.pds@gmail.com' then
    raise exception 'Usuario vendas4 nao encontrado ou UUID divergente.';
  end if;

  update public.perfis
  set tipo = 'funcionario'
  where user_id = v_user_id;

  if not found then
    raise exception 'Perfil do usuario vendas4 nao encontrado em public.perfis.';
  end if;
end;
$$;

commit;

select
  p.user_id,
  u.email,
  p.nome,
  p.tipo
from public.perfis p
join auth.users u on u.id = p.user_id
where p.user_id = 'ea08e6bf-24fa-448e-a34d-b5b999c06c71';
