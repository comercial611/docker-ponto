begin;

drop policy if exists "Produtos: equipe pode atualizar" on public.produtos;
drop policy if exists "Produtos: admin pode atualizar" on public.produtos;

create policy "Produtos: admin pode atualizar"
on public.produtos
for update
to authenticated
using (public.eh_admin())
with check (public.eh_admin());

commit;
