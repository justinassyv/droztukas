"use strict";

const path = require("path");
const Database = require("better-sqlite3");

const DB_FILE = path.join(__dirname, "orders.db");
const VALID_STATUSES = ["pending", "done"];

const db = new Database(DB_FILE);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS page_views (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    createdAt  TEXT NOT NULL,
    path       TEXT NOT NULL,
    referrer   TEXT,
    visitorId  TEXT,
    userAgent  TEXT,
    ip         TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_pv_created ON page_views(createdAt DESC);
  CREATE INDEX IF NOT EXISTS idx_pv_visitor ON page_views(visitorId, createdAt);

  CREATE TABLE IF NOT EXISTS orders (
    num            TEXT PRIMARY KEY,
    createdAt      TEXT NOT NULL,
    updatedAt      TEXT NOT NULL,
    status         TEXT NOT NULL DEFAULT 'pending'
                     CHECK(status IN ('pending','done')),
    ip             TEXT,
    qty            INTEGER NOT NULL,
    unitPrice      REAL NOT NULL,
    delivery       TEXT NOT NULL,
    deliveryTitle  TEXT NOT NULL,
    shipping       REAL NOT NULL,
    subtotal       REAL NOT NULL,
    total          REAL NOT NULL,
    needInvoice    INTEGER NOT NULL,
    name           TEXT,
    email          TEXT,
    phone          TEXT,
    address        TEXT,
    city           TEXT,
    postal         TEXT,
    company        TEXT,
    vat            TEXT,
    notes          TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_orders_status_created
    ON orders(status, createdAt DESC);
`);

const insertStmt = db.prepare(`
  INSERT INTO orders (
    num, createdAt, updatedAt, status, ip, qty, unitPrice,
    delivery, deliveryTitle, shipping, subtotal, total, needInvoice,
    name, email, phone, address, city, postal, company, vat, notes
  ) VALUES (
    @num, @createdAt, @updatedAt, @status, @ip, @qty, @unitPrice,
    @delivery, @deliveryTitle, @shipping, @subtotal, @total, @needInvoice,
    @name, @email, @phone, @address, @city, @postal, @company, @vat, @notes
  )
`);

const listAllStmt = db.prepare(
  "SELECT * FROM orders ORDER BY createdAt DESC"
);
const listByStatusStmt = db.prepare(
  "SELECT * FROM orders WHERE status = ? ORDER BY createdAt DESC"
);
const getStmt = db.prepare("SELECT * FROM orders WHERE num = ?");
const updateStatusStmt = db.prepare(
  "UPDATE orders SET status = ?, updatedAt = ? WHERE num = ?"
);

function rowToOrder(row) {
  if (!row) return undefined;
  return { ...row, needInvoice: !!row.needInvoice };
}

function genOrderNum() {
  return "DRZ-" + Math.floor(100000 + Math.random() * 900000);
}

function insertOrder(order) {
  const row = {
    num: order.num || genOrderNum(),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt || order.createdAt,
    status: order.status || "pending",
    ip: order.ip || null,
    qty: order.qty,
    unitPrice: order.unitPrice,
    delivery: order.delivery,
    deliveryTitle: order.deliveryTitle,
    shipping: order.shipping,
    subtotal: order.subtotal,
    total: order.total,
    needInvoice: order.needInvoice ? 1 : 0,
    name: order.name || null,
    email: order.email || null,
    phone: order.phone || null,
    address: order.address || null,
    city: order.city || null,
    postal: order.postal || null,
    company: order.company || null,
    vat: order.vat || null,
    notes: order.notes || null,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      insertStmt.run(row);
      return rowToOrder(row);
    } catch (err) {
      if (
        err && err.code === "SQLITE_CONSTRAINT_PRIMARYKEY" &&
        !order.num && attempt < 2
      ) {
        row.num = genOrderNum();
        continue;
      }
      throw err;
    }
  }
  throw new Error("Could not allocate a unique order number");
}

function listOrders({ status } = {}) {
  const rows = status && VALID_STATUSES.includes(status)
    ? listByStatusStmt.all(status)
    : listAllStmt.all();
  return rows.map(rowToOrder);
}

function getOrder(num) {
  return rowToOrder(getStmt.get(num));
}

function setStatus(num, status) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error("Invalid status: " + status);
  }
  const result = updateStatusStmt.run(status, new Date().toISOString(), num);
  if (result.changes === 0) return undefined;
  return getOrder(num);
}

// --- page views -----------------------------------------------------------

const insertPageViewStmt = db.prepare(`
  INSERT INTO page_views (createdAt, path, referrer, visitorId, userAgent, ip)
  VALUES (@createdAt, @path, @referrer, @visitorId, @userAgent, @ip)
`);

function recordPageView(view) {
  insertPageViewStmt.run({
    createdAt: view.createdAt || new Date().toISOString(),
    path: view.path,
    referrer: view.referrer || null,
    visitorId: view.visitorId || null,
    userAgent: view.userAgent || null,
    ip: view.ip || null,
  });
}

const countViewsSinceStmt = db.prepare(
  "SELECT COUNT(*) AS n FROM page_views WHERE createdAt >= ?"
);
const countUniquesSinceStmt = db.prepare(
  "SELECT COUNT(DISTINCT visitorId) AS n FROM page_views WHERE createdAt >= ? AND visitorId IS NOT NULL"
);
const countTotalStmt = db.prepare("SELECT COUNT(*) AS n FROM page_views");
const countTotalUniquesStmt = db.prepare(
  "SELECT COUNT(DISTINCT visitorId) AS n FROM page_views WHERE visitorId IS NOT NULL"
);

const topPathsStmt = db.prepare(`
  SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitorId) AS visitors
  FROM page_views
  WHERE createdAt >= ?
  GROUP BY path
  ORDER BY views DESC
  LIMIT ?
`);

const topReferrersStmt = db.prepare(`
  SELECT referrer, COUNT(*) AS views
  FROM page_views
  WHERE createdAt >= ? AND referrer IS NOT NULL AND referrer != ''
  GROUP BY referrer
  ORDER BY views DESC
  LIMIT ?
`);

const dailySeriesStmt = db.prepare(`
  SELECT substr(createdAt, 1, 10) AS day,
         COUNT(*) AS views,
         COUNT(DISTINCT visitorId) AS visitors
  FROM page_views
  WHERE createdAt >= ?
  GROUP BY day
  ORDER BY day ASC
`);

function isoSinceDays(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

function getStats({ topLimit = 10 } = {}) {
  const now = new Date();
  const startOfTodayUTC = new Date(now);
  startOfTodayUTC.setUTCHours(0, 0, 0, 0);
  const today = startOfTodayUTC.toISOString();
  const d7 = isoSinceDays(6);   // today + last 6 = 7-day window
  const d30 = isoSinceDays(29); // 30-day window

  const total = countTotalStmt.get().n;
  const totalUniques = countTotalUniquesStmt.get().n;

  return {
    generatedAt: now.toISOString(),
    today: {
      views: countViewsSinceStmt.get(today).n,
      visitors: countUniquesSinceStmt.get(today).n,
    },
    last7: {
      views: countViewsSinceStmt.get(d7).n,
      visitors: countUniquesSinceStmt.get(d7).n,
    },
    last30: {
      views: countViewsSinceStmt.get(d30).n,
      visitors: countUniquesSinceStmt.get(d30).n,
    },
    total: { views: total, visitors: totalUniques },
    topPaths: topPathsStmt.all(d30, topLimit),
    topReferrers: topReferrersStmt.all(d30, topLimit),
    daily: dailySeriesStmt.all(d30),
  };
}

module.exports = {
  insertOrder,
  listOrders,
  getOrder,
  setStatus,
  VALID_STATUSES,
  recordPageView,
  getStats,
};
