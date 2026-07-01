# Sistema de Estoque — Ponto da Sublimação

Sistema interno de controle de estoque em tempo real, com três áreas de acesso separadas por permissão. Construído com HTML/CSS/JS puro (sem build, sem dependências de instalação) e Supabase como backend (banco de dados, autenticação e realtime).

## Estrutura do projeto

```
├── index.html          → Página inicial com os 3 cards de acesso
├── admin.html           → Área administrativa (cadastro, dashboard, histórico, vendedores)
├── funcionario.html     → Área do estoque (atualização de contagem)
├── vendedor.html        → Área do vendedor (consulta + baixa por venda)
└── README.md
```

## Como funciona

- **index.html** é a porta de entrada. Mostra 3 cards (Administração, Estoque, Vendedor) que linkam para o respectivo arquivo.
- Cada arquivo (`admin.html`, `funcionario.html`, `vendedor.html`) tem sua própria tela de login, totalmente independente dos outros.
- Não existe um "login único" entre as áreas — cada uma valida e mantém sua própria sessão via Supabase Auth.

## Backend (Supabase)

- **Banco de dados:** tabelas `produtos`, `historico` e `vendedores`, todas com Row Level Security (RLS) habilitado — nenhuma leitura ou escrita funciona sem autenticação.
- **Autenticação:** login por e-mail/senha (admin e funcionário) e por usuário/senha simulado via e-mail interno (`usuario@vendedor.estoque.local`) para vendedores.
- **Tempo real:** mudanças em `produtos` e `historico` são propagadas instantaneamente via Supabase Realtime (WebSocket).
- **Edge Function:** `criar-vendedor` — roda no servidor do Supabase (não no navegador) para criar/editar/remover logins de vendedor com segurança, sem expor a chave secreta no frontend.

## Variáveis de ambiente / configuração

As credenciais públicas do Supabase ficam centralizadas em `js/supabase-config.js`. A chave usada é a pública (`sb_publishable_...`), segura para uso no navegador — a chave secreta nunca aparece em nenhum arquivo deste repositório.

## Hospedagem

Hospedado via Netlify (deploy direto da pasta, sem build necessário). Qualquer alteração nos arquivos `.html` pode ser testada localmente abrindo o arquivo no navegador, e publicada subindo a pasta inteira novamente no Netlify ou conectando este repositório ao Netlify para deploy automático a cada push.

## Manutenção

- Para editar uma área, abra apenas o arquivo correspondente (`admin.html`, `funcionario.html` ou `vendedor.html`) — são independentes entre si.
- O `index.html` raramente precisa de alteração, a menos que se adicione uma nova área de acesso.
- Mudanças na estrutura do banco (novas colunas, tabelas) exigem rodar o SQL correspondente direto no SQL Editor do Supabase.
