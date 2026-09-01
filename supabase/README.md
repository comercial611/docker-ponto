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
26. `26-ampliar-lote-nuvemshop-15-itens.sql`
27. `27-tags-e-fornecedor-produtos.sql`
28. `28-produto-ativo-inativo.sql`
29. `29-registrar-baixa-administrativa.sql`
30. `30-corrigir-baixa-administrativa-created-at.sql`
31. `31-bloquear-reaplicacao-csv-por-arquivo.sql`
32. `32-oauth-state-nuvemshop.sql`
33. `33-desativacao-auditada-vinculos-nuvemshop.sql`
34. `34-registrar-entrada-estoque.sql`
35. Reservada para a futura redacao LGPD multiloja.
36. `36-base-reconciliacao-zeragem-csv.sql`

## O que foi protegido

- Usuarios precisam existir em `public.perfis` para acessar dados do sistema.
- Admin pode criar, editar e excluir produtos.
- Funcionario registra contagens pela funcao `public.registrar_contagem_estoque`, sem `UPDATE` direto em `produtos`.
- Vendedor pode ler produtos, mas nao atualiza `produtos` diretamente.
- Baixas de venda de maquinas passam pela funcao `public.registrar_baixa_venda`.
- Baixa manual de produtos passa pela funcao `public.registrar_baixa_produto_manual`, com senha validada no Supabase.
- O navegador aplica o fechamento oficial, a partir de CSV ou do relatorio legado `.xls` Produtos Vendidos do Futura, exclusivamente pela Edge Function `fechamento-csv-produtos`; a Function reprocessa o arquivo bruto com o mesmo parser usado apenas para a previa local. O XLS exige uma unica planilha `Report`, periodo de um dia, data igual a competencia escolhida e cabecalhos inequivocos por nome. Somente `service_role` executa `public.registrar_fechamento_csv_produtos`, e a funcao inferior `registrar_baixa_csv_produtos` nao aceita chamadas diretas.
- Cada baixa por CSV gera um lote de conferencia em `public.baixas_csv_lotes` e itens em `public.baixas_csv_itens`.
- O mesmo arquivo oficial, CSV ou XLS, nao pode ser aplicado novamente, mesmo que a data de movimento seja alterada.
- Cada competencia aceita somente um fechamento oficial **v2**. Lotes legados **v1** permanecem preservados, mesmo quando repetem competencia; repetir exatamente o mesmo hash e payload v2 e idempotente, e outro arquivo para a competencia v2 e tratado como corretivo e bloqueado para revisao manual.
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
- `26-ampliar-lote-nuvemshop-15-itens.sql`: amplia de dez para quinze itens o limite do lote controlado, mantendo as mesmas validacoes, reserva atomica, janela temporaria e interrupcao diante de falha ou incerteza.
- `27-tags-e-fornecedor-produtos.sql`: adiciona tags pesquisaveis e a situacao do fornecedor ao cadastro de produtos. Aplicar somente pelo fluxo de migrations ja usado no projeto; nao executar diretamente pelo navegador.
- `28-produto-ativo-inativo.sql`: adiciona o estado ativo/inativo, auditoria administrativa e bloqueios locais de estoque, CSV e vinculos Nuvemshop. Deve ser aplicada antes das futuras interfaces de inativacao, somente pelo fluxo de migrations do projeto.
- `29-registrar-baixa-administrativa.sql`: cria a funcao atomica usada pela baixa no painel administrativo; estoque, ultima baixa e historico sao gravados juntos ou nada e confirmado.
- `30-corrigir-baixa-administrativa-created-at.sql`: corrige a ambiguidade de `created_at` na baixa administrativa atomica.
- `31-bloquear-reaplicacao-csv-por-arquivo.sql`: identifica o CSV pelo hash do arquivo em toda a historico, bloqueia reaplicacao com qualquer data de movimento e preserva a operacao atomica.
- `32-oauth-state-nuvemshop.sql`: registra somente o hash SHA-256 das tentativas OAuth, limita cada state a dez minutos e uso unico, reserva callbacks atomicamente e conclui a tentativa junto com a conexao na mesma transacao.
- `33-desativacao-auditada-vinculos-nuvemshop.sql`: substitui a desativacao direta de vinculos por uma RPC transacional exclusiva do servidor, com auditoria por loja; o navegador deixa de ter permissao de atualizar ou excluir vinculos. A Edge Function confirma a ausencia remota antes do caminho de vinculo quebrado; o caminho manual exige motivo administrativo. Nenhum dos dois altera estoque, CSV, preco, catalogo externo ou outro vinculo.
- `34-registrar-entrada-estoque.sql`: cria o ledger imutavel de entradas locais e a RPC administrativa atomica e idempotente para somar varios produtos ou variantes. O navegador nao grava diretamente no ledger; a operacao, seus itens, os saldos e o historico `entrada_mercadoria` confirmam juntos ou sofrem rollback. Nao consulta nem altera Nuvemshop, CSV, preco, catalogo ou vinculos.
- `36-base-reconciliacao-zeragem-csv.sql`: torna `registrar_fechamento_csv_produtos` a fronteira transacional exclusiva de `service_role`, revalida o administrador indicado pela Function, valida e agrega todas as linhas, calcula o resumo, aplica um unico fechamento oficial v2 por competencia e bloqueia corretivos ou divergencias integralmente. Lotes historicos permanecem preservados como legado v1 (inclusive competencias repetidas e datas nulas); somente v2 participa da unicidade. Cria as tabelas imutaveis de cobertura e eventos sem liberar insercao ou zeragem. Nao consulta nem escreve Nuvemshop.
- `functions/fechamento-csv-produtos`: exige JWT e perfil administrador, recebe o arquivo CSV bruto, valida e normaliza UTF-8, calcula o hash SHA-256 e encaminha somente linhas canonicas, metadados e UUID autenticado para a RPC exclusiva do servidor.
- `functions/nuvemshop-oauth-iniciar`: permite somente a administradores autenticados iniciar uma autorizacao, gera o state no servidor e retorna a URL oficial da Nuvemshop.
- `functions/nuvemshop-oauth`: exige e consome o state antes de trocar o code, conclui a instalacao por RPC transacional e salva somente o token criptografado, sem exibir a credencial.
- `functions/nuvemshop-lgpd`: recebe os tres webhooks obrigatorios de privacidade e valida a assinatura da Nuvemshop.
- `functions/nuvemshop-catalogo`: consulta o catalogo e os locais de estoque da Nuvemshop somente para administradores, sem alterar o estoque externo.
- `functions/nuvemshop-vinculo-quebrado`: exige administrador autenticado e desativa somente o vinculo informado da loja informada. No modo quebrado, confirma por GET que o produto ou a variante nao existe antes da RPC auditada; no modo manual, exige motivo e nao consulta a Nuvemshop.
- `functions/nuvemshop-sincronizacao`: recalcula a previa, verifica as protecoes e aplica um item piloto ou um lote controlado de dois a quinze itens durante uma janela temporaria confirmada; cada escrita e relida e o lote para diante de qualquer falha ou incerteza.
- `rollback-segundo-admin-principal.sql`: devolve o login vendas4 ao perfil funcionario em caso de necessidade.
- `rollback-policies-abertas.sql`: volta para as policies antigas em caso de emergencia.

