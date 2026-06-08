const express = require("express");
const path = require("path");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const session = require("express-session");
const bcrypt = require("bcryptjs");
// Paysera WebToPay protocol — implemented with built-in crypto (no extra dep)
const PAYSERA_GATEWAY = "https://www.paysera.com/pay/";
function _p64enc(s) { return Buffer.from(s).toString("base64").replace(/\+/g, "-").replace(/\//g, "_"); }
function _p64dec(s) { return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); }
function _pSign(data, pwd) { return crypto.createHash("md5").update(data + pwd).digest("hex"); }
function payseraBuildUrl(params) {
  const qs = new URLSearchParams(params).toString();
  const data = _p64enc(qs);
  const sign = _pSign(data, PAYSERA_SIGN_PASSWORD);
  return PAYSERA_GATEWAY + "?" + new URLSearchParams({ data, sign }).toString();
}
function payseraValidate(query) {
  const { data, ss1 } = query;
  if (!data || !ss1) throw new Error("Missing data or ss1");
  if (_pSign(data, PAYSERA_SIGN_PASSWORD) !== ss1) throw new Error("Signature mismatch");
  const params = Object.fromEntries(new URLSearchParams(_p64dec(data)));
  if (String(params.projectid) !== String(PAYSERA_PROJECT_ID)) throw new Error("Project ID mismatch");
  return params;
}

const db = require("./db");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const NOTIFY_EMAIL = process.env.NOTIFY_EMAIL || "";
const SITE_URL = (process.env.SITE_URL || "https://drozk.lt").replace(/\/$/, "");

const PAYSERA_PROJECT_ID = process.env.PAYSERA_PROJECT_ID || "";
const PAYSERA_SIGN_PASSWORD = process.env.PAYSERA_SIGN_PASSWORD || "";
const PAYSERA_TEST = process.env.PAYSERA_TEST === "1" ? 1 : 0;
const PAYSERA_ENABLED = !!(PAYSERA_PROJECT_ID && PAYSERA_SIGN_PASSWORD);

if (!PAYSERA_ENABLED) {
  console.warn("[paysera] not configured — set PAYSERA_PROJECT_ID and PAYSERA_SIGN_PASSWORD in .env");
}

// --- LP Express terminal list ---------------------------------------------
const LPEXPRESS_USERNAME = process.env.LPEXPRESS_USERNAME || "";
const LPEXPRESS_PASSWORD = process.env.LPEXPRESS_PASSWORD || "";
const LPEXPRESS_ENABLED = !!(LPEXPRESS_USERNAME && LPEXPRESS_PASSWORD);
const LPEXPRESS_API = process.env.LPEXPRESS_TEST === "1"
  ? "https://api-manosiuntostst.post.lt"
  : "https://api-manosiuntos.post.lt";

if (!LPEXPRESS_ENABLED) {
  console.warn("[lpexpress] not configured — set LPEXPRESS_USERNAME and LPEXPRESS_PASSWORD in .env");
}

let lpTokenCache = { token: "", expiresAt: 0 };
let lpTerminalsCache = { data: [], fetchedAt: 0 };
const LP_TERMINALS_TTL = 6 * 60 * 60 * 1000; // 6h — terminal list barely changes

async function lpGetToken() {
  const now = Date.now();
  if (lpTokenCache.token && now < lpTokenCache.expiresAt) return lpTokenCache.token;

  // OAuth2 password grant — per official Postman collection, "noauth" (no Basic Auth header),
  // but requires clientSystem=PUBLIC alongside the usual grant params.
  const params = new URLSearchParams({
    grant_type: "password",
    clientSystem: "PUBLIC",
    username: LPEXPRESS_USERNAME,
    password: LPEXPRESS_PASSWORD,
    scope: "read write API_CLIENT",
  });
  const res = await fetch(LPEXPRESS_API + "/oauth/token?" + params.toString(), {
    method: "POST",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("LP Express auth failed: " + res.status + " " + body.slice(0, 500));
  }
  const data = await res.json();
  if (!data.access_token) throw new Error("LP Express auth response missing access_token");

  lpTokenCache = {
    token: data.access_token,
    // refresh ~10min before the token's actual expiry
    expiresAt: now + Math.max(60, (data.expires_in || 3600) - 600) * 1000,
  };
  return lpTokenCache.token;
}

async function lpFetchTerminals() {
  const now = Date.now();
  if (lpTerminalsCache.data.length && now - lpTerminalsCache.fetchedAt < LP_TERMINALS_TTL) {
    return lpTerminalsCache.data;
  }

  const token = await lpGetToken();
  const params = new URLSearchParams({ receiverCountryCode: "LT", size: "2000" });
  const res = await fetch(LPEXPRESS_API + "/api/v2/terminal?" + params.toString(), {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("LP Express terminals fetch failed: " + res.status + " " + body.slice(0, 300));
  }
  const json = await res.json();
  const list = Array.isArray(json) ? json : json.data || json.terminals || json.content || [];

  const terminals = list
    .filter((t) => t.countryCode === "LT")
    .map((t) => ({
      id: String(t.id || ""),
      name: t.name || "",
      address: t.address || "",
      city: t.city || "",
    }))
    .filter((t) => t.id && t.name);

  lpTerminalsCache = { data: terminals, fetchedAt: now };
  return terminals;
}

const lpPriceCache = new Map(); // weight (g) -> { price, fetchedAt }
const LP_PRICE_TTL = 6 * 60 * 60 * 1000; // 6h

// Asks LP Express for the cheapest valid terminal-to-terminal box size & price
// for the given total parcel weight (grams), without forcing a specific size —
// letting their pricing engine pick what's actually available/cheapest.
async function lpEstimateTerminalPrice(weightGrams) {
  const now = Date.now();
  const cached = lpPriceCache.get(weightGrams);
  if (cached && now - cached.fetchedAt < LP_PRICE_TTL) return cached.price;

  const token = await lpGetToken();
  const params = new URLSearchParams({
    receiverCountryCode: "LT",
    senderCountryCode: "LT",
    parcelTypes: "T2T",
    planCodes: "TERMINAL",
    weight: String(weightGrams),
  });
  const res = await fetch(LPEXPRESS_API + "/api/v2/shipping/estimate/plan?" + params.toString(), {
    headers: { Authorization: "Bearer " + token },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("LP Express price estimate failed: " + res.status + " " + body.slice(0, 300));
  }
  const json = await res.json();
  console.log("[lpexpress] price estimate raw response (weight=" + weightGrams + "g):", JSON.stringify(json).slice(0, 800));

  const list = Array.isArray(json) ? json : json.data || json.plans || json.items || [];
  const prices = list
    .map((p) => Number(p.price ?? p.amount ?? p.value ?? (p.price && p.price.amount)))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!prices.length) throw new Error("LP Express price estimate: no usable price in response");

  const price = Math.min(...prices);
  lpPriceCache.set(weightGrams, { price, fetchedAt: now });
  return price;
}
// --- end LP Express --------------------------------------------------------

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
    terminalId: sanitize(b.terminalId, 40),
    terminalName: sanitize(b.terminalName, 200),
  };

  if (form.name.length < 2) errors.name = "Įveskite vardą ir pavardę";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) errors.email = "Neteisingas el. paštas";
  if (!/^\d{8,}$/.test(form.phone.replace(/\D/g, ""))) errors.phone = "Neteisingas telefono numeris";
  if (delivery === "kurjeris") {
    if (!form.address) errors.address = "Nurodykite adresą";
    if (!form.city) errors.city = "Nurodykite miestą";
  }
  if (delivery === "lp-paststomatas") {
    if (!form.terminalId || !form.terminalName) errors.terminalId = "Pasirinkite paštomatą";
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
  if (o.delivery === "lp-paststomatas" && o.terminalName) {
    lines.push("Paštomatas: " + o.terminalName);
  } else if (o.delivery !== "atsiimti") {
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

app.get("/api/terminals", async (_req, res) => {
  if (!LPEXPRESS_ENABLED) {
    return res.status(503).json({ ok: false, error: "not_configured", terminals: [] });
  }
  try {
    const terminals = await lpFetchTerminals();
    res.json({ ok: true, terminals });
  } catch (err) {
    console.error("[lpexpress] terminals failed:", err.message);
    res.status(502).json({ ok: false, error: "fetch_failed", terminals: [] });
  }
});

const PRODUCT_UNIT_WEIGHT_G = 100; // ~100g per Drožtukas unit incl. packaging

app.get("/api/shipping-price", async (req, res) => {
  if (!LPEXPRESS_ENABLED) {
    return res.status(503).json({ ok: false, error: "not_configured" });
  }
  const qty = Math.max(1, Math.min(99, parseInt(req.query.qty, 10) || 1));
  try {
    const price = await lpEstimateTerminalPrice(qty * PRODUCT_UNIT_WEIGHT_G);
    res.json({ ok: true, price });
  } catch (err) {
    console.error("[lpexpress] price estimate failed:", err.message);
    res.status(502).json({ ok: false, error: "estimate_failed" });
  }
});

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

  // If Paysera is configured, redirect customer to payment; otherwise fall back to inquiry mode
  if (PAYSERA_ENABLED) {
    const nameParts = order.name.trim().split(/\s+/);
    const firstName = nameParts[0] || order.name;
    const lastName = nameParts.slice(1).join(" ") || "";

    let paymentUrl;
    try {
      paymentUrl = payseraBuildUrl({
        projectid: PAYSERA_PROJECT_ID,
        orderid: order.num,
        amount: Math.round(order.total * 100),
        currency: "EUR",
        country: "LT",
        lang: "LIT",
        accepturl: SITE_URL + "/payment/success",
        cancelurl: SITE_URL + "/payment/cancel",
        callbackurl: SITE_URL + "/payment/callback",
        test: PAYSERA_TEST,
        p_firstname: firstName,
        p_lastname: lastName,
        p_email: order.email,
        p_phone: order.phone,
        p_street: order.address || "",
        p_city: order.city || "",
        p_zip: order.postal || "",
        p_countrycode: "LT",
      });
    } catch (err) {
      console.error("[paysera] buildUrl failed:", err.message);
      return res.status(500).json({ ok: false, error: "Mokėjimo sistema laikinai nepasiekiama. Bandykite dar kartą." });
    }

    return res.json({ ok: true, paymentUrl });
  }

  // Inquiry mode (no Paysera): notify admin immediately
  if (transporter && NOTIFY_EMAIL) {
    transporter
      .sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: NOTIFY_EMAIL,
        replyTo: order.email,
        subject: "Naujas užsakymas " + order.num + " — Drožtukas",
        text: orderEmailText(order),
      })
      .catch((err) => console.error("[smtp] send failed:", err.message));
  }

  return res.json({ ok: true, num: order.num, total: order.total });
});

