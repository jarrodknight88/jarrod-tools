# Command Center

Personal daily dashboard for Jarrod: today's meetings, tasks with Akiflow-style time blocking, project health, Jira tickets, and meeting recaps from Google Drive.

## How it's built

- `src/template.html` + `src/logic.js` - the UI, exported from Claude Design and running on its bundled runtime (`static/support.js`). `npm run build` assembles them into `dist/index.html`.
- `netlify/functions/` - the API. `login` / `logout` manage a signed session cookie; `state` reads and writes the whole dashboard document to Supabase.
- `lib/db.mjs` - translation between the UI's state shape and the Supabase tables.
- `lib/thread.mjs` + `netlify/functions/task-thread.mjs` - task comments and attachments (`/api/tasks/:id/thread`, `/comments`, `/attachments`). Files go to the private `task-attachments` bucket through signed upload URLs. A comment mentioning @Claude queues the task in `claude_queue`.
- `sql/` - schema changes, applied in order.
- `dev/mock-server.mjs` - local smoke-test server with a fake `/api/state` (`node build.mjs && node dev/mock-server.mjs`, then open http://localhost:8787).

## Environment variables (Netlify)

| Name | What it is |
| --- | --- |
| `SUPABASE_URL` | Project URL from Supabase, Settings > API |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key from Supabase, Settings > API (never the anon key) |
| `APP_PASSWORD` | The password for the login page |
| `SESSION_SECRET` | Any long random string; signs the session cookie |
| `GOOGLE_CLIENT_ID` | OAuth client ID from Google Cloud (Web application type) |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret |
| `GRANOLA_API_KEY` | Personal API key from Granola (Settings > API) |
| `AUTH_DISABLED` | Set to `true` to turn the login off entirely (site becomes open to anyone with the URL) |

## Data model (phase 1, Nov 2026)

Everything belongs to one of four areas (`areas`: CardsHQ, Teranga, Wugi, Home) through `area_id` on projects and tasks. Tasks also carry `assignee` (jarrod or jalea), `board` + `board_date` for the Today board, and `claude_status` for Claude hand-offs. Comments and files live in `task_comments` and `task_attachments`. Pre-migration copies of the data are in the `backup` schema.

## The dashboard (phase 2, Nov 2026)

- `src/app.html`, `src/app.css`, `src/app.js` - the dashboard: plain HTML, CSS and JavaScript, inlined into `dist/index.html` by `build.mjs`. No framework.
- `lib/app.mjs` + `netlify/functions/app.mjs` - its API under `/api/app/*`: one state read, then small targeted writes (create or patch a task, add a project, change a meeting, save a setting). Comments and files use `/api/tasks/:id/*`.
- `dist/classic.html` - the previous dashboard (`src/template.html` + `src/logic.js` on the dc-runtime), kept as a fallback. It still uses `/api/state`.
- `npm run dev` - builds, then serves the page on http://localhost:8787 running the real function code against an in-memory stand-in for Supabase (`dev/server.mjs`). No live data or Google calls.
- Claude on tasks (phase 3): a comment mentioning @Claude, or a recap action item marked as something Claude can prepare, puts a `kind='task'` job in `claude_queue`. The "Command Center task worker" Claude scheduled task (Jarrod's plan, no API key) calls `claude_task_claim()`, does the work with read-only use of connected tools, and posts one reply with `claude_task_finish()` (see `sql/004_claude_tasks.sql`). The task then shows "Needs your review" with Approve and Send back. `settings.claude_autostart` turns the recap auto-start off.
- Not built yet: AI-written briefing, phone alerts and quiet hours, Jira, scheduled-run results, separate logins, the family calendar.

## Phases

1. Static shell on Supabase (this) - tasks, projects, meetings, settings, calendar blocks all persist.
2. Google (built) - visit `/api/google/connect` once to authorize. Today's meetings come from the primary calendar and match tracked meetings by title pattern; unmatched events show read-only. Recaps merge the `recaps` table with Docs in each meeting's mapped Drive folder. Time blocks become tagged Calendar events. Redirect URI: `https://<site>/api/google/callback`.
3. Jira - assigned HQ tickets.
4. Granola automation (built) - `granola-scheduled` runs every 30 minutes. It lists new Granola notes, skips excluded meetings, auto-tracks unknown ones, and queues each note as a `pending` recap job in `claude_queue` (with the full prompt). A Claude scheduled task on Jarrod's plan (no API key) writes the recap JSON into the job and marks it `ready`; the next run turns ready jobs into a Google Doc in the mapped Drive folder plus tasks linked to the meeting. Ledger in `granola_notes`. Manual run: settings > "Sync Granola now" or `POST /api/granola/sync`.
