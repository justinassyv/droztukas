const { useState, useEffect, useMemo, useCallback } = React;

function formatEUR(n) {
  return new Intl.NumberFormat("lt-LT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(n) + " €";
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return new Intl.DateTimeFormat("lt-LT", {
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  }).format(d);
}

function App() {
  const [state, setState] = useState({ phase: "checking" });
  // phase: 'checking' | 'login' | 'authed' | 'not_configured'

  const checkAuth = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/orders");
      if (res.status === 401) {
        setState({ phase: "login" });
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setState({ phase: "login", error: "Nepavyko užkrauti duomenų." });
        return;
      }
      setState({ phase: "authed", orders: data.orders });
    } catch (_) {
      setState({ phase: "login", error: "Tinklo klaida." });
    }
  }, []);

  useEffect(() => { checkAuth(); }, [checkAuth]);

  if (state.phase === "checking") {
    return <div className="wrap"><div className="empty">Kraunama…</div></div>;
  }
  if (state.phase === "not_configured") {
    return (
      <div className="wrap">
        <div className="notice notice-warn">
          <h3>Administravimas nesukonfigūruotas</h3>
          <p style={{ marginTop: 8, fontSize: 14 }}>
            Serveryje nenustatyti <code>ADMIN_USER</code> ir <code>ADMIN_PASSWORD_HASH</code>.
            Žr. <code>.env.example</code>.
          </p>
        </div>
      </div>
    );
  }
  if (state.phase === "login") {
    return <Login onAuthed={checkAuth} initialError={state.error} />;
  }
  return <Dashboard initial={state.orders} onLoggedOut={() => setState({ phase: "login" })} />;
}

function Login({ onAuthed, initialError }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [error, setError] = useState(initialError || "");
  const [busy, setBusy] = useState(false);

  const submit = async (ev) => {
    ev.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, password: pass }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        await onAuthed();
        return;
      }
      if (res.status === 503) {
        setError("Administravimas nesukonfigūruotas serveryje.");
      } else if (res.status === 429) {
        setError("Per daug nesėkmingų bandymų. Pamėginkite vėliau.");
      } else {
        setError("Neteisingas vartotojas arba slaptažodis.");
      }
    } catch (_) {
      setError("Tinklo klaida. Bandykite dar kartą.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrap">
      <form className="login-card" onSubmit={submit} noValidate>
        <span className="eyebrow">Administravimas</span>
        <h2 style={{ marginTop: 6, marginBottom: 18 }}>Prisijungimas</h2>

        <div className="field">
          <label>Vartotojas</label>
          <input type="text" autoComplete="username" value={user}
            onChange={(e) => setUser(e.target.value)} autoFocus />
        </div>
        <div className="field">
          <label>Slaptažodis</label>
          <input type="password" autoComplete="current-password" value={pass}
            onChange={(e) => setPass(e.target.value)} />
        </div>

        {error && <div className="err" style={{ marginBottom: 12 }}>{error}</div>}

        <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: "100%" }}>
          {busy ? "Tikrinama…" : "Prisijungti"}
        </button>
      </form>
    </div>
  );
}

function Dashboard({ initial, onLoggedOut }) {
  const [tab, setTab] = useState("orders");

  const logout = async () => {
    try { await fetch("/api/admin/logout", { method: "POST" }); } catch (_) {}
    onLoggedOut();
  };

  return (
    <div className="wrap">
      <div className="topbar">
        <div className="title">
          <div className="filters" role="tablist">
            <button className={"chip" + (tab === "orders" ? " active" : "")} onClick={() => setTab("orders")}>
              Užsakymai
            </button>
            <button className={"chip" + (tab === "stats" ? " active" : "")} onClick={() => setTab("stats")}>
              Statistika
            </button>
          </div>
        </div>
        <button className="btn btn-ghost" onClick={logout}>Atsijungti</button>
      </div>

      {tab === "orders"
        ? <OrdersView initial={initial} />
        : <StatsView />}
    </div>
  );
}

