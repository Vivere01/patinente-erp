-- =====================================================================
--  SISTEMA DE LOCAÇÃO — ESTRUTURA DO BANCO DE DADOS
--  Cole este arquivo inteiro no SQL Editor do Supabase e clique em RUN.
--  Pode rodar mais de uma vez sem problema: nada é apagado.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ESTADO — a operação atual (frota, clientes, locações, caixa...)
--    Fica em um único registro versionado. A versão evita que dois
--    aparelhos salvando ao mesmo tempo apaguem o trabalho um do outro.
-- ---------------------------------------------------------------------
create table if not exists public.estado (
  id             int primary key default 1,
  doc            jsonb       not null default '{}'::jsonb,
  versao         bigint      not null default 0,
  atualizado_em  timestamptz not null default now(),
  atualizado_por text,
  constraint estado_registro_unico check (id = 1)
);

insert into public.estado (id, doc, versao)
values (1, '{}'::jsonb, 0)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------
-- 2. EVENTOS — histórico append-only. Toda operação vira uma linha.
--    Ninguém edita nem apaga: é a garantia de que nada se perde,
--    mesmo que alguém erre no estado atual.
-- ---------------------------------------------------------------------
create table if not exists public.eventos (
  id       bigserial primary key,
  ts       timestamptz not null default now(),
  usuario  text,
  acao     text not null,
  detalhe  text,
  payload  jsonb
);

create index if not exists eventos_ts_idx    on public.eventos (ts desc);
create index if not exists eventos_acao_idx  on public.eventos (acao);

-- ---------------------------------------------------------------------
-- 3. SNAPSHOTS — cópia diária automática do estado.
--    Rede de segurança extra além do backup do Supabase.
-- ---------------------------------------------------------------------
create table if not exists public.snapshots (
  id        bigserial primary key,
  criado_em timestamptz not null default now(),
  versao    bigint,
  doc       jsonb not null
);

create index if not exists snapshots_data_idx on public.snapshots (criado_em desc);

-- ---------------------------------------------------------------------
-- 4. SALVAR COM CONTROLE DE VERSÃO
--    Se outro aparelho salvou antes, devolve ok=false e a versão nova,
--    e o aplicativo recarrega em vez de sobrescrever.
-- ---------------------------------------------------------------------
create or replace function public.salvar_estado(
  p_doc    jsonb,
  p_versao bigint,
  p_por    text
)
returns table (ok boolean, versao bigint, doc jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_atual bigint;
begin
  select e.versao into v_atual from public.estado e where e.id = 1 for update;

  if v_atual is distinct from p_versao then
    -- alguém salvou antes: devolve o estado mais novo
    return query
      select false, e.versao, e.doc from public.estado e where e.id = 1;
    return;
  end if;

  update public.estado e
     set doc = p_doc,
         versao = e.versao + 1,
         atualizado_em = now(),
         atualizado_por = p_por
   where e.id = 1;

  -- snapshot no máximo 1x por dia
  if not exists (
    select 1 from public.snapshots s
     where s.criado_em >= date_trunc('day', now())
  ) then
    insert into public.snapshots (versao, doc)
    select e.versao, e.doc from public.estado e where e.id = 1;
  end if;

  return query
    select true, e.versao, e.doc from public.estado e where e.id = 1;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. SEGURANÇA (RLS) — só quem estiver logado enxerga os dados.
-- ---------------------------------------------------------------------
alter table public.estado    enable row level security;
alter table public.eventos   enable row level security;
alter table public.snapshots enable row level security;

drop policy if exists estado_ler     on public.estado;
drop policy if exists estado_gravar  on public.estado;
drop policy if exists eventos_ler    on public.eventos;
drop policy if exists eventos_criar  on public.eventos;
drop policy if exists snap_ler       on public.snapshots;

create policy estado_ler    on public.estado    for select to authenticated using (true);
create policy estado_gravar on public.estado    for update to authenticated using (true) with check (true);
create policy eventos_ler   on public.eventos   for select to authenticated using (true);
create policy eventos_criar on public.eventos   for insert to authenticated with check (true);
create policy snap_ler      on public.snapshots for select to authenticated using (true);

-- eventos e snapshots NÃO têm política de update nem de delete.
-- Sem política, a operação é negada. O histórico é imutável por construção.

-- ---------------------------------------------------------------------
-- 6. ATUALIZAÇÃO EM TEMPO REAL entre os aparelhos
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname = 'supabase_realtime' and tablename = 'estado'
  ) then
    alter publication supabase_realtime add table public.estado;
  end if;
end $$;

-- ---------------------------------------------------------------------
-- 7. PASTA DAS FOTOS DE VISTORIA (privada)
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('vistorias', 'vistorias', false)
on conflict (id) do nothing;

drop policy if exists vistorias_ler   on storage.objects;
drop policy if exists vistorias_criar on storage.objects;

create policy vistorias_ler on storage.objects
  for select to authenticated using (bucket_id = 'vistorias');

create policy vistorias_criar on storage.objects
  for insert to authenticated with check (bucket_id = 'vistorias');

-- fotos também não podem ser apagadas nem trocadas pela aplicação.

-- =====================================================================
--  PRONTO. Se apareceu "Success. No rows returned", deu tudo certo.
-- =====================================================================
