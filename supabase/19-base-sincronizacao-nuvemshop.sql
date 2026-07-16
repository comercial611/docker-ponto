begin;

-- O painel consulta primeiro os vinculos e depois a conexao. A migracao usa
-- a mesma ordem para evitar deadlock com uma consulta que esteja em andamento.
set local lock_timeout = '15s';
set local statement_timeout = '120s';
lock table public.nuvemshop_vinculos in access exclusive mode;
lock table public.nuvemshop_conexoes in access exclusive mode;

alter table public.nuvemshop_conexoes
  add column if not exists local_estoque_id text,
  add column if not exists local_estoque_nome text,
  add column if not exists locais_verificados_em timestamp with time zone;

alter table public.nuvemshop_vinculos
  add column if not exists store_id bigint;

do $$
declare
  v_total_conexoes integer;
  v_store_id bigint;
begin
  if exists (
    select 1
    from public.nuvemshop_vinculos
    where store_id is null
  ) then
    select count(*), min(store_id)
      into v_total_conexoes, v_store_id
    from public.nuvemshop_conexoes;

    if v_total_conexoes <> 1 then
      raise exception
        'Nao foi possivel identificar a loja dos vinculos atuais. Conexoes encontradas: %.',
        v_total_conexoes;
    end if;

    update public.nuvemshop_vinculos
    set store_id = v_store_id
    where store_id is null;
  end if;
end;
$$;

alter table public.nuvemshop_vinculos
  alter column store_id set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_vinculos_store_id_fkey'
      and conrelid = 'public.nuvemshop_vinculos'::regclass
  ) then
    alter table public.nuvemshop_vinculos
      add constraint nuvemshop_vinculos_store_id_fkey
      foreign key (store_id)
      references public.nuvemshop_conexoes(store_id)
      on delete restrict;
  end if;
end;
$$;

drop index if exists public.nuvemshop_vinculos_local_ativo_uidx;
drop index if exists public.nuvemshop_vinculos_remoto_ativo_uidx;

create unique index nuvemshop_vinculos_local_ativo_uidx
on public.nuvemshop_vinculos (
  store_id,
  produto_id,
  coalesce(voltagem, '')
)
where ativo;

create unique index nuvemshop_vinculos_remoto_ativo_uidx
on public.nuvemshop_vinculos (
  store_id,
  nuvemshop_produto_id,
  coalesce(nuvemshop_variante_id, 0)
)
where ativo;

create table if not exists public.nuvemshop_sincronizacoes (
  id uuid primary key default gen_random_uuid(),
  chave_operacao uuid not null unique,
  store_id bigint not null references public.nuvemshop_conexoes(store_id) on delete restrict,
  local_estoque_id text,
  status text not null default 'preparando',
  solicitado_por uuid not null,
  total_itens integer not null default 0,
  itens_sucesso integer not null default 0,
  itens_falha integer not null default 0,
  iniciado_em timestamp with time zone not null default now(),
  concluido_em timestamp with time zone,
  erro text,
  created_at timestamp with time zone not null default now(),
  constraint nuvemshop_sincronizacoes_status_check
    check (status in ('preparando', 'processando', 'concluida', 'parcial', 'falhou', 'cancelada')),
  constraint nuvemshop_sincronizacoes_totais_check
    check (total_itens >= 0 and itens_sucesso >= 0 and itens_falha >= 0)
);

create table if not exists public.nuvemshop_sincronizacao_itens (
  id bigserial primary key,
  sincronizacao_id uuid not null
    references public.nuvemshop_sincronizacoes(id) on delete cascade,
  vinculo_id bigint references public.nuvemshop_vinculos(id) on delete set null,
  produto_id integer not null references public.produtos(id) on delete restrict,
  voltagem text,
  nuvemshop_produto_id bigint not null,
  nuvemshop_variante_id bigint,
  estoque_anterior integer,
  estoque_destino integer not null,
  status text not null default 'pendente',
  erro text,
  processado_em timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  constraint nuvemshop_sincronizacao_itens_voltagem_check
    check (voltagem is null or voltagem in ('110V', '220V')),
  constraint nuvemshop_sincronizacao_itens_estoque_check
    check (estoque_anterior is null or estoque_anterior >= 0),
  constraint nuvemshop_sincronizacao_itens_destino_check
    check (estoque_destino >= 0),
  constraint nuvemshop_sincronizacao_itens_status_check
    check (status in ('pendente', 'processando', 'concluido', 'ignorado', 'falhou'))
);

create index if not exists nuvemshop_sincronizacoes_store_created_idx
on public.nuvemshop_sincronizacoes (store_id, created_at desc);

create index if not exists nuvemshop_sincronizacao_itens_lote_idx
on public.nuvemshop_sincronizacao_itens (sincronizacao_id, id);

alter table public.nuvemshop_sincronizacoes enable row level security;
alter table public.nuvemshop_sincronizacao_itens enable row level security;

revoke all on public.nuvemshop_sincronizacoes from public, anon, authenticated;
revoke all on public.nuvemshop_sincronizacao_itens from public, anon, authenticated;
grant select on public.nuvemshop_sincronizacoes to authenticated;
grant select on public.nuvemshop_sincronizacao_itens to authenticated;

drop policy if exists "Nuvemshop sincronizacoes: admin pode ler"
on public.nuvemshop_sincronizacoes;
create policy "Nuvemshop sincronizacoes: admin pode ler"
on public.nuvemshop_sincronizacoes
for select
to authenticated
using (public.eh_admin());

drop policy if exists "Nuvemshop sincronizacao itens: admin pode ler"
on public.nuvemshop_sincronizacao_itens;
create policy "Nuvemshop sincronizacao itens: admin pode ler"
on public.nuvemshop_sincronizacao_itens
for select
to authenticated
using (public.eh_admin());

notify pgrst, 'reload schema';

commit;

select
  store_id,
  local_estoque_id,
  local_estoque_nome,
  locais_verificados_em
from public.nuvemshop_conexoes
order by store_id;

select
  store_id,
  count(*) as vinculos_ativos
from public.nuvemshop_vinculos
where ativo
group by store_id
order by store_id;
