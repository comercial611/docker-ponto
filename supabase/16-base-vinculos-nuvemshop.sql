begin;

create table if not exists public.nuvemshop_vinculos (
  id bigserial primary key,
  produto_id integer not null references public.produtos(id) on delete cascade,
  voltagem text,
  nuvemshop_produto_id bigint not null,
  nuvemshop_variante_id bigint,
  nuvemshop_sku text,
  ativo boolean not null default true,
  criado_por uuid default auth.uid(),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint nuvemshop_vinculos_voltagem_check
    check (voltagem is null or voltagem in ('110V', '220V')),
  constraint nuvemshop_vinculos_produto_id_check
    check (nuvemshop_produto_id > 0),
  constraint nuvemshop_vinculos_variante_id_check
    check (nuvemshop_variante_id is null or nuvemshop_variante_id > 0)
);

create unique index if not exists nuvemshop_vinculos_local_ativo_uidx
on public.nuvemshop_vinculos (produto_id, coalesce(voltagem, ''))
where ativo;

create unique index if not exists nuvemshop_vinculos_remoto_ativo_uidx
on public.nuvemshop_vinculos (
  nuvemshop_produto_id,
  coalesce(nuvemshop_variante_id, 0)
)
where ativo;

create or replace function public.validar_vinculo_nuvemshop()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tem_voltagem boolean;
begin
  select tem_voltagem
  into v_tem_voltagem
  from public.produtos
  where id = new.produto_id;

  if not found then
    raise exception 'Produto local nao encontrado.';
  end if;

  new.voltagem := nullif(upper(trim(new.voltagem)), '');
  new.nuvemshop_sku := nullif(trim(new.nuvemshop_sku), '');

  if v_tem_voltagem and new.voltagem is null then
    raise exception 'Informe 110V ou 220V para este produto.';
  end if;

  if not v_tem_voltagem and new.voltagem is not null then
    raise exception 'Produto sem voltagem deve usar vinculo unico.';
  end if;

  return new;
end;
$$;

revoke all on function public.validar_vinculo_nuvemshop() from public;

drop trigger if exists validar_vinculo_nuvemshop on public.nuvemshop_vinculos;
create trigger validar_vinculo_nuvemshop
before insert or update on public.nuvemshop_vinculos
for each row execute function public.validar_vinculo_nuvemshop();

drop trigger if exists set_updated_at_nuvemshop_vinculos on public.nuvemshop_vinculos;
create trigger set_updated_at_nuvemshop_vinculos
before update on public.nuvemshop_vinculos
for each row execute function public.update_updated_at();

alter table public.nuvemshop_vinculos enable row level security;

revoke all on public.nuvemshop_vinculos from anon;
revoke all on public.nuvemshop_vinculos from authenticated;
grant select, insert, update, delete on public.nuvemshop_vinculos to authenticated;

drop policy if exists "Nuvemshop vinculos: admin pode ler" on public.nuvemshop_vinculos;
drop policy if exists "Nuvemshop vinculos: admin pode inserir" on public.nuvemshop_vinculos;
drop policy if exists "Nuvemshop vinculos: admin pode atualizar" on public.nuvemshop_vinculos;
drop policy if exists "Nuvemshop vinculos: admin pode excluir" on public.nuvemshop_vinculos;

create policy "Nuvemshop vinculos: admin pode ler"
on public.nuvemshop_vinculos
for select
to authenticated
using (public.eh_admin());

create policy "Nuvemshop vinculos: admin pode inserir"
on public.nuvemshop_vinculos
for insert
to authenticated
with check (public.eh_admin());

create policy "Nuvemshop vinculos: admin pode atualizar"
on public.nuvemshop_vinculos
for update
to authenticated
using (public.eh_admin())
with check (public.eh_admin());

create policy "Nuvemshop vinculos: admin pode excluir"
on public.nuvemshop_vinculos
for delete
to authenticated
using (public.eh_admin());

grant usage, select on sequence public.nuvemshop_vinculos_id_seq to authenticated;

notify pgrst, 'reload schema';

commit;

select
  id,
  produto_id,
  voltagem,
  nuvemshop_produto_id,
  nuvemshop_variante_id,
  nuvemshop_sku,
  ativo
from public.nuvemshop_vinculos
order by id;
