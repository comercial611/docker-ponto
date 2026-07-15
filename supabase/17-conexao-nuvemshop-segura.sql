begin;

create table if not exists public.nuvemshop_conexoes (
  store_id bigint primary key,
  token_cifrado text not null,
  token_iv text not null,
  escopos text,
  conectado_em timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  constraint nuvemshop_conexoes_store_id_check check (store_id > 0),
  constraint nuvemshop_conexoes_token_check
    check (length(token_cifrado) > 20 and length(token_iv) > 8)
);

drop trigger if exists set_updated_at_nuvemshop_conexoes
on public.nuvemshop_conexoes;

create trigger set_updated_at_nuvemshop_conexoes
before update on public.nuvemshop_conexoes
for each row execute function public.update_updated_at();

alter table public.nuvemshop_conexoes enable row level security;

revoke all on public.nuvemshop_conexoes from public;
revoke all on public.nuvemshop_conexoes from anon;
revoke all on public.nuvemshop_conexoes from authenticated;

notify pgrst, 'reload schema';

commit;

select
  store_id,
  escopos,
  conectado_em,
  updated_at
from public.nuvemshop_conexoes
order by store_id;
