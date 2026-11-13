-- Work queue that Claude picks up on Jarrod's plan (via a scheduled task and the Supabase connector),
-- so the Command Center never needs an Anthropic API key.
-- kind:   'recap' today; 'task' later for tasks flagged "for Claude".
-- status: pending -> working -> ready (Claude wrote result) -> done (Netlify finished it) | error
create table if not exists public.claude_queue (
  id           uuid primary key default gen_random_uuid(),
  kind         text not null check (kind in ('recap', 'task')),
  status       text not null default 'pending' check (status in ('pending', 'working', 'ready', 'done', 'error')),
  source_ref   text unique,
  title        text,
  payload      jsonb not null default '{}'::jsonb,
  result       jsonb,
  error        text,
  attempts     int not null default 0,
  created_at   timestamptz not null default now(),
  claimed_at   timestamptz,
  ready_at     timestamptz,
  completed_at timestamptz
);

create index if not exists claude_queue_kind_status_idx on public.claude_queue (kind, status, created_at);

-- Only the service role (Netlify functions) and the Supabase connector touch this table.
alter table public.claude_queue enable row level security;

-- granola_notes ledger: notes handed to Claude are recorded as 'queued' until their recap is filed.
alter type public.granola_status add value if not exists 'queued';
