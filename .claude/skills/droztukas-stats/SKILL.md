---
name: droztukas-stats
description: Query the Drožtukas website analytics SQLite database (orders.db) and produce a Markdown stats report. Use when the user asks about traffic, page views, visitors, top pages, referrers, or "how is the site doing". Pass an optional argument to control window: `7d`, `30d` (default), `today`, or `all`.
---

# droztukas-stats

Reports page-view analytics from `orders.db` (table `page_views`) in the Drožtukas project.

## When to use
- "show site stats", "kiek lankytojų", "how is traffic", "top pages", "referrers"
- After deploying or running a campaign, to check impact
- Standalone — no server restart needed; this reads the DB directly

## Inputs
- Optional window argument: `today`, `7d`, `30d` (default), `all`
- The DB lives at the repo root: `orders.db`

## How to run

Always run from the project root (`/Users/saulius/repos/droztukas`). Use the project's own `db.js` so the queries match the admin panel exactly. Run this Node one-liner via the Bash tool — do not hand-write SQL unless the user asks for a custom slice.

```bash
node -e '
  const db = require("./db");
  const s = db.getStats({ topLimit: 10 });
  console.log(JSON.stringify(s, null, 2));
'
```

Then format the JSON into the report below. Pick the window the user asked for; if unspecified, lead with 30 d.

## Report format

Render as Markdown. Keep it tight — the user already knows the project.

```
## Drožtukas stats — <window>

- **Šiandien:** <today.views> peržiūros · <today.visitors> unik.
- **7 d.:** <last7.views> · <last7.visitors> unik.
- **30 d.:** <last30.views> · <last30.visitors> unik.
- **Iš viso:** <total.views> · <total.visitors> unik.

### Top puslapiai (30 d.)
1. `<path>` — <views> peržiūros (<visitors> unik.)
…

### Šaltiniai (30 d.)
1. `<host/path>` — <views>
…
```

If `topReferrers` is empty, say "Daugiausia tiesioginių apsilankymų — referrer'ių nėra."

If `total.views` is 0, say the tracking table is empty and suggest checking that the server has been restarted after the analytics middleware was added.

## Custom slices

If the user asks for something specific (e.g. "views from yesterday only", "top paths just for this week", "how many visits to /index.html"), drop into raw SQL. The schema:

```
page_views(id, createdAt TEXT ISO, path, referrer, visitorId, userAgent, ip)
```

Example — yesterday only:

```bash
sqlite3 orders.db "
  SELECT COUNT(*) AS views, COUNT(DISTINCT visitorId) AS visitors
  FROM page_views
  WHERE createdAt >= date('now','-1 day','start of day')
    AND createdAt <  date('now','start of day');
"
```

## Don't
- Don't mutate `page_views` (no DELETE/UPDATE) without explicit user request.
- Don't read the DB while the server is doing a bulk import — `better-sqlite3` is WAL-mode so reads are safe, but coordinate if the user is running a migration.
- Don't surface raw IP addresses or user-agents in reports unless the user asks for them. Treat them as PII.
