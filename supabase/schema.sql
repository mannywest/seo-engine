-- Lodestar approval inbox: database schema for Supabase (Postgres).
-- Run once in the Supabase SQL editor on a new project. Safe to read top to bottom:
--   1. clients          one row per business we write for
--   2. client_members   which logged-in people may see which client (this is the "key card" list)
--   3. inbox_items      one row per article waiting for, or past, a person's say-so
--   4. row-level security so a person only ever sees their own client's articles
--   5. a guard that stops a logged-in person doing anything except approve / reject / edit the text
--
-- The engine writes with the service key (bypasses row-level security). The web app writes with the
-- person's own login, so everything below is enforced by the database, not by the web page.

create table if not exists public.clients (
  id          text primary key,                  -- same id as in clients/<id>.json
  name        text not null,
  created_at  timestamptz not null default now()
);

create table if not exists public.client_members (
  client_id   text not null references public.clients (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        text not null default 'owner' check (role in ('owner', 'reviewer')),
  created_at  timestamptz not null default now(),
  primary key (client_id, user_id)
);
create index if not exists client_members_user_idx on public.client_members (user_id);

-- Mirrors InboxItem in src/inbox.ts, field for field.
create table if not exists public.inbox_items (
  client_id      text not null references public.clients (id) on delete cascade,
  id             text not null,                  -- the article's slug
  added_at       timestamptz not null,
  status         text not null check (status in ('waiting', 'approved', 'rejected', 'published', 'publish_failed')),
  reason         text not null,                  -- why it is here, in plain English
  title          text not null,
  description    text not null,
  tags           jsonb not null default '[]'::jsonb,
  body           text not null,
  topic          jsonb not null,                 -- { title, slug, keyword, intent, outline[] }
  sources        jsonb not null default '[]'::jsonb,   -- [{ title, url }]
  quality        jsonb not null,                 -- { passed, score, issues[], warnings[] }
  decided_at     timestamptz,
  decided_by     text,
  note           text,
  edited         boolean,                        -- true when a person changed the text before approving
  delivered_to   text,
  delivery_note  text,
  ledger_id      text,                           -- change-ledger entry made on delivery, so it can be taken back
  updated_at     timestamptz not null default now(),
  primary key (client_id, id)
);
create index if not exists inbox_items_status_idx on public.inbox_items (client_id, status);

-- Is the current logged-in person allowed to see this client? (security definer so the check itself
-- is not blocked by row-level security on client_members.)
create or replace function public.is_client_member(p_client_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.client_members m
    where m.client_id = p_client_id and m.user_id = auth.uid()
  );
$$;

alter table public.clients        enable row level security;
alter table public.client_members enable row level security;
alter table public.inbox_items    enable row level security;

-- Read: only your own client(s). Nobody logged in can insert or delete anything; only the engine can.
drop policy if exists clients_read on public.clients;
create policy clients_read on public.clients
  for select to authenticated using (public.is_client_member(id));

drop policy if exists members_read_own on public.client_members;
create policy members_read_own on public.client_members
  for select to authenticated using (user_id = auth.uid());

drop policy if exists inbox_read on public.inbox_items;
create policy inbox_read on public.inbox_items
  for select to authenticated using (public.is_client_member(client_id));

drop policy if exists inbox_decide on public.inbox_items;
create policy inbox_decide on public.inbox_items
  for update to authenticated
  using (public.is_client_member(client_id))
  with check (public.is_client_member(client_id));

-- The guard. A logged-in person may only: approve or reject an article that is not yet published, and
-- (when approving) correct its text. Everything else on the row is read-only to them. Who decided and
-- when are stamped by the database, so they cannot be faked from the web page.
-- The engine (service key) is not restricted, so it can record delivery results.
create or replace function public.inbox_items_guard()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();

  if coalesce(auth.role(), '') = 'service_role' then
    return new;
  end if;

  if old.status = 'published' then
    raise exception 'That article is already published.' using errcode = 'check_violation';
  end if;
  if new.status not in ('approved', 'rejected') then
    raise exception 'You can only approve or reject an article.' using errcode = 'check_violation';
  end if;

  if new.client_id is distinct from old.client_id
     or new.id is distinct from old.id
     or new.added_at is distinct from old.added_at
     or new.reason is distinct from old.reason
     or new.title is distinct from old.title
     or new.description is distinct from old.description
     or new.tags is distinct from old.tags
     or new.topic is distinct from old.topic
     or new.sources is distinct from old.sources
     or new.quality is distinct from old.quality
     or new.delivered_to is distinct from old.delivered_to
     or new.delivery_note is distinct from old.delivery_note
     or new.ledger_id is distinct from old.ledger_id then
    raise exception 'Only the decision and the text can be changed.' using errcode = 'check_violation';
  end if;

  if new.status = 'rejected' and new.body is distinct from old.body then
    raise exception 'Text can only be edited when approving.' using errcode = 'check_violation';
  end if;
  if new.status = 'approved' and new.body is distinct from old.body then
    if btrim(new.body) = '' then
      raise exception 'The edited text is empty.' using errcode = 'check_violation';
    end if;
    new.edited := true;
  end if;

  new.decided_at := now();
  new.decided_by := coalesce(auth.jwt() ->> 'email', new.decided_by);
  return new;
end;
$$;

drop trigger if exists inbox_items_guard on public.inbox_items;
create trigger inbox_items_guard
  before update on public.inbox_items
  for each row execute function public.inbox_items_guard();
