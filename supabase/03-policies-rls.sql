begin;

drop policy if exists "Autenticados podem editar produtos" on public.produtos;
drop policy if exists "Autenticados podem ler produtos" on public.produtos;

drop policy if exists "Autenticados podem inserir histórico" on public.historico;
drop policy if exists "Autenticados podem ler histórico" on public.historico;

drop policy if exists "Autenticados podem gerenciar vendedores" on public.vendedores;
drop policy if exists "Autenticados podem ler vendedores" on public.vendedores;

create policy "Produtos: autenticados podem ler"
on public.produtos
for select
to authenticated
using (public.usuario_tipo() is not null);

create policy "Produtos: admin pode inserir"
on public.produtos
for insert
to authenticated
with check (public.eh_admin());

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

create policy "Produtos: admin pode excluir"
on public.produtos
for delete
to authenticated
using (public.eh_admin());

create policy "Historico: admin pode ler"
on public.historico
for select
to authenticated
using (public.eh_admin());

create policy "Historico: perfis cadastrados podem inserir"
on public.historico
for insert
to authenticated
with check (public.usuario_tipo() is not null);

create policy "Vendedores: admin pode gerenciar"
on public.vendedores
for all
to authenticated
using (public.eh_admin())
with check (public.eh_admin());

create policy "Vendedores: vendedor pode ler proprio cadastro"
on public.vendedores
for select
to authenticated
using (auth_user_id = auth.uid());

commit;