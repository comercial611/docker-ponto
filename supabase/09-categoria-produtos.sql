begin;

alter table public.produtos
  add column if not exists categoria text;

alter table public.produtos
  alter column categoria set default 'maquina';

update public.produtos
set categoria = 'maquina'
where categoria is null
   or categoria not in ('maquina', 'produto');

alter table public.produtos
  alter column categoria set not null;

alter table public.produtos
  drop constraint if exists produtos_categoria_check;

alter table public.produtos
  add constraint produtos_categoria_check
  check (categoria in ('maquina', 'produto'));

commit;
