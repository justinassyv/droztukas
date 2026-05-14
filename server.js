const express = require("express");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const session = require("express-session");
const bcrypt = require("bcryptjs");

const db = require("./db");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "";

const SESSION_SECRET = process.env.SESSION_SECRET || "";
const COOKIE_SECURE = process.env.COOKIE_SECURE === "true";
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD_HASH = process.env.ADMIN_PASSWORD_HASH || "";
const ADMIN_CONFIGURED = !!(ADMIN_USER && ADMIN_PASSWORD_HASH);

if (!SESSION_SECRET) {
  console.error(
    "[fatal] SESSION_SECRET is not set. Generate one with `openssl rand -hex 32` and add it to .env.",
  );
  process.exit(1);
}
if (!ADMIN_CONFIGURED) {
  console.warn(
    "[admin] ADMIN_USER or ADMIN_PASSWORD_HASH not set -- /admin will show a 'not configured' notice. Generate hash with: node -e \"console.log(require('bcryptjs').hashSync(process.argv[1], 12))\" 'mypassword'",
  );
}

const UNIT_PRICE = 12.0;
const FREE_SHIPPING_THRESHOLD = 50;
const DELIVERY_OPTIONS = {
  "lp-paststomatas": { title: "LP Express paštomatas", price: 2.99 },
  kurjeris: { title: "Kurjeris į namus", price: 4.99 },
  atsiimti: { title: "Atsiėmimas Vilniuje", price: 0 },
};

let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  transporter.verify().then(
    () => console.log("[smtp] transporter ready"),
    (err) => console.warn("[smtp] verify failed:", err.message),
  );
} else {
  console.log("[smtp] not configured -- orders saved to orders.db only");
}

const app = express();
app.set("trust proxy", true);
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

app.use(
  session({
    name: "droztukas.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: COOKIE_SECURE,
      maxAge: 1000 * 60 * 60 * 8,
    },
  }),
);

app.get("/admin", (_req, res) => res.sendFile(path.join(ROOT, "admin.html")));

// --- analytics: track public page views ----------------------------------
// Runs before static; only counts GETs for HTML pages (/, *.html) and
// requests that don't look like asset/admin/api/bot traffic.
const VISITOR_COOKIE = "drz_vid";
const VISITOR_COOKIE_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 365; // 1 year
const BOT_UA_RE = /bot|crawler|spider|crawling|facebookexternalhit|preview|monitor|pingdom|uptimerobot|headlesschrome|lighthouse|axios\/|curl\/|wget\//i;

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function isTrackablePath(p) {
  if (!p || p === "/") return true;
  if (p.startsWith("/api/") || p.startsWith("/admin")) return false;
  if (p === "/healthz") return false;
  if (/\.(html?)$/i.test(p)) return true;
  return false;
}

app.use((req, res, next) => {
  if (req.method !== "GET") return next();
  if (!isTrackablePath(req.path)) return next();

  const ua = (req.headers["user-agent"] || "").toString();
  if (BOT_UA_RE.test(ua)) return next();

  const cookies = parseCookies(req.headers.cookie);
  let vid = cookies[VISITOR_COOKIE];
  if (!vid || !/^[a-f0-9]{32}$/.test(vid)) {
    vid = crypto.randomBytes(16).toString("hex");
    res.cookie(VISITOR_COOKIE, vid, {
      httpOnly: true,
      sameSite: "lax",
      secure: COOKIE_SECURE,
      maxAge: VISITOR_COOKIE_MAX_AGE_MS,
    });
  }

  const fwd = (req.headers["x-forwarded-for"] || "").toString();
  const ip = fwd.split(",")[0].trim() || req.ip || "";

  try {
    db.recordPageView({
      path: req.path,
      referrer: (req.headers.referer || req.headers.referrer || "").toString().slice(0, 500) || null,
      visitorId: vid,
      userAgent: ua.slice(0, 300) || null,
      ip,
    });
  } catch (err) {
    console.warn("[analytics] write failed:", err.message);
  }
  next();
});
// --- end analytics --------------------------------------------------------

