-- 2026-11-14: a recap job is claimed ('filing') before its Doc and tasks are created, so overlapping
-- runs can't file the same recap twice.
alter table public.claude_queue drop constraint if exists claude_queue_status_check;
alter table public.claude_queue add constraint claude_queue_status_check check (status in ('pending', 'working', 'ready', 'filing', 'done', 'error'));
