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
| Administracao | `admin.html` | Produtos, dashboard, CSV, Nuvemshop, vendedores e historico. |
| Estoque desktop | `funcionario.html` | Contagem e atualizacao de estoque pelo computador. |
| App Estoque | `funcionario-app.html` | Contagem rapida no celular, fotos, historico e observacoes. |
| Vendedor | `vendedor.html` | Consulta, baixa de maquinas e historico do vendedor. |
| Relatorios | `relatorios.html` | Indicadores de compras, reposicao e pontos de atencao. |

Cada area valida sua propria sessao pelo Supabase Auth. As permissoes efetivas
nao dependem apenas da tela: elas tambem sao verificadas no banco por RLS e por
funcoes seguras.

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