## Atencao

Esses arquivos documentam alteracoes de banco em producao. Antes de rodar qualquer SQL novamente, confira se ele ainda corresponde ao estado atual do Supabase.

O rollback reduz a seguranca e deve ser usado apenas em emergencia.

## Contrato temporal do OAuth e da futura redacao LGPD

- `nuvemshop_oauth_tentativas.criado_em` e gravado pelo banco e identifica quando a autorizacao segura foi iniciada.
- `consumido_em` registra quando o state foi reservado ou invalidado definitivamente; `falhou_em` registra separadamente quando uma tentativa reservada terminou em falha.
- Entre tentativas da mesma loja, a precedencia usa a tupla `criado_em` e `ordem`, sendo `ordem` monotonicamente gerada pelo PostgreSQL para desempatar timestamps iguais. Uma autorizacao concluida mais nova impede conclusao posterior de tentativa antiga. Uma tentativa nova que falha antes de atualizar a conexao nao invalida, por si so, uma tentativa anterior ainda valida; nenhuma tentativa pode ultrapassar os dez minutos de validade.
- `SUPABASE_URL` e a unica origem permitida para construir o redirecionamento final limpo. A URL inicial com `code` e `state` inevitavelmente chega ao callback; a implementacao remove esses parametros da URL final, mas nao controla eventuais logs automaticos da infraestrutura.
- O cookie temporario do callback transporta somente uma mensagem visual de allowlist fixa. Ele nao autoriza operacoes, nao contem credenciais e e removido depois da leitura valida ou invalida.
- A migration 32 nao depende de `nuvemshop_conexoes.redigida_em`, pois essa coluna ainda nao integra a sequencia oficial.
- A futura migration 35 de redacao LGPD devera adaptar a RPC `concluir_tentativa_oauth_nuvemshop`: sob o mesmo lock e na mesma transacao, somente tentativa com `criado_em > redigida_em` podera reinstalar uma conexao redigida.
- Tentativa criada antes ou no mesmo instante da redacao devera falhar sem gravar token nem limpar a redacao.
- A migration LGPD experimental existente em outra branch devera ser renumerada para a migration 35 e adaptada depois das migrations 29, 30, 31, 32, 33 e 34.

