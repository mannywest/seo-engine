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

-- ---------------------------------------------------------------------------------------------
-- The engine's notebook (src/stateStore.ts). On GitHub Actions the engine's local files vanish when a run
-- ends, so what it has written, every change it made to a site, the facts a business confirmed and AI usage
-- are kept here instead. Each row holds the whole entry in `data`, plus a few plain columns for searching.
-- Engine only: row-level security is on and there is deliberately NO policy, so a logged-in person (the web
-- app) can read none of this. The engine's service key bypasses row-level security.
-- ---------------------------------------------------------------------------------------------

-- Every article written, so topics never repeat and plan article caps hold.
create table if not exists public.history_entries (
  client_id   text not null references public.clients (id) on delete cascade,
  slug        text not null,
  created_at  timestamptz not null,
  data        jsonb not null,                    -- HistoryEntry in src/history.ts
  primary key (client_id, slug)
);
create index if not exists history_entries_created_idx on public.history_entries (client_id, created_at);

-- Every change made to a client's site, with what is needed to take it back (the "undo" list).
create table if not exists public.ledger_entries (
  client_id   text not null references public.clients (id) on delete cascade,
  id          text not null,                     -- the id an inbox item's ledger_id points to
  at          timestamptz not null,
  status      text not null,
  data        jsonb not null,                    -- LedgerEntry in src/ledger.ts
  primary key (client_id, id)
);
create index if not exists ledger_entries_at_idx on public.ledger_entries (client_id, at);

-- What the business has confirmed about itself (hours, prices, services...). Drafts may state only these.
create table if not exists public.facts (
  client_id    text not null references public.clients (id) on delete cascade,
  id           text not null,
  kind         text not null,
  verified_at  date not null,
  data         jsonb not null,                   -- Fact in src/facts.ts
  primary key (client_id, id)
);

-- Every AI call, as token counts (not money). Only ever added to; the monthly cap is checked against it.
create table if not exists public.usage_entries (
  id         bigint generated always as identity primary key,
  client_id  text not null references public.clients (id) on delete cascade,
  at         timestamptz not null,
  data       jsonb not null                      -- UsageEntry in src/usage.ts
);
create index if not exists usage_entries_client_at_idx on public.usage_entries (client_id, at);

alter table public.history_entries enable row level security;
alter table public.ledger_entries  enable row level security;
alter table public.facts           enable row level security;
alter table public.usage_entries   enable row level security;