app.use(
  express.static(ROOT, {
    index: "index.html",
    setHeaders: (res, filePath) => {
      if (/\.(webp|png|jpe?g|svg|ico|woff2?)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=2592000, immutable");
      } else if (/\.(html|jsx)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);

const sanitize = (s, max = 500) =>
  typeof s === "string" ? s.trim().slice(0, max) : "";

function validate(b) {
  const errors = {};
  const qty = Math.max(1, Math.min(99, parseInt(b.qty, 10) || 1));
  const delivery = DELIVERY_OPTIONS[b.delivery] ? b.delivery : "lp-paststomatas";
  const needInvoice = !!b.needInvoice;
  const agree = !!b.agree;

  const form = {
    name: sanitize(b.name, 120),
    email: sanitize(b.email, 200),
    phone: sanitize(b.phone, 40),
    address: sanitize(b.address, 200),
    city: sanitize(b.city, 80),
    postal: sanitize(b.postal, 20),
    company: sanitize(b.company, 200),
    vat: sanitize(b.vat, 40),
    notes: sanitize(b.notes, 1000),
  };

  if (form.name.length < 2) errors.name = "Įveskite vardą ir pavardę";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = "Neteisingas el. paštas";
  if (!/^\d{8,}$/.test(form.phone.replace(/\D/g, ""))) errors.phone = "Neteisingas telefono numeris";
  if (delivery !== "atsiimti") {
    if (!form.address) errors.address = "Nurodykite adresą";
    if (!form.city) errors.city = "Nurodykite miestą";
  }
  if (needInvoice) {
    if (!form.company) errors.company = "Įmonės pavadinimas privalomas";
    if (!form.vat) errors.vat = "Įmonės kodas privalomas";
  }
  if (!agree) errors.agree = "Sutikite su sąlygomis";

  return { errors, qty, delivery, needInvoice, form };
}

function orderEmailText(o) {
  const lines = [
    "Užsakymo Nr: " + o.num,
    "Data: " + o.createdAt,
    "",
    "Klientas: " + o.name,
    "El. paštas: " + o.email,
    "Telefonas: " + o.phone,
    "",
    "Kiekis: " + o.qty + " vnt. x " + o.unitPrice.toFixed(2) + " EUR",
    "Pristatymas: " + o.deliveryTitle + " (" + o.shipping.toFixed(2) + " EUR)",
  ];
  if (o.delivery !== "atsiimti") {
    lines.push("Adresas: " + o.address + ", " + o.city + " " + (o.postal || ""));
  }
  lines.push("", "Iš viso: " + o.total.toFixed(2) + " EUR", "");
  if (o.needInvoice) lines.push("Sąskaita: " + o.company + " (k. " + o.vat + ")");
  if (o.notes) lines.push("Komentaras: " + o.notes);
  return lines.join("\n");
}

const recentByIp = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  for (const [k, t] of recentByIp) if (now - t > 60_000) recentByIp.delete(k);
  const last = recentByIp.get(ip);
  return !!(last && now - last < 4_000);
}
function markRequest(ip) {
  recentByIp.set(ip, Date.now());
}

app.post("/api/order", async (req, res) => {
  const fwd = (req.headers["x-forwarded-for"] || "").toString();
  const ip = fwd.split(",")[0].trim() || req.ip || "";

  const { errors, qty, delivery, needInvoice, form } = validate(req.body || {});
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ ok: false, errors });
  }

  if (isRateLimited(ip)) {
    return res
      .status(429)
      .json({ ok: false, error: "Per dažnas siuntimas. Palaukite kelias sekundes." });
  }
  markRequest(ip);

  const subtotal = qty * UNIT_PRICE;
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : DELIVERY_OPTIONS[delivery].price;
  const total = Math.round((subtotal + shipping) * 100) / 100;

  const draft = {
    createdAt: new Date().toISOString(),
    ip,
    qty,
    unitPrice: UNIT_PRICE,
    delivery,
    deliveryTitle: DELIVERY_OPTIONS[delivery].title,
    shipping,
    subtotal: Math.round(subtotal * 100) / 100,
    total,
    needInvoice,
    ...form,
  };

  let order;
  try {
    order = db.insertOrder(draft);
  } catch (err) {
    console.error("[orders] write failed:", err);
    return res.status(500).json({ ok: false, error: "Nepavyko išsaugoti užsakymo." });
  }

  if (transporter && NOTIFY_EMAIL) {
    transporter
      .sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: NOTIFY_EMAIL,
        replyTo: order.email,
        subject: "Naujas užsakymas " + order.num + " - Drožtukas",
        text: orderEmailText(order),
      })
      .catch((err) => console.error("[smtp] send failed:", err.message));
  }

  return res.json({ ok: true, num: order.num, total: order.total });
});

