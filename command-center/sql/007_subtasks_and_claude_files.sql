-- Sub-tasks (one level) and room for attachments to carry text Claude can read.
alter table public.tasks add column if not exists parent_id uuid references public.tasks(id) on delete cascade;
create index if not exists tasks_parent_idx on public.tasks(parent_id) where parent_id is not null;
alter table public.task_attachments add column if not exists drive_file_id text, add column if not exists drive_url text;
