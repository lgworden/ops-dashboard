# Ops Work Plan Dashboard

A shared, editable ops dashboard. Anyone with the link can check off items, edit
text, add/remove items, and set due dates — changes save to a shared database
so the whole team sees the same board. Open tabs poll every 5 seconds and pick
up teammates' edits automatically (it pauses refreshing while you're actively
typing in a field, so it won't interrupt you).

Checking an item's checkbox marks it **completed**; the 🗄 icon (visible on
hover, next to the sub-item/delete icons) marks it **archived**. Either way,
the item disappears from its card and moves into one of the two expandable
"Completed Items" / "Archived Items" sections at the bottom of the board.
Each entry there has a **Reopen** button that puts it right back where it
came from.

## How it works

- `public/index.html` — the dashboard UI (unchanged look/behavior from the
  original file, except it now saves to `/api/dashboard` instead of the
  Claude-artifact-only `window.storage`).
- `server.js` — a small Express server that serves the page and exposes
  `GET /api/dashboard` / `PUT /api/dashboard`.
- Storage: if a `DATABASE_URL` environment variable is set, it stores the
  dashboard in a Postgres table (`dashboard_state`). If not, it falls back to
  a local `data.local.json` file — handy for testing on your own machine, but
  **not** shared between users, so don't rely on it in production.

## 1. Test locally (optional)

```bash
npm install
node server.js
```

Then open http://localhost:3000. This uses the local JSON file fallback, so
it's just for you — not shared with anyone else yet.

## 2. Push this to GitHub

You said GitHub isn't set up yet for this project, so here's the from-scratch path:

1. If you don't already have a GitHub account, create one at
   [github.com/join](https://github.com/join).
2. Create a new **empty** repository (no README/license) at
   [github.com/new](https://github.com/new) — e.g. name it `ops-dashboard`.
   You can make it private.
3. Back here, run (replace the URL with the one GitHub shows you after
   creating the repo):

   ```bash
   git init
   git add .
   git commit -m "Initial commit: shared ops dashboard"
   git branch -M main
   git remote add origin https://github.com/<your-username>/ops-dashboard.git
   git push -u origin main
   ```

   The first push will prompt you to sign in to GitHub in your browser.

## 3. Deploy to Railway

1. Create a Railway account at [railway.app](https://railway.app) (you can
   sign up with your GitHub account, which also makes step 2 easier).
2. In the Railway dashboard, click **New Project → Deploy from GitHub repo**,
   and pick the `ops-dashboard` repo you just pushed. Railway will detect
   the Node app automatically (via `package.json`) and start a deploy.
3. Add a database: in the same project, click **New → Database → Add
   PostgreSQL**. Railway provisions it and automatically makes a
   `DATABASE_URL` variable available.
4. Connect the database to the app: open your app service → **Variables**,
   and add a reference variable `DATABASE_URL` pointing at the Postgres
   service's `DATABASE_URL` (Railway's variable picker lists it for you —
   look for "Add Variable Reference"). Redeploy if it doesn't restart on its
   own.
5. Once deployed, open the app's public URL (Railway shows it under
   **Settings → Networking → Generate Domain** if one isn't assigned yet).
   Share that URL with your team — that's the collaborative dashboard.

After that, any future change you want to make: edit the code, commit, and
`git push` — Railway auto-redeploys on every push to `main`.

## Access

- Anyone opening the dashboard must enter a `@deloitte.com` email. It's
  remembered per browser (via `localStorage`), so it only asks once per
  device.
- Every unique email is recorded in `dashboard_users` (Postgres) or
  `users.local.json` (local dev), with first-seen/last-seen timestamps and a
  visit count.
- The **first time** a given email is used, it also has to enter a shared
  team password (this isn't per-person — it's one password everyone on the
  team knows, just to keep random people from typing in *any* `@deloitte.com`
  address). Default: `harbor-otter-velvet7`. To change it without touching
  code, set a `NEW_USER_PASSWORD` environment variable on the Railway
  service. Once an email has logged in successfully once, it never needs the
  password again on any device.

## Exporting action items

The "Export Action Items" button (footer bar) opens a modal that pulls every
open (not checked off) item from the whole board and groups it by owner or
by due date. From there you can:

- **Download as Word (.docx)** — generated server-side (`POST
  /api/export/docx`, using the `docx` npm package) and downloaded straight
  to your machine.
- **Open in Email** — builds a `mailto:` link with the grouped list in the
  body and hands it to your OS's default mail client as a draft; nothing is
  sent automatically. Very long lists can get truncated by some mail apps
  (Outlook included) since `mailto:` links have a length limit — the Word
  download always has the complete list regardless of size.

## Notes

- The "Reset to original" button in the footer resets the shared dashboard
  for **everyone**, not just you.
- Beyond the password on first login, there's no per-user auth — anyone who
  knows a valid email + the shared password can edit. That's intentional for
  a lightweight team tool; ask if you ever need stricter access control.
