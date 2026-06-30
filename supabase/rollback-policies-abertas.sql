drop policy if exists "Produtos: autenticados podem ler" on public.produtos;
drop policy if exists "Produtos: admin pode inserir" on public.produtos;
drop policy if exists "Produtos: equipe pode atualizar" on public.produtos;
drop policy if exists "Produtos: admin pode excluir" on public.produtos;

drop policy if exists "Historico: admin pode ler" on public.historico;
drop policy if exists "Historico: perfis cadastrados podem inserir" on public.historico;

drop policy if exists "Vendedores: admin pode gerenciar" on public.vendedores;
drop policy if exists "Vendedores: vendedor pode ler proprio cadastro" on public.vendedores;

create policy "Autenticados podem editar produtos"
on public.produtos
for all
to authenticated
using (true);

create policy "Autenticados podem ler produtos"
on public.produtos
for select
to authenticated
using (true);

create policy "Autenticados podem inserir histórico"
on public.historico
for insert
to authenticated
with check (true);

create policy "Autenticados podem ler histórico"
on public.historico
for select
to authenticated
using (true);

create policy "Autenticados podem gerenciar vendedores"
on public.vendedores
for all
to authenticated
using (true);

create policy "Autenticados podem ler vendedores"
on public.vendedores
for select
to authenticated
using (true);