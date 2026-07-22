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
11. `11-listar-baixas-manuais-produto.sql`
12. `12-aplicar-baixa-csv-produtos.sql`
13. `13-relatorio-baixas-csv.sql`
14. `14-segundo-admin-principal.sql`
15. `15-proteger-fechamento-csv.sql`
16. `16-base-vinculos-nuvemshop.sql`
17. `17-conexao-nuvemshop-segura.sql`
18. `18-codigos-por-voltagem.sql`
19. `19-base-sincronizacao-nuvemshop.sql`
20. `20-auditoria-simulacao-nuvemshop.sql`
21. `21-trava-aplicacao-piloto-nuvemshop.sql`
22. `22-reserva-aplicacao-piloto-nuvemshop.sql`
23. `23-janela-temporaria-piloto-nuvemshop.sql`
24. `24-multiplicadores-variantes-nuvemshop.sql`
25. `25-aplicacao-lote-controlada-nuvemshop.sql`

## O que foi protegido

- Usuarios precisam existir em `public.perfis` para acessar dados do sistema.
- Admin pode criar, editar e excluir produtos.
- Funcionario registra contagens pela funcao `public.registrar_contagem_estoque`, sem `UPDATE` direto em `produtos`.
- Vendedor pode ler produtos, mas nao atualiza `produtos` diretamente.
- Baixas de venda de maquinas passam pela funcao `public.registrar_baixa_venda`.
- Baixa manual de produtos passa pela funcao `public.registrar_baixa_produto_manual`, com senha validada no Supabase.
- Baixa por CSV de produtos passa pela funcao `public.registrar_baixa_csv_produtos`, restrita a admin.
- Cada baixa por CSV gera um lote de conferencia em `public.baixas_csv_lotes` e itens em `public.baixas_csv_itens`.
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
- `11-listar-baixas-manuais-produto.sql`: inclui baixas manuais de produtos na lista de baixas recentes do vendedor.
- `12-aplicar-baixa-csv-produtos.sql`: cria a funcao segura que aplica baixas por CSV somente em produtos, ignorando maquinas no frontend e validando novamente no Supabase.
- `13-relatorio-baixas-csv.sql`: cria o relatorio de importacoes CSV e atualiza a funcao de baixa para registrar lote e itens aplicados.
- `14-segundo-admin-principal.sql`: promove o login vendas4 a administrador depois de validar UUID e e-mail no Supabase Auth.
- `15-proteger-fechamento-csv.sql`: adiciona data e identificacao unica ao fechamento CSV, impedindo a reaplicacao acidental do mesmo arquivo na mesma data.
- `16-base-vinculos-nuvemshop.sql`: cria os vinculos protegidos entre produtos locais e produtos ou variantes da Nuvemshop, sem consultar ou alterar estoque externo.
- `17-conexao-nuvemshop-segura.sql`: cria a tabela sem acesso pelo navegador usada para guardar o token criptografado da Nuvemshop.
- `18-codigos-por-voltagem.sql`: adiciona campos separados de fabricante, interno, referencia e barras para as variacoes 110V e 220V, preservando os campos antigos.
- `19-base-sincronizacao-nuvemshop.sql`: associa cada vinculo a uma loja, registra o local de estoque conferido e cria tabelas protegidas de auditoria para futuras sincronizacoes.
- `20-auditoria-simulacao-nuvemshop.sql`: identifica simulacoes na auditoria e cria a funcao atomica usada pela Edge Function para registrar o resumo e todos os itens validados.
- `21-trava-aplicacao-piloto-nuvemshop.sql`: adiciona o interruptor de escrita por loja, iniciado desligado, e limita o primeiro piloto a um item.
- `22-reserva-aplicacao-piloto-nuvemshop.sql`: vincula uma aplicacao a uma simulacao recente, reserva somente um item, bloqueia repeticao e registra o resultado confirmado pelo servidor.
- `23-janela-temporaria-piloto-nuvemshop.sql`: troca o interruptor manual por uma janela auditada de cinco minutos, bloqueia aplicacoes fora do prazo e desliga a escrita depois da primeira tentativa.
- `24-multiplicadores-variantes-nuvemshop.sql`: permite varias ofertas externas para o mesmo produto fisico, registra quantas unidades cada venda consome e recalcula o estoque externo por divisao inteira sem alterar os vinculos existentes.
- `25-aplicacao-lote-controlada-nuvemshop.sql`: cria a aplicacao protegida em lote, posteriormente ampliada e validada para dois a dez itens; reserva todos atomicamente, registra cada resultado e interrompe os itens restantes diante de qualquer falha ou incerteza.
- `functions/nuvemshop-oauth`: conclui a instalacao OAuth e salva o token criptografado, sem exibir a credencial.
- `functions/nuvemshop-lgpd`: recebe os tres webhooks obrigatorios de privacidade e valida a assinatura da Nuvemshop.
- `functions/nuvemshop-catalogo`: consulta o catalogo e os locais de estoque da Nuvemshop somente para administradores, sem alterar o estoque externo.
- `functions/nuvemshop-sincronizacao`: recalcula a previa, verifica as protecoes e aplica um item piloto ou um lote controlado de dois a dez itens durante uma janela temporaria confirmada; cada escrita e relida e o lote para diante de qualquer falha ou incerteza.
- `rollback-segundo-admin-principal.sql`: devolve o login vendas4 ao perfil funcionario em caso de necessidade.
- `rollback-policies-abertas.sql`: volta para as policies antigas em caso de emergencia.

## Atencao

Esses arquivos documentam alteracoes de banco em producao. Antes de rodar qualquer SQL novamente, confira se ele ainda corresponde ao estado atual do Supabase.

O rollback reduz a seguranca e deve ser usado apenas em emergencia.
