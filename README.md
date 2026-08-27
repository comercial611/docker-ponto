# Sistema de Estoque - Ponto da Sublimacao

Sistema interno para controle de estoque fisico, movimentacoes da loja e
sincronizacao controlada com a Nuvemshop.

O projeto usa HTML, CSS e JavaScript sem etapa de build. O backend e fornecido
pelo Supabase, com PostgreSQL, Auth, Row Level Security (RLS), Realtime, funcoes
SQL e Edge Functions. A publicacao do frontend e feita pelo GitHub Pages.

## Areas do sistema

| Area | Arquivo | Finalidade |
| --- | --- | --- |
| Inicio | `index.html` | Direciona cada usuario para sua area de trabalho. |
| Administracao | `admin.html` | Produtos, entrada local auditada, dashboard, CSV, Nuvemshop, vendedores e historico. O Dashboard prioriza pendencias somente leitura para resolver no dia. |
| Estoque desktop | `funcionario.html` | Contagem e atualizacao de estoque pelo computador. |
| App Estoque | `funcionario-app.html` | Contagem rapida no celular, fotos, historico e observacoes. |
| Vendedor | `vendedor.html` | Consulta, baixa de maquinas e historico do vendedor. |
| Relatorios | `relatorios.html` | Indicadores de compras, reposicao e pontos de atencao. |

Cada area valida sua propria sessao pelo Supabase Auth. As permissoes efetivas
nao dependem apenas da tela: elas tambem sao verificadas no banco por RLS e por
funcoes seguras.

## Colar linha do Futura

Na aba Produtos, durante o cadastro ou a edicao, o bloco `Colar linha do
Futura` auxilia o preenchimento dos codigos copiados do ERP. Ele aceita produto
de grade, com codigo interno, referencia e codigo de barras, e produto simples,
com codigo interno e barras; para produto simples, o cabecalho e obrigatorio.

Quando o produto possui 110V/220V, o usuario deve escolher explicitamente o
destino antes de preencher. Os codigos sao apenas colocados no formulario para
conferencia: formatos invalidos nao alteram os campos e nada e salvo
automaticamente. O usuario continua responsavel por revisar os valores e clicar
em `Salvar produto`.

## Estrutura

