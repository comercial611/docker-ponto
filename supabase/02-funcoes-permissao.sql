create or replace function public.usuario_tipo()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select tipo
  from public.perfis
  where user_id = auth.uid()
  limit 1
$$;

create or replace function public.eh_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.usuario_tipo() = 'admin'
$$;

create or replace function public.eh_funcionario()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.usuario_tipo() = 'funcionario'
$$;

create or replace function public.eh_vendedor()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.usuario_tipo() = 'vendedor'
$$;

create or replace function public.eh_equipe_interna()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.usuario_tipo() in ('admin', 'funcionario')
$$;