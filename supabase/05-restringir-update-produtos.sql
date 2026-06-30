begin;

drop policy if exists "Produtos: equipe pode atualizar" on public.produtos;

create policy "Produtos: equipe pode atualizar"
on public.produtos
for update
to authenticated
using (
  public.eh_admin()
  or public.eh_funcionario()
)
with check (
  public.eh_admin()
  or public.eh_funcionario()
);

commit;