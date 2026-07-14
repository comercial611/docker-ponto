create table if not exists public.perfis (
  user_id uuid primary key references auth.users(id) on delete cascade,
  tipo text not null check (tipo in ('admin', 'funcionario', 'vendedor')),
  nome text,
  created_at timestamp with time zone default now()
);

alter table public.perfis enable row level security;

insert into public.perfis (user_id, tipo, nome)
values
  ('8c865d03-955d-4dd5-8d4f-69287b8d3c4f', 'admin', 'Comercial'),
  ('ea08e6bf-24fa-448e-a34d-b5b999c06c71', 'admin', 'Estoque'),

  ('966f26df-28ce-4c36-8665-417e767cbf62', 'vendedor', 'Ailton'),
  ('2823f9b6-77e4-4a53-889b-6e197cbcda2e', 'vendedor', 'Alex'),
  ('a3bd3929-7050-4333-9b2a-2fdba0257f9d', 'vendedor', 'Alexandre'),
  ('3a77cf51-c895-4b90-a29c-d2b10d897fdd', 'vendedor', 'Allex'),
  ('e4ae977f-d12b-4e5e-986c-83eccf937300', 'vendedor', 'Francielle'),
  ('4ce295d8-435e-48e5-a7e5-c403cf498c15', 'vendedor', 'Francisco'),
  ('018a6fcd-8909-47ac-a533-f054cb017c1a', 'vendedor', 'Georgia'),
  ('c98e8875-6dbf-4200-afc7-fe1ef4a2640a', 'vendedor', 'Gustavo'),
  ('ad218361-3e37-4df3-b925-f5e4da0efefd', 'vendedor', 'Paula'),
  ('22b7d54d-5297-4d91-a3e0-5bda65a97807', 'vendedor', 'Safu'),
  ('3eec2f0c-62a3-4845-8dde-29336ab63ead', 'vendedor', 'Site')
on conflict (user_id) do update
set
  tipo = excluded.tipo,
  nome = excluded.nome;
