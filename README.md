# Drožtukas — landing page + order form

Static landing page (`index.html`) with a React order form (`order-form.jsx`) and a small Node/Express server (`server.js`) that accepts orders, persists them to a SQLite database (`orders.db`), and optionally emails a notification via SMTP. An admin dashboard at `/admin` lets the operator view orders and mark them done.

## Local run

```bash
npm install
cp .env.example .env
# generate a session secret and admin password hash:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # → SESSION_SECRET
node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'mypassword'  # → ADMIN_PASSWORD_HASH
# edit .env, set COOKIE_SECURE=false for plain http
npm start
# open http://localhost:3000  (form)
# open http://localhost:3000/admin  (dashboard)
```

Orders land in `orders.db` (SQLite). Inspect with `sqlite3 orders.db "SELECT num, status, name, total FROM orders ORDER BY createdAt DESC LIMIT 10;"`.

`npm start` uses Node's `--env-file-if-exists` flag (Node ≥ 20.12) so a local `.env` is loaded automatically; in production systemd handles env via `EnvironmentFile=`.

## Deploy on a VPS (Ubuntu / Debian)

The flow below assumes a fresh server reachable as `root@your.server` with a domain pointed at it. Adjust paths and the systemd `User=` if you want.

### 1. Install Node.js 20 and build tools

`better-sqlite3` is a native module — `npm install` may need a C++ toolchain on first install if no prebuilt binary matches your Node version.

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs nginx build-essential python3
```

### 2. Copy the project to the server

From your laptop:

```bash
rsync -av --exclude node_modules --exclude 'orders.db*' --exclude orders.json --exclude .env \
    ./ root@your.server:/var/www/droztukas/
```

### 3. Create the runtime user and install deps

```bash
sudo useradd --system --home /var/www/droztukas --shell /usr/sbin/nologin droztukas
sudo chown -R droztukas:droztukas /var/www/droztukas
cd /var/www/droztukas
sudo -u droztukas npm install --omit=dev
```

### 4. Configure environment

```bash
sudo -u droztukas cp .env.example .env
# generate session secret and admin password hash:
openssl rand -hex 32
sudo -u droztukas node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'pickAStrongPassword'
sudo -u droztukas nano .env   # paste SESSION_SECRET, ADMIN_PASSWORD_HASH; set NOTIFY_EMAIL/SMTP_* if you want emails; keep COOKIE_SECURE=true behind HTTPS
sudo chmod 600 .env
```

The server refuses to start if `SESSION_SECRET` is missing. If `ADMIN_USER`/`ADMIN_PASSWORD_HASH` are missing, the public form still works but `/admin` shows a "not configured" notice.

If you skip SMTP, orders are still saved to `orders.db` — read with `sudo -u droztukas sqlite3 /var/www/droztukas/orders.db "SELECT num, status, name, total FROM orders ORDER BY createdAt DESC LIMIT 10;"` or check the dashboard at `/admin`.

### 5. Install the systemd service

```bash
sudo cp deploy/droztukas.service /etc/systemd/system/droztukas.service
sudo systemctl daemon-reload
sudo systemctl enable --now droztukas
sudo systemctl status droztukas
```

Logs: `sudo journalctl -u droztukas -f`

### 6. Nginx + HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/droztukas
# edit server_name to your domain
sudo nano /etc/nginx/sites-available/droztukas
sudo ln -s /etc/nginx/sites-available/droztukas /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

sudo apt-get install -y certbot python3-certbot-nginx
sudo certbot --nginx -d droztukas.lt -d www.droztukas.lt
```

Certbot will rewrite the nginx config to redirect HTTP → HTTPS automatically.

### 7. Updates

After editing files locally:

```bash
rsync -av --exclude node_modules --exclude 'orders.db*' --exclude orders.json --exclude .env \
    ./ root@your.server:/var/www/droztukas/
ssh root@your.server "cd /var/www/droztukas && sudo -u droztukas npm install --omit=dev && systemctl restart droztukas"
```

Restarting the server invalidates the in-memory admin session — you'll need to log in again.

## Configuration reference

See `.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Bind address |
| `NOTIFY_EMAIL` | *(unset)* | Where to email new orders |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | *(unset)* | SMTP credentials. If `SMTP_HOST`/`USER`/`PASS` are set, email notifications are enabled. |
| `SESSION_SECRET` | **required** | Cookie signing secret. Generate with `openssl rand -hex 32`. Server refuses to start without it. |
| `ADMIN_USER` | *(unset)* | Admin username for `/admin`. |
| `ADMIN_PASSWORD_HASH` | *(unset)* | bcryptjs hash of the admin password. Generate with `node -e "console.log(require('bcryptjs').hashSync(process.argv[1], 12))" 'mypassword'`. |
| `COOKIE_SECURE` | `false` | Set to `true` behind HTTPS so the session cookie is `Secure`. Set `false` for plain `http://localhost`. |

## Where orders go

Orders are stored in `orders.db` (SQLite, single file) in the project directory. The server validates input, applies a 4-second per-IP rate limit on `/api/order`, and assigns an order number `DRZ-XXXXXX`. New orders default to `status='pending'`; mark them `done` from the admin dashboard. If SMTP is configured, a plain-text notification email is sent in parallel — failures are logged but do not block the order from being saved.

### Admin dashboard

`/admin` shows incoming orders with filter chips (Laukiantys / Įvykdyti / Visi), each with full customer details and a single button to flip pending↔done. Sessions live in memory — restarting the server logs the admin out. Five wrong logins from one IP within 10 minutes triggers a 10-minute throttle.

## Backups

`orders.db` and `.env` are gitignored. Back up `orders.db` out-of-band. Because SQLite uses WAL mode, a flat `cp orders.db` while the server is running can miss recent writes — use `sqlite3` to take a consistent copy:

```bash
sqlite3 orders.db ".backup '/path/to/backup.db'"
```

## Notes

* The React form and admin UI are compiled in the browser via Babel standalone (loaded from unpkg). This is acceptable for a small landing page; if you ever need faster first paint, pre-compile `order-form.jsx` and `admin.jsx` with a bundler.
* `orders.db`, `orders.json`, and `.env` are intentionally gitignored.