function OrdersView({ initial }) {
  const [orders, setOrders] = useState(initial);
  const [filter, setFilter] = useState("pending");
  const [busyNum, setBusyNum] = useState(null);
  const [error, setError] = useState("");

  const counts = useMemo(() => ({
    all: orders.length,
    pending: orders.filter((o) => o.status === "pending").length,
    done: orders.filter((o) => o.status === "done").length,
  }), [orders]);

  const visible = useMemo(() => {
    if (filter === "all") return orders;
    return orders.filter((o) => o.status === filter);
  }, [orders, filter]);

  const toggleStatus = async (order) => {
    const next = order.status === "pending" ? "done" : "pending";
    setBusyNum(order.num);
    setError("");
    const prev = orders;
    // optimistic
    setOrders((list) => list.map((o) => (o.num === order.num ? { ...o, status: next } : o)));
    try {
      const res = await fetch("/api/admin/orders/" + encodeURIComponent(order.num) + "/status", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || "update_failed");
      setOrders((list) => list.map((o) => (o.num === order.num ? data.order : o)));
    } catch (_) {
      setOrders(prev);
      setError("Nepavyko atnaujinti būsenos. Bandykite dar kartą.");
    } finally {
      setBusyNum(null);
    }
  };

  return (
    <div>
      <div className="section-head">
        <div className="title">
          <h2>Užsakymai</h2>
          <span className="count">{counts.pending} laukia · {counts.done} įvykdyti</span>
        </div>
        <div className="filters" role="tablist">
          <button className={"chip" + (filter === "pending" ? " active" : "")} onClick={() => setFilter("pending")}>
            Laukiantys ({counts.pending})
          </button>
          <button className={"chip" + (filter === "done" ? " active" : "")} onClick={() => setFilter("done")}>
            Įvykdyti ({counts.done})
          </button>
          <button className={"chip" + (filter === "all" ? " active" : "")} onClick={() => setFilter("all")}>
            Visi ({counts.all})
          </button>
        </div>
      </div>

      {error && <div className="notice notice-warn" style={{ marginBottom: 14 }}>{error}</div>}

      {visible.length === 0 ? (
        <div className="empty">
          {filter === "pending" ? "Laukiančių užsakymų nėra." : filter === "done" ? "Įvykdytų užsakymų nėra." : "Užsakymų nėra."}
        </div>
      ) : (
        <div className="ord-list">
          {visible.map((o) => (
            <OrderCard key={o.num} order={o} busy={busyNum === o.num} onToggle={() => toggleStatus(o)} />
          ))}
        </div>
      )}
    </div>
  );
}

