begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

alter table public.nuvemshop_conexoes
  add column if not exists escrita_habilitada boolean not null default false,
  add column if not exists limite_aplicacao integer not null default 1,
  add column if not exists escrita_habilitada_em timestamp with time zone,
  add column if not exists escrita_habilitada_por uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_conexoes_limite_aplicacao_check'
      and conrelid = 'public.nuvemshop_conexoes'::regclass
  ) then
    alter table public.nuvemshop_conexoes
      add constraint nuvemshop_conexoes_limite_aplicacao_check
      check (limite_aplicacao between 1 and 100);
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conname = 'nuvemshop_conexoes_escrita_auditoria_check'
      and conrelid = 'public.nuvemshop_conexoes'::regclass
  ) then
    alter table public.nuvemshop_conexoes
      add constraint nuvemshop_conexoes_escrita_auditoria_check
      check (
        not escrita_habilitada
        or (
          escrita_habilitada_em is not null
          and escrita_habilitada_por is not null
        )
      );
  end if;
end;
$$;

comment on column public.nuvemshop_conexoes.escrita_habilitada is
  'Interruptor de emergencia por loja. Permanece falso ate a liberacao explicita do piloto.';
comment on column public.nuvemshop_conexoes.limite_aplicacao is
  'Quantidade maxima de itens permitida em uma aplicacao de estoque.';

notify pgrst, 'reload schema';

commit;

select
  store_id,
  escopos,
  local_estoque_id,
  escrita_habilitada,
  limite_aplicacao,
  escrita_habilitada_em,
  escrita_habilitada_por
from public.nuvemshop_conexoes
order by store_id;
