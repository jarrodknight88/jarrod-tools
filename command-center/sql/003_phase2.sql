-- Phase 2 (2026-11-14): fields the redesigned dashboard needs.
alter table public.tasks add column if not exists repeat text check (repeat in ('daily','weekly','monthly'));
alter table public.tasks add column if not exists deleted_at timestamptz;           -- soft delete, so Undo works
alter table public.tasks add column if not exists block_on_calendar boolean not null default true; -- mirror the time block to Google Calendar
create index if not exists tasks_live_idx on public.tasks (deleted_at) where deleted_at is null;
