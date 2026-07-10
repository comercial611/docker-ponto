# Supabase

Esta pasta documenta a configuracao de seguranca usada no Supabase de producao.

## Ordem sugerida

1. `01-perfis.sql`
2. `02-funcoes-permissao.sql`
3. `03-policies-rls.sql`
4. `04-registrar-baixa-venda.sql`
5. `05-restringir-update-produtos.sql`
6. `06-registrar-contagem-estoque.sql`
7. `07-listar-minhas-baixas-vendedor.sql`
8. `08-atualizar-observacao-produto.sql`
9. `09-categoria-produtos.sql`
10. `10-baixa-manual-produto-senha.sql`

## O que foi protegido

- Usuarios precisam existir em `public.perfis` para acessar dados do sistema.
- Admin pode criar, editar e excluir produtos.
- Funcionario registra contagens pela funcao `public.registrar_contagem_estoque`, sem `UPDATE` direto em `produtos`.
- Vendedor pode ler produtos, mas nao atualiza `produtos` diretamente.
- Baixas de venda de maquinas passam pela funcao `public.registrar_baixa_venda`.
- Baixa manual de produtos passa pela funcao `public.registrar_baixa_produto_manual`, com senha validada no Supabase.
- Historico de movimentacao fica centralizado no Supabase.

## Arquivos

- `01-perfis.sql`: cria a tabela de perfis e cadastra os usuarios atuais.
- `02-funcoes-permissao.sql`: cria funcoes auxiliares como `eh_admin()` e `eh_vendedor()`.
- `03-policies-rls.sql`: substitui as policies antigas por regras baseadas em perfil.
- `04-registrar-baixa-venda.sql`: cria a funcao segura usada pela tela do vendedor para baixa de maquinas.
- `05-restringir-update-produtos.sql`: restringe `UPDATE` direto em `produtos` ao admin; funcionario e vendedor usam funcoes seguras.
- `06-registrar-contagem-estoque.sql`: cria a funcao segura usada pela tela de funcionario para contagem de estoque.
- `07-listar-minhas-baixas-vendedor.sql`: cria a funcao segura usada pela tela do vendedor para consultar apenas as proprias baixas.
- `08-atualizar-observacao-produto.sql`: cria a funcao segura usada pelo app funcionario para editar observacoes do produto.
- `09-categoria-produtos.sql`: adiciona a categoria `maquina`/`produto` em produtos, mantendo os itens atuais como maquinas.
- `10-baixa-manual-produto-senha.sql`: bloqueia baixa de produtos pela funcao comum e cria baixa manual de produtos com senha validada no Supabase.
- `rollback-policies-abertas.sql`: volta para as policies antigas em caso de emergencia.

## Atencao

Esses arquivos documentam alteracoes de banco em producao. Antes de rodar qualquer SQL novamente, confira se ele ainda corresponde ao estado atual do Supabase.

O rollback reduz a seguranca e deve ser usado apenas em emergencia.