function StatsView() {
  const [state, setState] = useState({ phase: "loading" });

  const load = useCallback(async () => {
    setState({ phase: "loading" });
    try {
      const res = await fetch("/api/admin/stats");
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        setState({ phase: "error", error: "Nepavyko užkrauti statistikos." });
        return;
      }
      setState({ phase: "ready", stats: data.stats });
    } catch (_) {
      setState({ phase: "error", error: "Tinklo klaida." });
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  if (state.phase === "loading") return <div className="empty">Kraunama…</div>;
  if (state.phase === "error") {
    return (
      <div>
        <div className="notice notice-warn">{state.error}</div>
        <button className="btn btn-ghost" onClick={load}>Bandyti dar kartą</button>
      </div>
    );
  }

  const s = state.stats;
  return (
    <div>
      <div className="section-head">
        <h2>Statistika</h2>
        <button className="btn btn-ghost" onClick={load}>Atnaujinti</button>
      </div>

      <div className="kpi-grid">
        <Kpi label="Šiandien" views={s.today.views} visitors={s.today.visitors} />
        <Kpi label="Pastarosios 7 d." views={s.last7.views} visitors={s.last7.visitors} />
        <Kpi label="Pastarosios 30 d." views={s.last30.views} visitors={s.last30.visitors} />
        <Kpi label="Iš viso" views={s.total.views} visitors={s.total.visitors} />
      </div>

      <DailyChart series={s.daily} />

      <div className="stat-cols">
        <StatList title="Populiariausi puslapiai (30 d.)"
          rows={s.topPaths}
          renderKey={(r) => r.path || "/"}
          renderValue={(r) => `${r.views} (${r.visitors} unik.)`}
          emptyText="Nėra duomenų" />
        <StatList title="Šaltiniai (referrers, 30 d.)"
          rows={s.topReferrers}
          renderKey={(r) => shortenReferrer(r.referrer)}
          renderValue={(r) => `${r.views}`}
          emptyText="Tiesioginiai apsilankymai" />
      </div>
    </div>
  );
}

function Kpi({ label, views, visitors }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-val">{views.toLocaleString("lt-LT")}</div>
      <div className="kpi-sub">{visitors.toLocaleString("lt-LT")} unik. lankytojų</div>
    </div>
  );
}

function StatList({ title, rows, renderKey, renderValue, emptyText }) {
  return (
    <div className="stat-card">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <div className="empty" style={{ padding: "24px 8px" }}>{emptyText}</div>
      ) : (
        <ul className="stat-list">
          {rows.map((r, i) => (
            <li key={i}>
              <span className="stat-key" title={renderKey(r)}>{renderKey(r)}</span>
              <span className="stat-val mono">{renderValue(r)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DailyChart({ series }) {
  const max = Math.max(1, ...series.map((d) => d.views));
  // pad to 30 days so the chart always renders the full window
  const byDay = new Map(series.map((d) => [d.day, d]));
  const days = [];
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  for (let i = 29; i >= 0; i--) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() - i);
    const key = d.toISOString().slice(0, 10);
    days.push(byDay.get(key) || { day: key, views: 0, visitors: 0 });
  }
  return (
    <div className="stat-card" style={{ marginBottom: 18 }}>
      <h3>Apsilankymai per parą (30 d.)</h3>
      <div className="chart">
        {days.map((d) => {
          const h = Math.round((d.views / max) * 100);
          return (
            <div key={d.day} className="chart-col" title={`${d.day}: ${d.views} peržiūros, ${d.visitors} unik.`}>
              <div className="chart-bar" style={{ height: h + "%" }} />
            </div>
          );
        })}
      </div>
      <div className="chart-axis mono">
        <span>{days[0].day.slice(5)}</span>
        <span>{days[days.length - 1].day.slice(5)}</span>
      </div>
    </div>
  );
}

function shortenReferrer(ref) {
  if (!ref) return "—";
  try {
    const u = new URL(ref);
    return u.host + (u.pathname && u.pathname !== "/" ? u.pathname : "");
  } catch (_) {
    return ref;
  }
}

function OrderCard({ order, busy, onToggle }) {
  const isPending = order.status === "pending";
  return (
    <div className="ord-card">
      <div className="ord-head">
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <span className="ord-num">{order.num}</span>
          <span className={"pill " + (isPending ? "pill-pending" : "pill-done")}>
            {isPending ? "Laukia" : "Įvykdyta"}
          </span>
          <span className="ord-time">{formatDateTime(order.createdAt)}</span>
        </div>
        <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 14, fontWeight: 600 }}>
          {formatEUR(order.total)}
        </div>
      </div>

      <div className="ord-grid">
        <div>
          <div className="lbl">Klientas</div>
          <div>{order.name || "—"}</div>
          {order.email && <div><a href={"mailto:" + order.email}>{order.email}</a></div>}
          {order.phone && <div><a href={"tel:" + order.phone.replace(/\s/g, "")}>{order.phone}</a></div>}
        </div>
        <div>
          <div className="lbl">Užsakymas</div>
          <div>{order.qty} vnt. × {formatEUR(order.unitPrice)}</div>
          <div>{order.deliveryTitle} · {order.shipping === 0 ? "nemokamai" : formatEUR(order.shipping)}</div>
        </div>

        {order.delivery !== "atsiimti" && (order.address || order.city) && (
          <div>
            <div className="lbl">Adresas</div>
            <div>{order.address}</div>
            <div>{[order.postal, order.city].filter(Boolean).join(" ")}</div>
          </div>
        )}

        {order.needInvoice && (
          <div>
            <div className="lbl">Sąskaita faktūra</div>
            <div>{order.company}</div>
            <div className="mono" style={{ fontSize: 13 }}>k. {order.vat}</div>
          </div>
        )}
      </div>

      {order.notes && (
        <div className="ord-notes">{order.notes}</div>
      )}

      <div className="ord-foot">
        <button className={isPending ? "btn btn-primary" : "btn btn-ghost"} onClick={onToggle} disabled={busy}>
          {busy ? "Atnaujinama…" : isPending ? "Pažymėti įvykdytą" : "Grąžinti į laukiančius"}
        </button>
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("admin-root"));
root.render(<App />);
