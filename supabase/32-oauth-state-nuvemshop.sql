begin;

create table public.nuvemshop_oauth_tentativas (
  id uuid primary key default gen_random_uuid(),
  ordem bigint generated always as identity not null unique,
  state_hash bytea not null unique,
  criado_em timestamp with time zone not null default clock_timestamp(),
  expira_em timestamp with time zone not null,
  consumido_em timestamp with time zone,
  concluido_em timestamp with time zone,
  falhou_em timestamp with time zone,
  store_id bigint,
  status text not null default 'pendente',
  erro_codigo text,
  constraint nuvemshop_oauth_tentativas_hash_check
    check (octet_length(state_hash) = 32),
  constraint nuvemshop_oauth_tentativas_expiracao_check
    check (expira_em > criado_em and expira_em <= criado_em + interval '10 minutes'),
  constraint nuvemshop_oauth_tentativas_datas_check
    check (
      (consumido_em is null or consumido_em >= criado_em)
      and (concluido_em is null or concluido_em >= consumido_em)
      and (falhou_em is null or falhou_em >= consumido_em)
    ),
  constraint nuvemshop_oauth_tentativas_store_check
    check (store_id is null or store_id > 0),
  constraint nuvemshop_oauth_tentativas_status_check
    check (status in ('pendente', 'reservada', 'concluida', 'falhou')),
  constraint nuvemshop_oauth_tentativas_erro_check
    check (erro_codigo is null or erro_codigo in (
      'state_expirado',
      'troca_indisponivel',
      'troca_timeout',
      'troca_recusada',
      'resposta_invalida',
      'protecao_token_falhou',
      'conclusao_expirada',
      'tentativa_antiga',
      'finalizacao_falhou',
      'falha_inesperada'
    )),
  constraint nuvemshop_oauth_tentativas_estado_check
    check (
      (status = 'pendente'
        and consumido_em is null
        and concluido_em is null
        and falhou_em is null
        and store_id is null
        and erro_codigo is null)
      or
      (status = 'reservada'
        and consumido_em is not null
        and concluido_em is null
        and falhou_em is null
        and store_id is null
        and erro_codigo is null)
      or
      (status = 'concluida'
        and consumido_em is not null
        and concluido_em is not null
        and falhou_em is null
        and store_id is not null
        and erro_codigo is null)
      or
      (status = 'falhou'
        and consumido_em is not null
        and concluido_em is null
        and falhou_em is not null
        and store_id is null
        and erro_codigo is not null)
    )
);

alter table public.nuvemshop_oauth_tentativas enable row level security;

revoke all on table public.nuvemshop_oauth_tentativas from public;
revoke all on table public.nuvemshop_oauth_tentativas from anon;
revoke all on table public.nuvemshop_oauth_tentativas from authenticated;
revoke all on table public.nuvemshop_oauth_tentativas from service_role;

alter table public.nuvemshop_conexoes
  add column oauth_tentativa_id uuid,
  add column oauth_iniciado_em timestamp with time zone,
  add column oauth_tentativa_ordem bigint;

alter table public.nuvemshop_oauth_tentativas
  add constraint nuvemshop_oauth_tentativas_id_ordem_key unique (id, ordem);

alter table public.nuvemshop_conexoes
  add constraint nuvemshop_conexoes_oauth_tentativa_fk
    foreign key (oauth_tentativa_id, oauth_tentativa_ordem)
    references public.nuvemshop_oauth_tentativas(id, ordem)
    on delete restrict,
  add constraint nuvemshop_conexoes_oauth_tentativa_check
    check (
      (oauth_tentativa_id is null and oauth_iniciado_em is null and oauth_tentativa_ordem is null)
      or
      (oauth_tentativa_id is not null and oauth_iniciado_em is not null and oauth_tentativa_ordem is not null and oauth_tentativa_ordem > 0)
    );

create unique index nuvemshop_conexoes_oauth_tentativa_idx
  on public.nuvemshop_conexoes (oauth_tentativa_id)
  where oauth_tentativa_id is not null;

