begin;

set local lock_timeout = '10s';
set local statement_timeout = '60s';

create table public.nuvemshop_vinculos_eventos (
  id bigserial primary key,
  vinculo_id bigint references public.nuvemshop_vinculos(id) on delete set null,
  store_id bigint not null references public.nuvemshop_conexoes(store_id) on delete restrict,
  produto_id integer not null,
  voltagem text,
  nuvemshop_produto_id bigint not null,
  nuvemshop_variante_id bigint,
  tipo text not null,
  motivo text not null,
  desativado_por uuid not null,
  desativado_em timestamp with time zone not null default clock_timestamp(),
  constraint nuvemshop_vinculos_eventos_voltagem_check
    check (voltagem is null or voltagem in ('110V', '220V')),
  constraint nuvemshop_vinculos_eventos_produto_externo_check
    check (nuvemshop_produto_id > 0),
  constraint nuvemshop_vinculos_eventos_variante_externa_check
    check (nuvemshop_variante_id is null or nuvemshop_variante_id > 0),
  constraint nuvemshop_vinculos_eventos_tipo_check
    check (tipo in ('manual', 'produto_ausente', 'variante_ausente')),
  constraint nuvemshop_vinculos_eventos_motivo_check
    check (length(btrim(motivo)) between 1 and 500)
);

create index nuvemshop_vinculos_eventos_store_data_idx
  on public.nuvemshop_vinculos_eventos (store_id, desativado_em desc);

create index nuvemshop_vinculos_eventos_vinculo_idx
  on public.nuvemshop_vinculos_eventos (vinculo_id)
  where vinculo_id is not null;

alter table public.nuvemshop_vinculos_eventos enable row level security;

revoke all on table public.nuvemshop_vinculos_eventos from public, anon, authenticated;
grant select on table public.nuvemshop_vinculos_eventos to authenticated;

create policy "Nuvemshop vinculos eventos: admin pode ler"
on public.nuvemshop_vinculos_eventos
for select
to authenticated
using (public.eh_admin());

revoke update, delete on table public.nuvemshop_vinculos from authenticated;
drop policy if exists "Nuvemshop vinculos: admin pode atualizar" on public.nuvemshop_vinculos;
drop policy if exists "Nuvemshop vinculos: admin pode excluir" on public.nuvemshop_vinculos;

create or replace function public.validar_vinculo_nuvemshop()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_tem_voltagem boolean;
  v_produto_ativo boolean;
begin
  if tg_op = 'UPDATE'
     and new.ativo is distinct from old.ativo
     and (
       coalesce(auth.role(), '') <> 'service_role'
       or current_setting('app.desativar_vinculo_nuvemshop', true) is distinct from 'permitido'
     ) then
    raise exception 'O status do vinculo Nuvemshop deve ser alterado pelo fluxo seguro.';
  end if;

  select tem_voltagem, ativo
    into v_tem_voltagem, v_produto_ativo
  from public.produtos
  where id = new.produto_id
  for key share;

  if not found then
    raise exception 'Produto local nao encontrado.';
  end if;

  if not v_produto_ativo
     and (
       (tg_op = 'INSERT' and coalesce(new.ativo, false))
       or (
         tg_op = 'UPDATE'
         and (
           new.produto_id is distinct from old.produto_id
           or (coalesce(new.ativo, false) and not coalesce(old.ativo, false))
         )
       )
     ) then
    raise exception 'Produto inativo nao pode receber vinculo Nuvemshop ativo.';
  end if;

  new.voltagem := nullif(upper(trim(new.voltagem)), '');
  new.nuvemshop_sku := nullif(trim(new.nuvemshop_sku), '');
  new.unidades_por_venda := coalesce(new.unidades_por_venda, 1);

  if new.unidades_por_venda < 1 or new.unidades_por_venda > 10000 then
    raise exception 'Unidades por venda deve ficar entre 1 e 10000.';
  end if;

  if v_tem_voltagem and new.voltagem is null then
    raise exception 'Informe 110V ou 220V para este produto.';
  end if;

  if not v_tem_voltagem and new.voltagem is not null then
    raise exception 'Produto sem voltagem deve usar vinculo unico.';
  end if;

  return new;