```text
.
|-- css/                    Estilos separados por area
|-- docs/                   Documentacao de arquitetura e operacao
|-- js/                     Comportamento das telas e cliente Supabase
|-- supabase/               SQL versionado, Edge Functions e documentacao
|-- admin.html
|-- funcionario-app.html
|-- funcionario.html
|-- index.html
|-- relatorios.html
`-- vendedor.html
```

## Documentacao

- [Arquitetura do sistema](docs/ARQUITETURA.md)
- [Configuracao e historico do Supabase](supabase/README.md)

## Seguranca

- O navegador usa somente a chave publica do Supabase, centralizada em
  `js/supabase-config.js`.
- Chaves administrativas, tokens da Nuvemshop e segredos nunca devem ser
  incluidos no frontend ou em commits.
- Alteracoes de estoque passam por funcoes SQL ou Edge Functions autorizadas.
- O Supabase esta em producao. Todo SQL deve ser revisado e aplicado de forma
  incremental, seguindo a ordem e as instrucoes de `supabase/README.md`.

## Fluxo de alteracao

1. Atualizar a `main` local.
2. Criar uma branch pequena e com objetivo unico.
3. Testar localmente e conferir o impacto no Supabase quando houver backend.
4. Abrir Pull Request e revisar os arquivos alterados.
5. Fazer merge somente depois dos testes.
6. Confirmar o deploy do GitHub Pages e executar um teste curto em producao.

## Observacao

O Supabase e a fonte de verdade do estoque fisico. A Nuvemshop recebe estoques
calculados a partir dos vinculos confirmados e das regras de cada oferta, mas
nao substitui o cadastro fisico local.

O Dashboard administrativo apenas prioriza pendencias e sugere reposicao ate o
minimo cadastrado; ele nao altera estoque. A baixa oficial continua sendo feita
somente pelo CSV final consolidado.

## Estoque intradiario — etapa 1: entrada local auditada

A primeira etapa esta implementada na aba Produtos. Administradores podem usar
`Registrar entrada` para gravar uma unica operacao com motivo, data e varios
produtos ou variantes 110V/220V. A migration
`supabase/34-registrar-entrada-estoque.sql` cria o ledger imutavel e a RPC
atomica `registrar_entrada_estoque`. A chave UUID torna a repeticao idempotente;
se a resposta ficar incerta, o navegador preserva e bloqueia o mesmo lote no
`sessionStorage` para tentar novamente sem duplicar a soma.

Esta etapa altera exclusivamente o estoque fisico local. Ela nao consulta nem
publica estoque na Nuvemshop, nao cria outbox ou Edge Function e nao interfere
em preco, catalogo, OAuth, LGPD, vinculos ou nos campos de ultima baixa.

- O CSV consolidado diario continua sendo a unica baixa oficial do estoque
  local. Ele nao deve ser reaplicado para representar uma venda remota ja
  observada.
- Vendas ocorridas nas lojas Nuvemshop `3514029` e `6696910` reduzem somente o
  estoque remoto durante o dia e aguardam o CSV seguinte. Uma diferenca remota
  sem causa local nao pode disparar reposicao automatica.
- As duas lojas compartilham um unico estoque fisico. A entrada auditada agora
  soma no Docker sem dividir quantidade entre lojas. Uma publicacao futura
  podera refletir a mesma entrada fisica em cada loja; `unidades_por_venda` e
  as voltagens 110V/220V deverao ser tratados por item e por loja.
- Ajuste manual e zeragem exigirao motivo, auditoria, idempotencia e
  confirmacao humana. **Regra atual, enquanto a zeragem com cobertura ainda nao
  estiver implementada:** o administrador zera manualmente o saldo local e o
  externo; antes do CSV oficial seguinte, recompõe temporariamente no saldo
  local a quantidade do arquivo para que a baixa oficial termine novamente em
  zero. A migration 36 ainda nao automatiza nem audita essa compensacao. A regra
  futura de cobertura substituira esse procedimento somente apos RPC, interface
  e rollout especificos aprovados.
- A previa generica continuara diagnostica. Uma diferenca classificada como
  `aguardando CSV` nao podera autorizar escrita.
- Publicacoes futuras seguirao: operacao causal -> outbox por
  operacao/loja/item -> confirmacao humana -> janela temporaria -> releitura e
  confirmacao. Escrita externa nunca sera automatica.
- A pausa ou emergencia sera individual por loja, validada no servidor e
  auditada com motivo, usuario e data. Pausar uma loja nao afetara a outra.
- Precos, CSV, catalogo, OAuth e LGPD permanecem separados desse fluxo.

### Contrato planejado — zeragem intradiaria e reconciliacao do CSV

O corte de compatibilidade da migration 36 preserva todos os lotes existentes
como legado **v1**. Eles nao sao alterados, apagados ou consolidados, inclusive
quando possuem a mesma competencia ou `data_movimento` nula. Somente novos
fechamentos oficiais gravados pela RPC server-side sao **v2** e participam da
unicidade por competencia e das regras de replay.

O contrato de zeragem abaixo continua **planejado / ainda nao implementado**.
A migration 36 desta etapa implementa apenas a fundacao segura do fechamento.
A aplicacao oficial deixa de confiar no hash, no produto resolvido ou no resumo
do navegador: a Edge Function autenticada `fechamento-csv-produtos` recebe o
arquivo bruto, valida o administrador, normaliza e interpreta todas as linhas,
calcula o SHA-256 e chama a RPC transacional com `service_role`. A RPC revalida
o UUID administrativo e deriva o e-mail de auditoria do banco. Apenas
`service_role` pode executar essa RPC; a RPC inferior de baixa tambem deixa de
aceitar chamadas diretas.

A previa montada no Admin continua local e serve somente como diagnostico. No
momento de aplicar, o arquivo bruto e a competencia seguem para a Function e o
resultado estruturado do servidor e validado antes de a tela indicar sucesso.
Ambiguidade entre produto e maquina, arquivo truncado ou corretivo, produto com
voltagem, competencia divergente e saldo insuficiente bloqueiam a transacao
inteira.

A migration tambem cria tabelas imutaveis para coberturas e seus eventos, sem
conceder escrita e sem criar RPC ou interface de zeragem. Portanto, nenhuma
cobertura pode ser aberta por esta etapa. O CSV diario deve ser unico, completo
e oficial para as vendas da competencia. Se um item acabar
durante o dia por venda remota, uma futura zeragem auditada podera levar o
saldo local a zero e, depois de confirmacao humana, publicar alvo externo zero;
isso nao criara baixa local estimada.

Essa zeragem por venda devera criar cobertura pendente calculada exclusivamente
pelo saldo local inteiro anterior removido pelo servidor. Somente o CSV da
mesma competencia podera reconciliar a cobertura. Correspondencia exata
reconciliara sem uma segunda baixa local. CSV menor, maior, ausente, de
competencia divergente ou corretivo devera bloquear a aplicacao e exigir
revisao manual auditada. Uma entrada posterior a zeragem nao podera ser
consumida por um CSV antigo.

Zeragem por avaria, perda, contagem ou divergencia fisica sera classificada
como `ajuste_fisico` e nao criara cobertura para o CSV. Produtos 110V e 220V
serao tratados separadamente; enquanto o CSV nao trouxer voltagem, uma venda
aguardando CSV nesses itens nao podera ser reconciliada automaticamente.

Qualquer escrita externa futura seguira a cadeia causal: causa -> outbox por
loja -> confirmacao humana -> janela temporaria -> releitura -> confirmacao.
As lojas `3514029` e `6696910` continuarao compartilhando o estoque fisico;
quantidades nao serao divididas entre elas.

A migration 35 continua reservada para LGPD. A migration 36 estabelece a base
de reconciliacao, mas ajuste, zeragem, criacao de cobertura e escrita externa
continuam fora do escopo. Toda PR futura desta arquitetura devera atualizar
este README, `supabase/README.md` e `docs/ARQUITETURA.md`.

### Roadmap planejado

1. Documentar invariantes. **Concluido nesta etapa.**
2. Criar ledger e interface de entrada local. **Concluido na migration 34.**
3. Criar a base transacional de reconciliacao CSV. **Implementada na migration 36.**
4. Criar ajuste, zeragem e abertura auditada de cobertura.
5. Criar pausa individual por loja.
6. Criar outbox e autorizacoes temporarias.
7. Criar previa intradiaria causal.
8. Testar piloto em uma loja.
9. Adicionar segunda loja, falhas e retry.
10. Validar reconciliacao pos-CSV com coberturas reais.

Cada PR futura deverá atualizar este arquivo, `supabase/README.md` e
`docs/ARQUITETURA.md`. Alem da entrada local da migration 34 e da fundacao CSV
da migration 36 e da Function de fechamento oficial, publicacao intradiaria na Nuvemshop, outbox, pausas, janelas,
ajuste e zeragem continuam planejados e nao implementados.