// --- Admin ---------------------------------------------------------------

const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const loginFailsByIp = new Map();

function recordLoginFail(ip) {
  const now = Date.now();
  const list = (loginFailsByIp.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  list.push(now);
  loginFailsByIp.set(ip, list);
}
function isLoginBlocked(ip) {
  const now = Date.now();
  const list = (loginFailsByIp.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (list.length !== (loginFailsByIp.get(ip) || []).length) loginFailsByIp.set(ip, list);
  return list.length >= LOGIN_MAX_FAILS;
}
function clientIp(req) {
  const fwd = (req.headers["x-forwarded-for"] || "").toString();
  return fwd.split(",")[0].trim() || req.ip || "";
}

function constantTimeStringEq(a, b) {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

app.post("/api/admin/login", async (req, res) => {
  if (!ADMIN_CONFIGURED) {
    return res.status(503).json({ ok: false, error: "admin_not_configured" });
  }
  const ip = clientIp(req);
  if (isLoginBlocked(ip)) {
    return res.status(429).json({ ok: false, error: "too_many_attempts" });
  }
  const user = typeof req.body?.user === "string" ? req.body.user : "";
  const password = typeof req.body?.password === "string" ? req.body.password : "";

  const userOk = constantTimeStringEq(user, ADMIN_USER);
  let passOk = false;
  try {
    passOk = await bcrypt.compare(password, ADMIN_PASSWORD_HASH);
  } catch (_) {
    passOk = false;
  }

  if (userOk && passOk) {
    req.session.regenerate((err) => {
      if (err) {
        console.error("[admin] session regenerate failed:", err);
        return res.status(500).json({ ok: false, error: "session_error" });
      }
      req.session.admin = { user: ADMIN_USER, at: Date.now() };
      return res.json({ ok: true });
    });
    return;
  }
  recordLoginFail(ip);
  return res.status(401).json({ ok: false, error: "invalid_credentials" });
});

function requireAdmin(req, res, next) {
  if (req.session && req.session.admin) return next();
  return res.status(401).json({ ok: false, error: "unauthorized" });
}

app.post("/api/admin/logout", requireAdmin, (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("droztukas.sid");
    res.json({ ok: true });
  });
});

app.get("/api/admin/orders", requireAdmin, (req, res) => {
  const status = typeof req.query.status === "string" ? req.query.status : "";
  const filter = db.VALID_STATUSES.includes(status) ? { status } : {};
  res.json({ ok: true, orders: db.listOrders(filter) });
});

app.get("/api/admin/stats", requireAdmin, (_req, res) => {
  try {
    res.json({ ok: true, stats: db.getStats() });
  } catch (err) {
    console.error("[admin] stats failed:", err);
    res.status(500).json({ ok: false, error: "stats_failed" });
  }
});

app.patch("/api/admin/orders/:num/status", requireAdmin, (req, res) => {
  const num = req.params.num;
  const status = req.body?.status;
  if (!db.VALID_STATUSES.includes(status)) {
    return res.status(400).json({ ok: false, error: "invalid_status" });
  }
  const updated = db.setStatus(num, status);
  if (!updated) return res.status(404).json({ ok: false, error: "not_found" });
  res.json({ ok: true, order: updated });
});

// --- end admin -----------------------------------------------------------

app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

app.use((_req, res) => res.status(404).type("text/plain").send("Not found"));

app.listen(PORT, HOST, () => {
  console.log("Drožtukas server listening on http://" + HOST + ":" + PORT);
});
