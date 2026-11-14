-- Phase 3 (2026-11-14): Claude works tasks handed to it from a comment (@Claude) or from a meeting recap.
-- A Claude scheduled task on Jarrod's plan calls these through the Supabase connector. They are the only
-- things that worker touches: claim jobs (with everything it needs to know), then post one reply per job.

-- Everything Claude needs to know about one job, as JSON.
create or replace function public.claude_task_context(p_job uuid) returns jsonb language sql stable as $$
  select jsonb_build_object(
    'job_id', q.id,
    'request', q.payload->>'request',
    'started_by', coalesce(q.payload->>'started_by', 'comment'),
    'task', jsonb_build_object(
      'title', t.title, 'notes', t.notes, 'area', a.name,
      'project', (select p.name from public.task_projects tp join public.projects p on p.id = tp.project_id where tp.task_id = t.id limit 1),
      'due_date', t.due_date, 'assigned_to', t.assignee,
      'waiting_on', case when t.owner ~* '^(jarrod|jalea)' then null else t.owner end),
    'from_meeting', (
      select jsonb_build_object('title', m.title, 'recap_date', r.meeting_date, 'recap_summary', r.summary, 'recap_doc', r.drive_url)
      from public.task_meetings tm join public.meetings m on m.id = tm.meeting_id
      left join lateral (select * from public.recaps r where r.meeting_id = m.id order by (r.id::text = q.payload->>'recap_id') desc, r.meeting_date desc limit 1) r on true
      where tm.task_id = t.id limit 1),
    'thread', coalesce((select jsonb_agg(jsonb_build_object('author', c.author, 'at', c.created_at, 'text', c.body) order by c.created_at)
                        from public.task_comments c where c.task_id = t.id and c.author <> 'system'), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(f.file_name) from public.task_attachments f where f.task_id = t.id), '[]'::jsonb))
  from public.claude_queue q
  join public.tasks t on t.id = (q.payload->>'task_id')::uuid
  left join public.areas a on a.id = t.area_id
  where q.id = p_job;
$$;

-- Take up to p_limit waiting jobs, mark them as being worked, and return their context.
create or replace function public.claude_task_claim(p_limit int default 3) returns jsonb language plpgsql as $$
declare ids uuid[]; result jsonb;
begin
  -- A job stuck in 'working' for two hours goes back in line, up to three tries. After that Jarrod is told.
  with gave_up as (
    update public.claude_queue set status = 'error', error = 'gave up after 3 attempts'
    where kind = 'task' and status = 'working' and claimed_at < now() - interval '2 hours' and attempts >= 3
    returning (payload->>'task_id')::uuid as task_id
  ), told as (
    insert into public.task_comments (task_id, author, body)
    select g.task_id, 'claude', 'I could not finish this after three tries. Mention @Claude again to retry, or tell me what to change.'
    from gave_up g where exists (select 1 from public.tasks t where t.id = g.task_id and t.deleted_at is null)
    returning task_id
  )
  update public.tasks set claude_status = 'needs_review' where id in (select task_id from told);

  update public.claude_queue set status = 'pending'
  where kind = 'task' and status = 'working' and claimed_at < now() - interval '2 hours' and attempts < 3;

  -- Jobs whose task was finished or deleted before Claude got to it are closed quietly.
  update public.claude_queue q set status = 'done', completed_at = now(), error = 'task was finished or deleted first'
  where q.kind = 'task' and q.status = 'pending'
    and not exists (select 1 from public.tasks t where t.id = (q.payload->>'task_id')::uuid and t.deleted_at is null and not t.done);

  select array_agg(x.id) into ids from (
    select q.id from public.claude_queue q where q.kind = 'task' and q.status = 'pending'
    order by q.created_at limit greatest(1, least(coalesce(p_limit, 3), 5)) for update skip locked) x;
  if ids is null then return '[]'::jsonb; end if;

  update public.claude_queue set status = 'working', claimed_at = now(), attempts = attempts + 1 where id = any(ids);
  update public.tasks set claude_status = 'working' where id in (select (payload->>'task_id')::uuid from public.claude_queue where id = any(ids));
  select coalesce(jsonb_agg(public.claude_task_context(i)), '[]'::jsonb) into result from unnest(ids) i;
  return result;
end $$;

-- Post Claude's reply on the task and flag it for Jarrod's review.
create or replace function public.claude_task_finish(p_job uuid, p_reply text) returns text language plpgsql as $$
declare j public.claude_queue%rowtype; tid uuid; cid uuid; body text := btrim(coalesce(p_reply, ''));
begin
  select * into j from public.claude_queue where id = p_job and kind = 'task' for update;
  if not found then return 'no such job'; end if;
  if j.status not in ('working', 'pending') then return 'job is already ' || j.status; end if;
  if body = '' then return 'reply is empty'; end if;
  tid := (j.payload->>'task_id')::uuid;
  if not exists (select 1 from public.tasks where id = tid and deleted_at is null) then
    update public.claude_queue set status = 'done', completed_at = now(), error = 'task was deleted' where id = p_job;
    return 'task was deleted, nothing posted';
  end if;
  insert into public.task_comments (task_id, author, body) values (tid, 'claude', left(body, 20000)) returning id into cid;
  update public.tasks set claude_status = 'needs_review' where id = tid and not done;
  update public.claude_queue set status = 'done', completed_at = now(), ready_at = now(), error = null, result = jsonb_build_object('comment_id', cid) where id = p_job;
  return 'ok';
end $$;

-- Only the database owner (the Supabase connector) may call these; the public API roles may not.
revoke execute on function public.claude_task_context(uuid) from public, anon, authenticated;
revoke execute on function public.claude_task_claim(int) from public, anon, authenticated;
revoke execute on function public.claude_task_finish(uuid, text) from public, anon, authenticated;