create or replace function public.registrar_tentativa_oauth_nuvemshop(
  p_state_hash bytea
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
  v_agora timestamp with time zone := clock_timestamp();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Operacao permitida somente ao servico interno.';
  end if;

  if p_state_hash is null or octet_length(p_state_hash) <> 32 then
    raise exception 'Hash de state invalido.';
  end if;

  insert into public.nuvemshop_oauth_tentativas (
    state_hash,
    criado_em,
    expira_em
  ) values (
    p_state_hash,
    v_agora,
    v_agora + interval '10 minutes'
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.reservar_tentativa_oauth_nuvemshop(
  p_state_hash bytea
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tentativa public.nuvemshop_oauth_tentativas%rowtype;
  v_agora timestamp with time zone;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Operacao permitida somente ao servico interno.';
  end if;

  if p_state_hash is null or octet_length(p_state_hash) <> 32 then
    return null;
  end if;

  select *
    into v_tentativa
  from public.nuvemshop_oauth_tentativas
  where state_hash = p_state_hash
  for update;

  if not found or v_tentativa.status <> 'pendente' then
    return null;
  end if;

  if v_tentativa.expira_em <= clock_timestamp() then
    v_agora := clock_timestamp();
    update public.nuvemshop_oauth_tentativas
    set status = 'falhou',
        consumido_em = v_agora,
        falhou_em = v_agora,
        erro_codigo = 'state_expirado'
    where id = v_tentativa.id;
    return null;
  end if;

  update public.nuvemshop_oauth_tentativas
  set status = 'reservada',
      consumido_em = clock_timestamp()
  where id = v_tentativa.id;

  return v_tentativa.id;
end;
$$;

create or replace function public.falhar_tentativa_oauth_nuvemshop(
  p_tentativa_id uuid,
  p_erro_codigo text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_atualizada uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Operacao permitida somente ao servico interno.';
  end if;

  if p_tentativa_id is null
     or p_erro_codigo is null
     or p_erro_codigo not in (
       'troca_indisponivel',
       'troca_timeout',
       'troca_recusada',
       'resposta_invalida',
       'protecao_token_falhou',
       'finalizacao_falhou',
       'falha_inesperada'
     ) then
    raise exception 'Falha OAuth invalida.';
  end if;

  update public.nuvemshop_oauth_tentativas
  set status = 'falhou',
      falhou_em = clock_timestamp(),
      erro_codigo = p_erro_codigo
  where id = p_tentativa_id
    and status = 'reservada'
  returning id into v_atualizada;

  return v_atualizada is not null;
end;
$$;

create or replace function public.concluir_tentativa_oauth_nuvemshop(
  p_tentativa_id uuid,
  p_store_id bigint,
  p_token_cifrado text,
  p_token_iv text,
  p_escopos text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tentativa public.nuvemshop_oauth_tentativas%rowtype;
  v_conexao public.nuvemshop_conexoes%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Operacao permitida somente ao servico interno.';
  end if;

  if p_tentativa_id is null
     or p_store_id is null
     or p_store_id <= 0
     or p_token_cifrado is null
     or length(p_token_cifrado) <= 20
     or p_token_iv is null
     or length(p_token_iv) <= 8 then
    raise exception 'Dados de conclusao OAuth invalidos.';
  end if;

  select *
    into v_tentativa
  from public.nuvemshop_oauth_tentativas
  where id = p_tentativa_id
  for update;

  if not found or v_tentativa.status <> 'reservada' then
    return false;
  end if;

  if v_tentativa.expira_em <= clock_timestamp() then
    update public.nuvemshop_oauth_tentativas
    set status = 'falhou',
        falhou_em = clock_timestamp(),
        erro_codigo = 'conclusao_expirada'
    where id = v_tentativa.id;
    return false;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('nuvemshop_oauth:' || p_store_id::text, 0)
  );

  select *
    into v_conexao
  from public.nuvemshop_conexoes
  where store_id = p_store_id
  for update;

  if found
     and v_conexao.oauth_iniciado_em is not null
     and (
       v_tentativa.criado_em < v_conexao.oauth_iniciado_em
       or (
         v_tentativa.criado_em = v_conexao.oauth_iniciado_em
         and v_conexao.oauth_tentativa_ordem is not null
         and v_tentativa.ordem <= v_conexao.oauth_tentativa_ordem
       )
     ) then
    update public.nuvemshop_oauth_tentativas
    set status = 'falhou',
        falhou_em = clock_timestamp(),
        erro_codigo = 'tentativa_antiga'
    where id = v_tentativa.id;
    return false;
  end if;

  insert into public.nuvemshop_conexoes (
    store_id,
    token_cifrado,
    token_iv,
    escopos,
    conectado_em,
    escrita_habilitada,
    escrita_habilitada_em,
    escrita_habilitada_por,
    escrita_habilitada_ate,
    escrita_simulacao_id,
    oauth_tentativa_id,
    oauth_iniciado_em,
    oauth_tentativa_ordem
  ) values (
    p_store_id,
    p_token_cifrado,
    p_token_iv,
    p_escopos,
    clock_timestamp(),
    false,
    null,
    null,
    null,
    null,
    v_tentativa.id,
    v_tentativa.criado_em,
    v_tentativa.ordem
  )
  on conflict (store_id) do update
  set token_cifrado = excluded.token_cifrado,
      token_iv = excluded.token_iv,
      escopos = excluded.escopos,
      conectado_em = excluded.conectado_em,
      escrita_habilitada = false,
      escrita_habilitada_em = null,
      escrita_habilitada_por = null,
      escrita_habilitada_ate = null,
      escrita_simulacao_id = null,
      oauth_tentativa_id = excluded.oauth_tentativa_id,
      oauth_iniciado_em = excluded.oauth_iniciado_em,
      oauth_tentativa_ordem = excluded.oauth_tentativa_ordem;

  update public.nuvemshop_oauth_tentativas
  set status = 'concluida',
      concluido_em = clock_timestamp(),
      store_id = p_store_id
  where id = v_tentativa.id;

  return true;
end;
$$;

revoke all on function public.registrar_tentativa_oauth_nuvemshop(bytea)
from public, anon, authenticated;
revoke all on function public.reservar_tentativa_oauth_nuvemshop(bytea)
from public, anon, authenticated;
revoke all on function public.falhar_tentativa_oauth_nuvemshop(uuid, text)
from public, anon, authenticated;
revoke all on function public.concluir_tentativa_oauth_nuvemshop(uuid, bigint, text, text, text)
from public, anon, authenticated;

grant execute on function public.registrar_tentativa_oauth_nuvemshop(bytea)
to service_role;
grant execute on function public.reservar_tentativa_oauth_nuvemshop(bytea)
to service_role;
grant execute on function public.falhar_tentativa_oauth_nuvemshop(uuid, text)
to service_role;
grant execute on function public.concluir_tentativa_oauth_nuvemshop(uuid, bigint, text, text, text)
to service_role;

notify pgrst, 'reload schema';

commit;
