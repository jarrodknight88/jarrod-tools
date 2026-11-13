-- Phase 1 foundation (2026-11-13): areas, people, Today board, comments and attachments.
-- Backups of the pre-migration rows live in the backup schema (*_20261113).

-- Areas: the four workspaces everything belongs to.
create table if not exists public.areas (
  id         text primary key,
  name       text not null,
  color      text not null,
  sort_order int  not null default 0
);
insert into public.areas (id, name, color, sort_order) values
  ('cardshq', 'CardsHQ', '#2F5BEA', 1),
  ('teranga', 'Teranga', '#D9961A', 2),
  ('wugi',    'Wugi',    '#7A4FD6', 3),
  ('home',    'Home',    '#3E8C68', 4)
on conflict (id) do nothing;
alter table public.areas enable row level security;

-- Projects and tasks belong to an area. Everything that existed before this was CardsHQ.
alter table public.projects add column if not exists area_id text not null default 'cardshq' references public.areas(id);
alter table public.tasks    add column if not exists area_id text not null default 'cardshq' references public.areas(id);

-- Whose task it is in the household (separate from tasks.owner, which is who committed to it in a meeting).
alter table public.tasks add column if not exists assignee text not null default 'jarrod' check (assignee in ('jarrod', 'jalea'));

-- Today board: which column a task sits in, and for which day.
alter table public.tasks add column if not exists board text not null default 'none' check (board in ('none', 'todo', 'doing', 'done'));
alter table public.tasks add column if not exists board_date date;

-- Claude hand-off state shown on cards ("Claude is on it", "Needs your review").
alter table public.tasks add column if not exists claude_status text check (claude_status in ('queued', 'working', 'needs_review'));

create index if not exists tasks_area_idx  on public.tasks (area_id);
create index if not exists tasks_board_idx on public.tasks (board_date, board);

-- Comments: a thread per task. Mentioning @Claude queues the task for Claude.
create table if not exists public.task_comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks(id) on delete cascade,
  author     text not null check (author in ('jarrod', 'jalea', 'claude', 'system')),
  body       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists task_comments_task_idx on public.task_comments (task_id, created_at);
alter table public.task_comments enable row level security;

-- Attachments: on the task itself, or on a single comment. Files live in the private task-attachments bucket.
create table if not exists public.task_attachments (
  id           uuid primary key default gen_random_uuid(),
  task_id      uuid not null references public.tasks(id) on delete cascade,
  comment_id   uuid references public.task_comments(id) on delete cascade,
  file_name    text not null,
  mime_type    text,
  size_bytes   bigint,
  storage_path text not null unique,
  uploaded_by  text not null default 'jarrod' check (uploaded_by in ('jarrod', 'jalea', 'claude')),
  created_at   timestamptz not null default now()
);
create index if not exists task_attachments_task_idx on public.task_attachments (task_id);
alter table public.task_attachments enable row level security;

insert into storage.buckets (id, name, public, file_size_limit)
values ('task-attachments', 'task-attachments', false, 26214400)
on conflict (id) do nothing;

-- Meetings carry an area too, so tasks from a meeting's recap land in the right place.
alter table public.meetings add column if not exists area_id text not null default 'cardshq' references public.areas(id);
update public.meetings set area_id = 'teranga' where title ilike '%teranga%' or title ilike '%afro district%' or title ilike '%bartender%';
