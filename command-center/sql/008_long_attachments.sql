-- Long attachments and repeated uploads.
-- 1. The same file attached more than once (same name and size) is passed to Claude once, newest copy.
--    Before this, each copy travelled with the task and doubled the hand-off.
-- 2. No schema change is needed for long files: an attachment can now carry both `text` (the start of the file)
--    and `drive_file_id` (the whole file, lent through Drive). See lendLongText in lib/thread.mjs.
create or replace function public.claude_task_context(p_job uuid)
 returns jsonb
 language sql
 stable
as $function$
  select jsonb_build_object(
    'job_id', q.id,
    'request', q.payload->>'request',
    'started_by', coalesce(q.payload->>'started_by', 'comment'),
    'task', jsonb_build_object(
      'title', t.title, 'notes', t.notes, 'area', a.name,
      'project', (select p.name from public.task_projects tp join public.projects p on p.id = tp.project_id where tp.task_id = t.id limit 1),
      'due_date', t.due_date, 'assigned_to', t.assignee,
      'waiting_on', case when t.owner ~* '^(jarrod|jalea)' then null else t.owner end,
      'sub_tasks', coalesce((select jsonb_agg(jsonb_build_object('title', st.title, 'done', st.done) order by st.created_at)
                             from public.tasks st where st.parent_id = t.id and st.deleted_at is null), '[]'::jsonb)),
    'from_meeting', (
      select jsonb_build_object('title', m.title, 'recap_date', r.meeting_date, 'recap_summary', r.summary, 'recap_doc', r.drive_url)
      from public.task_meetings tm join public.meetings m on m.id = tm.meeting_id
      left join lateral (select * from public.recaps r where r.meeting_id = m.id order by (r.id::text = q.payload->>'recap_id') desc, r.meeting_date desc limit 1) r on true
      where tm.task_id = t.id limit 1),
    'thread', coalesce((select jsonb_agg(jsonb_build_object('author', c.author, 'at', c.created_at, 'text', c.body) order by c.created_at)
                        from public.task_comments c where c.task_id = t.id and c.author <> 'system'), '[]'::jsonb),
    'attachments', coalesce((select jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
                               'name', f.file_name, 'attached_at', f.created_at, 'text', f.text_content, 'drive_file_id', f.drive_file_id,
                               'note', coalesce(f.text_note, case when f.text_content is null and f.drive_file_id is null then 'This file is not ready for you yet.' end))) order by f.created_at)
                             from (select distinct on (lower(a2.file_name), a2.size_bytes) a2.*
                                   from public.task_attachments a2 where a2.task_id = t.id
                                   order by lower(a2.file_name), a2.size_bytes, a2.created_at desc) f), '[]'::jsonb))
  from public.claude_queue q
  join public.tasks t on t.id = (q.payload->>'task_id')::uuid
  left join public.areas a on a.id = t.area_id
  where q.id = p_job;
$function$;
