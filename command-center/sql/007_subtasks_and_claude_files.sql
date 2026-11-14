-- Sub-tasks (one level) and room for attachments to carry text Claude can read.
alter table public.tasks add column if not exists parent_id uuid references public.tasks(id) on delete cascade;
create index if not exists tasks_parent_idx on public.tasks(parent_id) where parent_id is not null;
alter table public.task_attachments add column if not exists drive_file_id text, add column if not exists drive_url text;

-- Text read out of an attachment for Claude's task worker (lib/extract.mjs), or a note saying why it couldn't be read.
alter table public.task_attachments add column if not exists text_content text, add column if not exists text_note text;
-- claude_task_context now returns sub_tasks on the task and attachments as { name, attached_at, text, note }.
-- See the live function definition (applied as migration claude_reads_attachments).
-- PDFs and pictures are lent to Claude through Drive (drive_file_id on the attachment, shared with the account in
-- settings.claude_drive_email, which is set in the database and not kept in this repo). claude_task_context returns
-- drive_file_id for those. Copies and stored text are removed by cleanupClaudeFiles() once no job is open.
