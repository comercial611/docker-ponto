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
| Administracao | `admin.html` | Produtos, dashboard, CSV, Nuvemshop, vendedores e historico. O Dashboard prioriza pendencias somente leitura para resolver no dia. |
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

## Estoque intradiario — planejado / ainda nao implementado

Esta secao descreve uma arquitetura futura. Nenhum dos fluxos abaixo esta
disponivel como funcionalidade hoje.

- O CSV consolidado diario continua sendo a unica baixa oficial do estoque
  local. Ele nao deve ser reaplicado para representar uma venda remota ja
  observada.
- Vendas ocorridas nas lojas Nuvemshop `3514029` e `6696910` reduzem somente o
  estoque remoto durante o dia e aguardam o CSV seguinte. Uma diferenca remota
  sem causa local nao pode disparar reposicao automatica.
- As duas lojas compartilham um unico estoque fisico. Uma futura entrada
  auditada somara no Docker e publicara a mesma entrada fisica em cada loja,
  nunca dividindo a quantidade entre elas. `unidades_por_venda` e as voltagens
  110V/220V serao tratados por item e por loja.
- Ajuste manual e zeragem exigirao motivo, auditoria, idempotencia e
  confirmacao humana. Uma zeragem causada apenas por vendas ainda pendentes do
  CSV podera zerar a disponibilidade externa, mas o estoque local aguardara o
  fechamento oficial; nenhuma segunda baixa local sera estimada.
- A previa generica continuara diagnostica. Uma diferenca classificada como
  `aguardando CSV` nao podera autorizar escrita.
- Publicacoes futuras seguirao: operacao causal -> outbox por
  operacao/loja/item -> confirmacao humana -> janela temporaria -> releitura e
  confirmacao. Escrita externa nunca sera automatica.
- A pausa ou emergencia sera individual por loja, validada no servidor e
  auditada com motivo, usuario e data. Pausar uma loja nao afetara a outra.
- Precos, CSV, catalogo, OAuth e LGPD permanecem separados desse fluxo.

### Roadmap planejado

1. Documentar invariantes.
2. Criar ledger de entrada local.
3. Criar ajuste e zeragem auditados.
4. Criar pausa individual por loja.
5. Criar outbox e autorizacoes temporarias.
6. Criar previa intradiaria causal.
7. Testar piloto em uma loja.
8. Adicionar segunda loja, falhas e retry.
9. Criar reconciliação pós-CSV.

Cada PR futura deverá atualizar este arquivo, `supabase/README.md` e
`docs/ARQUITETURA.md`. Até lá, não há migration, RPC, Edge Function ou escrita
externa intradiaria para executar.