-- ---------------------------------------------------------------------------------------------
-- Site connections (the "Connect your website" flow). One row per client says which kind of website they have
-- and how the engine reaches it. The same table serves every platform: GitHub, WordPress, Wix, Shopify, a
-- webhook or a folder. Adding a platform later means a new allowed value and a new connector, not a new table.
--
-- NO SECRETS HERE. `settings` holds only things that are safe to show the client (the repo name, the site
-- address, GitHub's installation number). Keys and passwords live in the Supabase Vault or in the engine's
-- environment; a row may at most name where to look. A check below refuses a row that looks like it holds one.
--
-- Read: a person sees only their own client's connection, so the Connect screen can show "Connected to ...".
-- Write: nobody logged in can write, there is deliberately NO insert/update/delete policy. Only the server
-- piece behind the Connect screen (which has proved who the person is and that they own the site) can.
-- ---------------------------------------------------------------------------------------------
create table if not exists public.site_connections (
  client_id        text primary key references public.clients (id) on delete cascade,   -- one connection per client for now
  platform         text not null check (platform in ('github', 'wordpress', 'wix', 'shopify', 'webhook', 'folder')),
  status           text not null default 'connected' check (status in ('connected', 'needs_attention', 'disconnected')),
  label            text not null,                  -- what the client sees, e.g. "owner/site"
  settings         jsonb not null default '{}'::jsonb check (
                     jsonb_typeof(settings) = 'object'
                     and not (settings ?| array['token', 'password', 'secret', 'privateKey', 'private_key', 'apiKey', 'api_key', 'accessToken', 'access_token'])
                   ),
  connected_by     uuid references auth.users (id) on delete set null,
  connected_at     timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  last_checked_at  timestamptz,
  last_problem     text                            -- plain English, shown to the client when status is needs_attention
);

alter table public.site_connections enable row level security;

drop policy if exists connections_read on public.site_connections;
create policy connections_read on public.site_connections
  for select to authenticated using (public.is_client_member(client_id));

create or replace function public.site_connections_touch()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists site_connections_touch on public.site_connections;
create trigger site_connections_touch
  before update on public.site_connections
  for each row execute function public.site_connections_touch();

-- ---------------------------------------------------------------------------------------------
-- "Connect your website", part 3: who may set it up, the one-time links, and where the GitHub App's key lives.
-- Safe to run again. Everything here is for the server piece behind the Connect screen (it uses the service key);
-- row-level security is ON and there is deliberately NO policy, so a logged-in person can read or write none of it.
-- ---------------------------------------------------------------------------------------------

-- The few people who may create the GitHub App (a one-time job). Not the same as a client's "owner".
-- To add yourself, run this once in the SQL editor with your own login email (do not save it in a file):
--   insert into public.platform_admins (user_id) select id from auth.users where email = 'you@example.com' on conflict do nothing;
create table if not exists public.platform_admins (
  user_id     uuid primary key references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.platform_admins enable row level security;

-- One row per trip to GitHub and back. The link a person follows carries a signed copy of `nonce`; the row says who
-- started it, for which business, and when it stops working. `consumed_at` is set the first time the link comes back,
-- which is what makes it single-use. Nothing secret is stored here.
create table if not exists public.connect_attempts (
  nonce        text primary key,                     -- 32 random bytes, unguessable
  kind         text not null check (kind in ('github_connect', 'github_app_setup', 'github_pick')),
  client_id    text references public.clients (id) on delete cascade,   -- empty for the one-time app set-up
  user_id      uuid not null references auth.users (id) on delete cascade,
  leg          integer not null default 1,           -- 1 = first trip to GitHub, 2 = after installing the app (stops endless loops)
  candidates   jsonb,                                -- for 'github_pick': the repos GitHub confirmed this person can use
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  consumed_at  timestamptz
);
create index if not exists connect_attempts_pick_idx on public.connect_attempts (client_id, user_id, kind, created_at);
alter table public.connect_attempts enable row level security;

-- The GitHub App's id, key and sign-in details live in the Supabase Vault (encrypted), never in a table, file or the browser.
-- These two helpers are the only way in, and only the service key may call them. Only names starting github_app_ are allowed,
-- so they cannot be used to read other Vault secrets (such as github_actions_token).
create or replace function public.lodestar_get_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
begin
  if p_name is null or p_name not like 'github\_app\_%' then
    raise exception 'That secret name is not allowed.';
  end if;
  return (select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1);
end;
$$;

create or replace function public.lodestar_put_secret(p_name text, p_value text)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  existing uuid;
begin
  if p_name is null or p_name not like 'github\_app\_%' then
    raise exception 'That secret name is not allowed.';
  end if;
  if p_value is null or btrim(p_value) = '' then
    raise exception 'A secret cannot be empty.';
  end if;
  select id into existing from vault.secrets where name = p_name limit 1;
  if existing is null then
    perform vault.create_secret(p_value, p_name, 'Lodestar GitHub App');
  else
    perform vault.update_secret(existing, p_value, p_name, 'Lodestar GitHub App');
  end if;
end;
$$;

revoke all on function public.lodestar_get_secret(text) from public, anon, authenticated;
revoke all on function public.lodestar_put_secret(text, text) from public, anon, authenticated;
grant execute on function public.lodestar_get_secret(text) to service_role;
grant execute on function public.lodestar_put_secret(text, text) to service_role;