end;
$$;

revoke all on function public.validar_vinculo_nuvemshop()
from public, anon, authenticated;

create or replace function public.desativar_vinculo_nuvemshop(
  p_store_id bigint,
  p_vinculo_id bigint,
  p_tipo text,
  p_motivo text,
  p_solicitado_por uuid,
  p_nuvemshop_produto_id bigint,
  p_nuvemshop_variante_id bigint default null
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_vinculo public.nuvemshop_vinculos%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Operacao permitida somente ao servico interno.'
      using errcode = '42501';
  end if;

  if p_store_id is null or p_store_id <= 0
     or p_vinculo_id is null or p_vinculo_id <= 0
     or p_nuvemshop_produto_id is null or p_nuvemshop_produto_id <= 0
     or (p_nuvemshop_variante_id is not null and p_nuvemshop_variante_id <= 0)
     or p_solicitado_por is null
     or p_tipo not in ('manual', 'produto_ausente', 'variante_ausente')
     or length(btrim(coalesce(p_motivo, ''))) not between 1 and 500 then
    raise exception 'Dados de desativacao de vinculo invalidos.';
  end if;

  if p_tipo = 'produto_ausente'
     and p_motivo <> 'Produto externo nao encontrado na Nuvemshop.' then
    raise exception 'Motivo de vinculo quebrado invalido.';
  end if;
  if p_tipo = 'variante_ausente'
     and p_motivo <> 'Variante externa nao encontrada na Nuvemshop.' then
    raise exception 'Motivo de vinculo quebrado invalido.';
  end if;

  if not exists (
    select 1
    from public.perfis p
    where p.user_id = p_solicitado_por
      and p.tipo = 'admin'
  ) then
    raise exception 'Solicitante nao e administrador.'
      using errcode = '42501';
  end if;

  select *
    into v_vinculo
  from public.nuvemshop_vinculos
  where id = p_vinculo_id
    and store_id = p_store_id
  for update;

  if not found or not v_vinculo.ativo then
    return false;
  end if;

  if v_vinculo.nuvemshop_produto_id <> p_nuvemshop_produto_id
     or v_vinculo.nuvemshop_variante_id is distinct from p_nuvemshop_variante_id then
    raise exception 'O vinculo mudou durante a verificacao. Consulte novamente antes de desativar.';
  end if;

  perform set_config('app.desativar_vinculo_nuvemshop', 'permitido', true);

  update public.nuvemshop_vinculos
  set ativo = false
  where id = v_vinculo.id
    and store_id = p_store_id
    and ativo;

  insert into public.nuvemshop_vinculos_eventos (
    vinculo_id,
    store_id,
    produto_id,
    voltagem,
    nuvemshop_produto_id,
    nuvemshop_variante_id,
    tipo,
    motivo,
    desativado_por
  ) values (
    v_vinculo.id,
    v_vinculo.store_id,
    v_vinculo.produto_id,
    v_vinculo.voltagem,
    v_vinculo.nuvemshop_produto_id,
    v_vinculo.nuvemshop_variante_id,
    p_tipo,
    btrim(p_motivo),
    p_solicitado_por
  );

  return true;
end;
$$;

revoke all on function public.desativar_vinculo_nuvemshop(
  bigint, bigint, text, text, uuid, bigint, bigint
)
from public, anon, authenticated;

grant execute on function public.desativar_vinculo_nuvemshop(
  bigint, bigint, text, text, uuid, bigint, bigint
)
to service_role;

comment on table public.nuvemshop_vinculos_eventos is
  'Auditoria protegida de desativacoes manuais ou confirmadas de vinculos Nuvemshop.';
comment on function public.desativar_vinculo_nuvemshop(
  bigint, bigint, text, text, uuid, bigint, bigint
) is
  'Desativa atomica e auditadamente um unico vinculo Nuvemshop da loja informada.';

notify pgrst, 'reload schema';

commit;