## Estoque intradiario — entrada local implementada

A migration 34 implementa somente a primeira etapa: `estoque_operacoes`,
`estoque_operacao_itens` e `registrar_entrada_estoque`. A RPC exige
administrador autenticado, valida e bloqueia os produtos em ordem, soma somente
o campo de estoque correspondente e registra ledger e historico na mesma
transacao. Repetir a mesma UUID com o mesmo payload retorna o resultado ja
gravado; reutiliza-la com outro payload falha.

O CSV consolidado diario continua sendo a unica baixa oficial do estoque local.
Vendas nas lojas `3514029` e `6696910` reduzem apenas o remoto durante o dia e
aguardam o CSV seguinte; diferencas remotas sem uma causa local nao autorizam
reposicao. As duas lojas compartilham um estoque fisico unico.

A entrada atual e uma operacao transacional e auditada, com quantidade positiva,
motivo, usuario, data, itens e voltagem. Ela soma somente no Docker. Uma etapa
futura podera publicar a mesma entrada fisica para cada loja, sem dividir
quantidade. Cada vinculo usara seu `unidades_por_venda`, e 110V/220V
continuarao independentes.

Um ajuste manual ou zeragem exigira motivo, auditoria, chave de idempotencia e
confirmacao humana. **Regra atual, enquanto a zeragem com cobertura ainda nao
estiver implementada:** se o produto acabou somente por vendas ainda pendentes
do CSV, o administrador zera manualmente o saldo local e o externo e, antes do
CSV seguinte, recompõe temporariamente no local a quantidade do arquivo para a
baixa oficial terminar de novo em zero. A migration 36 ainda nao cria a
cobertura que automatizara esse procedimento. A substituicao exige RPC,
interface e rollout posteriores aprovados.

A previa generica deve permanecer diagnostica. Um item `aguardando CSV` nao
pode abrir uma escrita. A escrita futura seguira a cadeia causal:

```text
operacao causal -> outbox por operacao/loja/item -> confirmacao humana
-> janela temporaria -> releitura e confirmacao
```

Toda escrita externa sera manual, temporaria, auditada e isolada por
`store_id`. Uma pausa ou emergencia sera registrada no servidor com motivo,
usuario e data; pausar uma loja nao altera o estado da outra.

O desenho futuro devera manter separados preços, CSV, catalogo, OAuth, LGPD e
sincronizacao normal. Cada PR de implementação deverá atualizar este README,
o README raiz e `docs/ARQUITETURA.md`.

### Base implementada e contrato planejado — zeragem e reconciliacao do CSV