// --- Paysera payment callbacks -------------------------------------------

app.get("/payment/success", (_req, res) =>
  res.sendFile(path.join(ROOT, "payment-success.html"))
);

app.get("/payment/cancel", (_req, res) =>
  res.sendFile(path.join(ROOT, "payment-cancel.html"))
);

app.get("/payment/callback", (req, res) => {
  if (!PAYSERA_ENABLED) return res.status(503).send("NOT_CONFIGURED");

  let data;
  try {
    data = payseraValidate(req.query);
  } catch (err) {
    console.error("[paysera] callback validation failed:", err.message);
    return res.status(400).send("FAIL");
  }

  // status 1 = payment confirmed
  if (data.status === "1") {
    const orderNum = data.orderid;
    const order = db.markOrderPaid(orderNum, data.requestid || null);

    if (order && transporter && NOTIFY_EMAIL) {
      transporter
        .sendMail({
          from: process.env.SMTP_FROM || process.env.SMTP_USER,
          to: NOTIFY_EMAIL,
          replyTo: order.email,
          subject: "Apmokėtas užsakymas " + order.num + " — Drožtukas",
          text: "APMOKĖTA\n\n" + orderEmailText(order),
        })
        .catch((err) => console.error("[smtp] send failed:", err.message));
    }

    console.log("[paysera] order paid:", orderNum);
  }

  // Paysera requires exactly "OK" response
  res.send("OK");
});

// --- end Paysera ---------------------------------------------------------

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

// Purge completed orders older than 10 days — runs once at startup then every 24h
db.purgeOldCompletedOrders();
setInterval(db.purgeOldCompletedOrders, 24 * 60 * 60 * 1000);
