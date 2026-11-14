-- 2026-11-14: projects can be opened and managed: due date, notes, attachments, finished / reopened.
alter table public.projects add column if not exists due_date date;
alter table public.projects add column if not exists notes text;
alter table public.projects add column if not exists done boolean not null default false;
alter table public.projects add column if not exists done_at timestamptz;
create table if not exists public.project_attachments (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects(id) on delete cascade,
  file_name    text not null,
  mime_type    text,
  size_bytes   bigint,
  storage_path text not null unique,
  uploaded_by  text not null default 'jarrod',
  created_at   timestamptz not null default now()
);
create index if not exists project_attachments_project_idx on public.project_attachments (project_id);
alter table public.project_attachments enable row level security;