O corte de versao e explicito: lotes anteriores a esta migration sao legado
**v1**, recebem o default `validacao_versao = 1` e ficam fora da unicidade por
competencia. A RPC oficial grava sempre `validacao_versao = 2`; apenas esses
fechamentos novos sao sujeitos ao bloqueio de competencia e ao replay por
payload/hash. Nenhum lote v1 e reescrito ou removido.

Zeragem, ajuste e abertura de cobertura continuam **planejados / ainda nao
implementados**. A migration 36 implementa apenas a base: fechamento unico por
competencia, payload normalizado para replay idempotente, classificacao e
resumo calculados no servidor, revogacao da RPC inferior e tabelas imutaveis de
cobertura sem permissao de escrita.

O fechamento oficial entra por `fechamento-csv-produtos`, com `verify_jwt=true`.
A Function exige administrador, recebe somente arquivo bruto em Base64, nome e
competencia, valida UTF-8/tamanho/formato, interpreta todas as linhas, rejeita
ambiguidade entre produto e maquina e calcula o SHA-256 do conteudo normalizado.
Ela encaminha a RPC apenas com o UUID autenticado. A RPC e exclusiva de
`service_role`, revalida o UUID em `auth.users` e `public.perfis` e deriva o
e-mail de auditoria do banco. `anon` e `authenticated` nao executam nem a RPC de
fechamento nem a RPC inferior de baixa.

A previa local do Admin permanece diagnostica. Produto resolvido, resumo e hash
calculados no navegador nao sao fonte autoritativa da aplicacao. Somente o
resultado estruturado da Function pode confirmar sucesso na interface.

O CSV diario deve ser unico, completo e oficial para as vendas da competencia.
Se uma venda
remota fizer o item acabar durante o dia, uma futura zeragem auditada podera
zerar o saldo local e publicar alvo externo zero somente apos confirmacao
humana. Nenhuma baixa estimada de venda sera criada localmente.

A zeragem por venda devera gerar cobertura pendente com quantidade igual
exclusivamente ao saldo local inteiro anterior removido pelo servidor. A
cobertura so podera ser reconciliada pelo CSV da mesma competencia. CSV com
quantidade exatamente igual a cobertura reconciliara sem uma segunda baixa
local. CSV menor, maior, ausente, de competencia divergente ou corretivo
devera bloquear a aplicacao e exigir revisao manual auditada. Entrada de
mercadoria posterior a zeragem nao podera ser consumida por CSV antigo.

Zeragem por avaria, perda, contagem ou divergencia fisica sera `ajuste_fisico`
e nao criara cobertura para CSV. Produtos 110V e 220V serao itens separados;
enquanto o CSV nao trouxer voltagem, venda aguardando CSV nesses itens nao
podera ser reconciliada automaticamente.

A futura escrita externa ficara fora da previa generica e seguira:
`causa -> outbox por loja -> confirmacao humana -> janela temporaria ->
releitura -> confirmacao`. O estoque fisico continuara compartilhado pelas
lojas `3514029` e `6696910`, sem dividir quantidades entre elas.

A migration 35 continua reservada para LGPD. A migration 36 nao cria a RPC de
zeragem nem permite inserir cobertura; esses passos exigem nova revisao e
rollout. Toda PR futura desta arquitetura devera atualizar este arquivo, o
README raiz e `docs/ARQUITETURA.md`.

### Roadmap planejado

1. Documentação e invariantes. **Concluido.**
2. Ledger e interface de entrada local. **Concluido na migration 34.**
3. Base segura do fechamento e reconciliacao CSV. **Implementada na migration 36.**
4. Ajuste, zeragem e abertura auditada de cobertura.
5. Pausa por loja.
6. Outbox e autorizações.
7. Prévia intradiária.
8. Piloto em uma loja.
9. Segunda loja, falhas e retry.
10. Reconciliação pós-CSV com coberturas reais.

Publicacao intradiaria na Nuvemshop, outbox, pausas, janelas, ajuste e zeragem
continuam planejados e nao implementados. A Function desta fase fecha somente o
CSV oficial; nao cria cobertura, nao chama Nuvemshop e nao habilita escrita
externa.
