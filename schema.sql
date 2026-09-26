-- =====================================================================
--  SISTEMA DE LOCAÇÃO DE PATINETES E MOTOS ELÉTRICAS
--  Banco de dados para Postgres hospedado na Vercel (Marketplace → Neon).
--
--  Como aplicar:
--    npm install
--    vercel env pull .env.local      (ou exporte POSTGRES_URL)
--    npm run schema                  (idempotente: pode rodar de novo)
--  Ou cole este arquivo no SQL Editor do Neon e clique em Run.
--
--  Estrutura: documento de operação versionado + histórico imutável.
--  O controle de acesso fica na camada de API (/api), não no banco —
--  o Postgres é acessado apenas pelas funções da Vercel.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ESTADO — a operação atual (frota, clientes, locações, caixa...).
--    Um único registro. A versão evita que dois aparelhos salvando ao
--    mesmo tempo apaguem o trabalho um do outro (lock otimista).
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
--    Ninguém edita nem apaga: a imutabilidade é do Postgres, não da
--    aplicação (gatilho abaixo nega UPDATE e DELETE).
-- ---------------------------------------------------------------------
create table if not exists public.eventos (
  id       bigserial primary key,
  ts       timestamptz not null default now(),
  usuario  text,
  acao     text not null,
  detalhe  text,
  payload  jsonb
);

create index if not exists eventos_ts_idx   on public.eventos (ts desc);
create index if not exists eventos_acao_idx on public.eventos (acao);

-- ---------------------------------------------------------------------
-- 3. SNAPSHOTS — cópia diária automática do estado, gerada dentro da
--    própria function de gravação (no máximo 1 por dia).
-- ---------------------------------------------------------------------
create table if not exists public.snapshots (
  id        bigserial primary key,
  criado_em timestamptz not null default now(),
  versao    bigint,
  doc       jsonb not null
);

create index if not exists snapshots_data_idx on public.snapshots (criado_em desc);

-- ---------------------------------------------------------------------
-- 4. FOTOS — vistoria de saída e entrada.
--    Guardadas em bytea, servidas por URL temporária assinada (HMAC).
--    Em escala, mova para Vercel Blob: a tabela aceita expurgo por data.
-- ---------------------------------------------------------------------
create table if not exists public.fotos (
  caminho   text primary key,
  mime      text not null default 'image/jpeg',
  bytes     bytea not null,
  tamanho   int,
  criado_em timestamptz not null default now()
);

create index if not exists fotos_data_idx on public.fotos (criado_em);

-- ---------------------------------------------------------------------
-- 5. ASSINATURAS — contrato aberto no celular do cliente.
--    O balcão cria a linha com o texto congelado; o cliente assina pelo
--    link /assinar/{token}; o balcão consulta o status até confirmar.
-- ---------------------------------------------------------------------
create table if not exists public.assinaturas (
  token        text primary key,
  criado_em    timestamptz not null default now(),
  expira_em    timestamptz not null default (now() + interval '6 hours'),
  atualizado_em timestamptz not null default now(),
  cliente_nome text,
  cliente_cpf  text,
  contrato     text not null,
  resumo       jsonb,
  empresa      jsonb,
  status       text not null default 'pendente'
               check (status in ('pendente','assinada')),
  assinatura   text,
  canal        text,
  assinado_em  timestamptz,
  ip           text,
  agente       text,
  locacao_id   text
);

create index if not exists assinaturas_expira_idx  on public.assinaturas (expira_em);
create index if not exists assinaturas_status_idx  on public.assinaturas (status);

-- ---------------------------------------------------------------------
-- 6. IMUTABILIDADE — gatilho que recusa UPDATE/DELETE.
--    Sem gatilho, a regra só existiria na aplicação; aqui vale para
--    qualquer cliente conectado, inclusive o próprio script.
-- ---------------------------------------------------------------------
create or replace function public.bloquear_escrita()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Tabela % é imutável: % não é permitido', TG_TABLE_NAME, TG_OP;
end;
$$;

drop trigger if exists eventos_imutavel on public.eventos;
create trigger eventos_imutavel
  before update or delete on public.eventos
  for each statement execute function public.bloquear_escrita();

-- snapshots podem ser expurgados por rotina, mas nunca editados
drop trigger if exists snapshots_imutavel on public.snapshots;
create trigger snapshots_imutavel
  before update on public.snapshots
  for each statement execute function public.bloquear_escrita();

-- ---------------------------------------------------------------------
-- 7. SALVAR ESTADO COM CONTROLE DE VERSÃO
--    Se outro aparelho salvou antes, devolve ok = false e a versão nova,
--    e a aplicação recarrega em vez de sobrescrever. Nada se perde.
-- ---------------------------------------------------------------------
create or replace function public.salvar_estado(
  p_doc    jsonb,
  p_versao bigint,
  p_por    text
)
returns table (ok boolean, versao bigint, doc jsonb)
language plpgsql
as $$
declare
  v_atual bigint;
begin
  select e.versao into v_atual from public.estado e where e.id = 1 for update;

  if v_atual is distinct from p_versao then
    -- alguém salvou antes: devolve o estado mais novo e não grava
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
-- 8. ROTINAS DE MANUTENÇÃO (retenção — ver dívida técnica 8.3)
-- ---------------------------------------------------------------------
create or replace function public.limpar_fotos(p_dias int)
returns int
language plpgsql
as $$
declare n int;
begin
  delete from public.fotos where criado_em < now() - (p_dias || ' days')::interval;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.limpar_snapshots(p_dias int)
returns int
language plpgsql
as $$
declare n int;
begin
  delete from public.snapshots where criado_em < now() - (p_dias || ' days')::interval;
  get diagnostics n = row_count;
  return n;
end;
$$;

create or replace function public.limpar_assinaturas_vencidas()
returns int
language plpgsql
as $$
declare n int;
begin
  delete from public.assinaturas
   where status = 'pendente' and expira_em < now() - interval '7 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

-- =====================================================================
--  PRONTO. Rode de novo quando quiser: nada é apagado nem duplicado.
-- =====================================================================
