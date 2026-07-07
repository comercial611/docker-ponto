# Supabase

Esta pasta documenta a configuração de segurança usada no Supabase de produção.

## Ordem sugerida

1. `01-perfis.sql`
2. `02-funcoes-permissao.sql`
3. `03-policies-rls.sql`
4. `04-registrar-baixa-venda.sql`
5. `05-restringir-update-produtos.sql`
6. `06-registrar-contagem-estoque.sql`
7. `07-listar-minhas-baixas-vendedor.sql`
8. `08-atualizar-observacao-produto.sql`

## O que foi protegido

- Usuários precisam existir em `public.perfis` para acessar dados do sistema.
- Admin pode criar, editar e excluir produtos.
- Funcionário registra contagens pela função `public.registrar_contagem_estoque`, sem `UPDATE` direto em `produtos`.
- Vendedor pode ler produtos, mas não atualiza `produtos` diretamente.
- Baixas de venda passam pela função `public.registrar_baixa_venda`.
- Histórico de movimentação fica centralizado no Supabase.

## Arquivos

- `01-perfis.sql`: cria a tabela de perfis e cadastra os usuários atuais.
- `02-funcoes-permissao.sql`: cria funções auxiliares como `eh_admin()` e `eh_vendedor()`.
- `03-policies-rls.sql`: substitui as policies antigas por regras baseadas em perfil.
- `04-registrar-baixa-venda.sql`: cria a função segura usada pela tela do vendedor.
- `05-restringir-update-produtos.sql`: restringe `UPDATE` direto em `produtos` ao admin; funcionário e vendedor usam funções seguras.
- `06-registrar-contagem-estoque.sql`: cria a função segura usada pela tela de funcionário para contagem de estoque.
- `07-listar-minhas-baixas-vendedor.sql`: cria a função segura usada pela tela do vendedor para consultar apenas as próprias baixas.
- `08-atualizar-observacao-produto.sql`: cria a função segura usada pelo app funcionário para editar observações do produto.
- `rollback-policies-abertas.sql`: volta para as policies antigas em caso de emergência.

## Atenção

Esses arquivos documentam alterações de banco em produção. Antes de rodar qualquer SQL novamente, confira se ele ainda corresponde ao estado atual do Supabase.

O rollback reduz a segurança e deve ser usado apenas em emergência.