# Command Center

Personal daily dashboard for Jarrod: today's meetings, tasks with Akiflow-style time blocking, project health, Jira tickets, and meeting recaps from Google Drive.

## How it's built

- `src/template.html` + `src/logic.js` - the UI, exported from Claude Design and running on its bundled runtime (`static/support.js`). `npm run build` assembles them into `dist/index.html`.
- `netlify/functions/` - the API. `login` / `logout` manage a signed session cookie; `state` reads and writes the whole dashboard document to Supabase.
- `lib/db.mjs` - translation between the UI's state shape and the Supabase tables.
- `dev/mock-server.mjs` - local smoke-test server with a fake `/api/state` (`node build.mjs && node dev/mock-server.mjs`, then open http://localhost:8787).

## Environment variables (Netlify)

| Name | What it is |
| --- | --- |
| `SUPABASE_URL` | Project URL from Supabase, Settings > API |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key from Supabase, Settings > API (never the anon key) |
| `APP_PASSWORD` | The password for the login page |
| `SESSION_SECRET` | Any long random string; signs the session cookie |
| `AUTH_DISABLED` | Set to `true` to turn the login off entirely (site becomes open to anyone with the URL) |

## Phases

1. Static shell on Supabase (this) - tasks, projects, meetings, settings, calendar blocks all persist.
2. Google - Calendar read for today's meetings, Drive read for recaps, Calendar write for time blocks.
3. Jira - assigned HQ tickets.
4. Granola automation writes recaps and tasks into the same tables.
