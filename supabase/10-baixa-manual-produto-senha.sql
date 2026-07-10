begin;

create table if not exists public.configuracoes_sistema (
  chave text primary key,
  valor text not null,
  updated_at timestamp with time zone default now()
);

alter table public.configuracoes_sistema enable row level security;

revoke all on public.configuracoes_sistema from anon;
revoke all on public.configuracoes_sistema from authenticated;

insert into public.configuracoes_sistema (chave, valor)
values ('senha_baixa_produto', 'TROQUE-ESTA-SENHA')
on conflict (chave) do nothing;

-- Depois de rodar este arquivo, configure a senha real no SQL Editor:
-- update public.configuracoes_sistema
-- set valor = 'SUA-SENHA-AQUI', updated_at = now()
-- where chave = 'senha_baixa_produto';

create or replace function public.registrar_baixa_venda(
  p_produto_id integer,
  p_quantidade integer,
  p_voltagem text default null
)
returns table (
  produto_id integer,
  quantidade integer,
  quantidade_110v integer,
  quantidade_220v integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_produto public.produtos%rowtype;
  v_tipo text;
  v_nome_vendedor text;
  v_quantidade_anterior integer;
  v_quantidade_nova integer;
  v_voltagem_normalizada text;
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  select public.usuario_tipo()
  into v_tipo;

  if v_tipo not in ('admin', 'vendedor') then
    raise exception 'Usuario sem permissao para registrar baixa de venda.';
  end if;

  if p_quantidade is null or p_quantidade <= 0 then
    raise exception 'Quantidade invalida.';
  end if;

  select *
  into v_produto
  from public.produtos
  where id = p_produto_id
  for update;

  if not found then
    raise exception 'Produto nao encontrado.';
  end if;

  if coalesce(v_produto.categoria, 'maquina') <> 'maquina' then
    raise exception 'Produtos devem ser baixados pelo CSV ou pela baixa manual com senha.';
  end if;

  select coalesce(v.nome, p.nome, auth.email())
  into v_nome_vendedor
  from public.perfis p
  left join public.vendedores v on v.auth_user_id = p.user_id
  where p.user_id = auth.uid();

  v_voltagem_normalizada := lower(coalesce(p_voltagem, ''));

  if v_produto.tem_voltagem then
    if v_voltagem_normalizada in ('110', '110v') then
      v_quantidade_anterior := v_produto.quantidade_110v;
      v_quantidade_nova := v_produto.quantidade_110v - p_quantidade;

      if v_quantidade_nova < 0 then
        raise exception 'Estoque insuficiente para 110v.';
      end if;

      update public.produtos
      set
        quantidade_110v = v_quantidade_nova,
        ultima_baixa_vendedor = v_nome_vendedor,
        ultima_baixa_em = now(),
        ultima_baixa_voltagem = '110v'
      where id = p_produto_id;

      insert into public.historico (
        produto_id,
        quantidade_anterior,
        quantidade_nova,
        usuario,
        voltagem,
        tipo,
        vendedor
      )
      values (
        p_produto_id,
        v_quantidade_anterior,
        v_quantidade_nova,
        auth.email(),
        '110v',
        'baixa',
        v_nome_vendedor
      );

    elsif v_voltagem_normalizada in ('220', '220v') then
      v_quantidade_anterior := v_produto.quantidade_220v;
      v_quantidade_nova := v_produto.quantidade_220v - p_quantidade;

      if v_quantidade_nova < 0 then
        raise exception 'Estoque insuficiente para 220v.';
      end if;

      update public.produtos
      set
        quantidade_220v = v_quantidade_nova,
        ultima_baixa_vendedor = v_nome_vendedor,
        ultima_baixa_em = now(),
        ultima_baixa_voltagem = '220v'
      where id = p_produto_id;

      insert into public.historico (
        produto_id,
        quantidade_anterior,
        quantidade_nova,
        usuario,
        voltagem,
        tipo,
        vendedor
      )
      values (
        p_produto_id,
        v_quantidade_anterior,
        v_quantidade_nova,
        auth.email(),
        '220v',
        'baixa',
        v_nome_vendedor
      );

    else
      raise exception 'Voltagem obrigatoria para este produto.';
    end if;

  else
    v_quantidade_anterior := v_produto.quantidade;
    v_quantidade_nova := v_produto.quantidade - p_quantidade;

    if v_quantidade_nova < 0 then
      raise exception 'Estoque insuficiente.';
    end if;

    update public.produtos
    set
      quantidade = v_quantidade_nova,
      ultima_baixa_vendedor = v_nome_vendedor,
      ultima_baixa_em = now(),
      ultima_baixa_voltagem = null
    where id = p_produto_id;

    insert into public.historico (
      produto_id,
      quantidade_anterior,
      quantidade_nova,
      usuario,
      voltagem,
      tipo,
      vendedor
    )
    values (
      p_produto_id,
      v_quantidade_anterior,
      v_quantidade_nova,
      auth.email(),
      null,
      'baixa',
      v_nome_vendedor
    );
  end if;

  return query
  select
    p.id,
    p.quantidade,
    p.quantidade_110v,
    p.quantidade_220v
  from public.produtos p
  where p.id = p_produto_id;
end;
$$;

create or replace function public.registrar_baixa_produto_manual(
  p_produto_id integer,
  p_quantidade integer,
  p_senha text,
  p_voltagem text default null
)
returns table (
  produto_id integer,
  quantidade integer,
  quantidade_110v integer,
  quantidade_220v integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_produto public.produtos%rowtype;
  v_tipo text;
  v_senha text;
  v_nome_vendedor text;
  v_quantidade_anterior integer;
  v_quantidade_nova integer;
  v_voltagem_normalizada text;
begin
  if auth.uid() is null then
    raise exception 'Usuario nao autenticado.';
  end if;

  select public.usuario_tipo()
  into v_tipo;

  if v_tipo not in ('admin', 'vendedor') then
    raise exception 'Usuario sem permissao para registrar baixa manual de produto.';
  end if;

  if p_quantidade is null or p_quantidade <= 0 then
    raise exception 'Quantidade invalida.';
  end if;

  select valor
  into v_senha
  from public.configuracoes_sistema
  where chave = 'senha_baixa_produto';

  if v_senha is null or v_senha = 'TROQUE-ESTA-SENHA' then
    raise exception 'Senha de baixa manual de produto nao configurada.';
  end if;

  if p_senha is null or p_senha <> v_senha then
    raise exception 'Senha de autorizacao invalida.';
  end if;

  select *
  into v_produto
  from public.produtos
  where id = p_produto_id
  for update;

  if not found then
    raise exception 'Produto nao encontrado.';
  end if;

  if coalesce(v_produto.categoria, 'maquina') <> 'produto' then
    raise exception 'Esta funcao e exclusiva para baixa manual de produtos.';
  end if;

  select coalesce(v.nome, p.nome, auth.email())
  into v_nome_vendedor
  from public.perfis p
  left join public.vendedores v on v.auth_user_id = p.user_id
  where p.user_id = auth.uid();

  v_voltagem_normalizada := lower(coalesce(p_voltagem, ''));

  if v_produto.tem_voltagem then
    if v_voltagem_normalizada in ('110', '110v') then
      v_quantidade_anterior := v_produto.quantidade_110v;
      v_quantidade_nova := v_produto.quantidade_110v - p_quantidade;

      if v_quantidade_nova < 0 then
        raise exception 'Estoque insuficiente para 110v.';
      end if;

      update public.produtos
      set
        quantidade_110v = v_quantidade_nova,
        ultima_baixa_vendedor = v_nome_vendedor,
        ultima_baixa_em = now(),
        ultima_baixa_voltagem = '110v'
      where id = p_produto_id;

      insert into public.historico (
        produto_id,
        quantidade_anterior,
        quantidade_nova,
        usuario,
        voltagem,
        tipo,
        vendedor
      )
      values (
        p_produto_id,
        v_quantidade_anterior,
        v_quantidade_nova,
        auth.email(),
        '110v',
        'baixa_manual_produto',
        v_nome_vendedor
      );

    elsif v_voltagem_normalizada in ('220', '220v') then
      v_quantidade_anterior := v_produto.quantidade_220v;
      v_quantidade_nova := v_produto.quantidade_220v - p_quantidade;

      if v_quantidade_nova < 0 then
        raise exception 'Estoque insuficiente para 220v.';
      end if;

      update public.produtos
      set
        quantidade_220v = v_quantidade_nova,
        ultima_baixa_vendedor = v_nome_vendedor,
        ultima_baixa_em = now(),
        ultima_baixa_voltagem = '220v'
      where id = p_produto_id;

      insert into public.historico (
        produto_id,
        quantidade_anterior,
        quantidade_nova,
        usuario,
        voltagem,
        tipo,
        vendedor
      )
      values (
        p_produto_id,
        v_quantidade_anterior,
        v_quantidade_nova,
        auth.email(),
        '220v',
        'baixa_manual_produto',
        v_nome_vendedor
      );

    else
      raise exception 'Voltagem obrigatoria para este produto.';
    end if;

  else
    v_quantidade_anterior := v_produto.quantidade;
    v_quantidade_nova := v_produto.quantidade - p_quantidade;

    if v_quantidade_nova < 0 then
      raise exception 'Estoque insuficiente.';
    end if;

    update public.produtos
    set
      quantidade = v_quantidade_nova,
      ultima_baixa_vendedor = v_nome_vendedor,
      ultima_baixa_em = now(),
      ultima_baixa_voltagem = null
    where id = p_produto_id;

    insert into public.historico (
      produto_id,
      quantidade_anterior,
      quantidade_nova,
      usuario,
      voltagem,
      tipo,
      vendedor
    )
    values (
      p_produto_id,
      v_quantidade_anterior,
      v_quantidade_nova,
      auth.email(),
      null,
      'baixa_manual_produto',
      v_nome_vendedor
    );
  end if;

  return query
  select
    p.id,
    p.quantidade,
    p.quantidade_110v,
    p.quantidade_220v
  from public.produtos p
  where p.id = p_produto_id;
end;
$$;

grant execute on function public.registrar_baixa_venda(integer, integer, text) to authenticated;
grant execute on function public.registrar_baixa_produto_manual(integer, integer, text, text) to authenticated;

commit;
