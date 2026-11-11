-- Publish-on-approve: the moment a person approves an article, ask GitHub to run the "Publish approved"
-- workflow, so the article goes live within a minute or two instead of waiting for the next scheduled run.
-- Run AFTER schema.sql. Needs the repo workflow file in workflow-drafts/publish-approved.yml to be in place.
--
-- One-time setup (in this order):
--   1. Supabase dashboard > Integrations > Vault: add a secret named  github_actions_token  whose value is a
--      GitHub fine-grained token for ONLY the seo-engine repository with the single permission
--      "Actions: Read and write". That token can start workflows and nothing else (it cannot read or change code).
--      Add it in the Vault screen, not with SQL, so it never sits in the SQL editor's saved history.
--   2. Run this whole file in the SQL editor.
--
-- If GitHub is unreachable or the secret is missing, approving still works: the article stays "approved" and the
-- scheduled daily run publishes it. Nothing here can block or undo an approval.

create extension if not exists pg_net;

create or replace function public.notify_article_approved()
returns trigger
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  token text;
begin
  select decrypted_secret into token from vault.decrypted_secrets where name = 'github_actions_token' limit 1;
  if token is null or token = '' then
    raise warning 'Lodestar: no github_actions_token secret, so publishing was not started. The daily run will publish it.';
    return new;
  end if;

  begin
    perform net.http_post(
      url     := 'https://api.github.com/repos/mannywest/seo-engine/actions/workflows/publish-approved.yml/dispatches',
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || token,
        'Accept', 'application/vnd.github+json',
        'X-GitHub-Api-Version', '2022-11-28',
        'Content-Type', 'application/json',
        'User-Agent', 'lodestar-inbox'
      ),
      body    := jsonb_build_object('ref', 'main', 'inputs', jsonb_build_object('client', new.client_id))
    );
  exception when others then
    raise warning 'Lodestar: could not start publishing (%). The daily run will publish it.', sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.notify_article_approved() from public, anon, authenticated;

drop trigger if exists inbox_items_notify on public.inbox_items;
create trigger inbox_items_notify
  after update of status on public.inbox_items
  for each row
  when (old.status is distinct from new.status and new.status = 'approved')
  execute function public.notify_article_approved();
