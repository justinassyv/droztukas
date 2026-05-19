const { useState, useMemo } = React;

const UNIT_PRICE = 12.00;
const DELIVERY_OPTIONS = [
  { id: "lp-paststomatas", title: "LP Express paštomatas", sub: "1–2 d. d. · visa Lietuva", price: 2.99 },
  { id: "kurjeris", title: "Kurjeris į namus", sub: "1–2 d. d. · adresu", price: 4.99 },
  { id: "atsiimti", title: "Atsiėmimas Vilniuje", sub: "Po 1 d. d. · Savanorių pr.", price: 0 },
];

function formatEUR(n) {
  return new Intl.NumberFormat("lt-LT", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n) + " €";
}

function OrderForm() {
  const [qty, setQty] = useState(1);
  const [delivery, setDelivery] = useState(DELIVERY_OPTIONS[0].id);
  const [needInvoice, setNeedInvoice] = useState(false);
  const [agree, setAgree] = useState(false);
  const [form, setForm] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
    city: "",
    postal: "",
    company: "",
    vat: "",
    notes: "",
  });
  const [errors, setErrors] = useState({});
  const [submitted, setSubmitted] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [globalError, setGlobalError] = useState("");

  const deliveryOpt = DELIVERY_OPTIONS.find((d) => d.id === delivery);
  const subtotal = qty * UNIT_PRICE;
  const shipping = subtotal >= 50 ? 0 : deliveryOpt.price;
  const total = subtotal + shipping;

  const setField = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const validate = () => {
    const e = {};
    if (!form.name.trim() || form.name.trim().length < 2) e.name = "Įveskite vardą ir pavardę";
    if (!form.email.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) e.email = "Neteisingas el. pašto adresas";
    if (!form.phone.replace(/\D/g, "").match(/^\d{8,}$/)) e.phone = "Įveskite telefono numerį";
    if (delivery !== "atsiimti") {
      if (!form.address.trim()) e.address = "Nurodykite adresą";
      if (!form.city.trim()) e.city = "Nurodykite miestą";
    }
    if (needInvoice) {
      if (!form.company.trim()) e.company = "Įmonės pavadinimas privalomas";
      if (!form.vat.trim()) e.vat = "Įmonės kodas privalomas";
    }
    if (!agree) e.agree = "Sutikite su sąlygomis";
    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const submit = async (ev) => {
    ev.preventDefault();
    setGlobalError("");
    if (!validate()) {
      setTimeout(() => {
        const firstInvalid = document.querySelector(".invalid");
        if (firstInvalid) firstInvalid.focus({ preventScroll: false });
      }, 30);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/order", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ qty, delivery, needInvoice, agree, ...form }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (data && data.errors) {
          setErrors(data.errors);
          setTimeout(() => {
            const firstInvalid = document.querySelector(".invalid");
            if (firstInvalid) firstInvalid.focus({ preventScroll: false });
          }, 30);
        } else {
          setGlobalError((data && data.error) || "Įvyko klaida. Bandykite dar kartą.");
        }
        return;
      }
      setSubmitted({ num: data.num, total: data.total, qty });
    } catch (err) {
      setGlobalError("Nepavyko susisiekti su serveriu. Bandykite dar kartą.");
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="order-wrap">
        <div className="success" style={{ gridColumn: "1 / -1" }}>
          <div className="check">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
              <path d="M5 12l5 5 9-10" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
          <h3>Ačiū! Jūsų užklausa gauta.</h3>
          <p>Susisieksime su Jumis per <b>1 darbo dieną</b> dėl užsakymo patvirtinimo ir apmokėjimo. Patvirtinimą taip pat išsiuntėme nurodytu el. pašto adresu.</p>
          <div className="order-num">Užklausos Nr. {submitted.num}</div>
          <div style={{ marginTop: 24, fontSize: 13, color: "var(--muted)" }}>
            {submitted.qty} vnt. · iš viso {formatEUR(submitted.total)}
          </div>
          <div style={{ marginTop: 28 }}>
            <button className="btn btn-ghost" onClick={() => { setSubmitted(null); }}>Pateikti dar vieną užklausą</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="order-wrap">
      {/* LEFT — summary */}
      <aside className="order-side">
        <span className="eyebrow">Užsakymas</span>
        <h3 style={{ fontSize: 24, fontFamily: "Space Grotesk", fontWeight: 600 }}>Drožtukas · 68mm</h3>

        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <div style={{
            width: 86, height: 86, borderRadius: 10, overflow: "hidden",
            border: "1px solid var(--line)", flexShrink: 0, background: "#fff"
          }}>
            <img src="assets/droztukas-carbon.webp" alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.5 }}>
            Profesionalus drožtukas Ø 68 mm elektros dėžutėms. Su pirma keičiama geležte ir varžtais.
          </div>
        </div>

        <div className="price">
          <span className="amt">{formatEUR(UNIT_PRICE).replace(" €", "")}</span>
          <span className="cur">EUR / vnt.</span>
          <span className="old">22,90 €</span>
        </div>

        <div className="badge-row">
          <span className="badge">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M3 8l4 4 6-8" stroke="var(--ok)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
            Yra sandėlyje
          </span>
          <span className="badge">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="var(--ink)" strokeWidth="1.4"/><path d="M8 5v3l2 2" stroke="var(--ink)" strokeWidth="1.4" strokeLinecap="round"/></svg>
            1–2 d. d.
          </span>
          <span className="badge">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2l5 3v4c0 3-2 5-5 6-3-1-5-3-5-6V5l5-3z" stroke="var(--ink)" strokeWidth="1.4" strokeLinejoin="round"/></svg>
            12 mėn. garantija
          </span>
        </div>

        <div style={{ borderTop: "1px solid var(--line)", paddingTop: 18, marginTop: 4 }}>
          <div className="eyebrow" style={{ marginBottom: 10 }}>Į komplektą įeina</div>
          <ul>
            <li>
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ marginTop: 3, flexShrink: 0 }}><path d="M3 8l4 4 6-8" stroke="var(--ok)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg>
              Drožtuko korpusas (Ø 68 mm)
            </li>
          </ul>
        </div>
      </aside>

      {/* RIGHT — form */}
      <form className="order-form" onSubmit={submit} noValidate>
        <h3>Užsakymo užklausa</h3>
        <p className="form-sub">Užpildykite formą — su Jumis susisieks vadybininkas dėl patvirtinimo ir apmokėjimo.</p>

        {/* Quantity */}
        <div className="field">
          <label>Kiekis</label>
          <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
            <div className="qty">
              <button type="button" onClick={() => setQty(Math.max(1, qty - 1))} aria-label="Mažiau">−</button>
              <input type="number" min="1" max="99" value={qty} onChange={(e) => setQty(Math.max(1, Math.min(99, parseInt(e.target.value) || 1)))} />
              <button type="button" onClick={() => setQty(Math.min(99, qty + 1))} aria-label="Daugiau">+</button>
            </div>
            <div style={{ fontSize: 13, color: "var(--muted)" }}>
              {qty >= 10 ? <span style={{ color: "var(--ok)", fontWeight: 600 }}>Didmeninė kaina taikoma</span> : `Užsisakę 10+ vnt. gausite didmeninę kainą`}
            </div>
          </div>
        </div>

        {/* Contact */}
        <div className="row2">
          <div className="field">
            <label>Vardas, Pavardė<span className="req">*</span></label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => setField("name", e.target.value)}
              placeholder="Jonas Jonaitis"
              className={errors.name ? "invalid" : ""}
            />
            {errors.name && <div className="err">{errors.name}</div>}
          </div>
          <div className="field">
            <label>Telefonas<span className="req">*</span></label>
            <input
              type="tel"
              value={form.phone}
              onChange={(e) => setField("phone", e.target.value)}
              placeholder="+370 600 00 000"
              className={errors.phone ? "invalid" : ""}
            />
            {errors.phone && <div className="err">{errors.phone}</div>}
          </div>
        </div>

        <div className="field">
          <label>El. paštas<span className="req">*</span></label>
          <input
            type="email"
            value={form.email}
            onChange={(e) => setField("email", e.target.value)}
            placeholder="vardas@pastas.lt"
            className={errors.email ? "invalid" : ""}
          />
          {errors.email && <div className="err">{errors.email}</div>}
        </div>

        {delivery !== "atsiimti" && (
          <>
            <div className="field">
              <label>Adresas (gatvė, namo nr.){delivery === "kurjeris" && <span className="req">*</span>}</label>
              <input
                type="text"
                value={form.address}
                onChange={(e) => setField("address", e.target.value)}
                placeholder="Pvz., Vilniaus g. 25-3"
                className={errors.address ? "invalid" : ""}
              />
              {errors.address && <div className="err">{errors.address}</div>}
            </div>
            <div className="row2">
              <div className="field">
                <label>Miestas<span className="req">*</span></label>
                <input
                  type="text"
                  value={form.city}
                  onChange={(e) => setField("city", e.target.value)}
                  placeholder="Vilnius"
                  className={errors.city ? "invalid" : ""}
                />
                {errors.city && <div className="err">{errors.city}</div>}
              </div>
              <div className="field">
                <label>Pašto kodas</label>
                <input
                  type="text"
                  value={form.postal}
                  onChange={(e) => setField("postal", e.target.value)}
                  placeholder="LT-01108"
                />
              </div>
            </div>
          </>
        )}

        {/* Invoice */}
        <label className="checkbox">
          <input type="checkbox" checked={needInvoice} onChange={(e) => setNeedInvoice(e.target.checked)} />
          <span>Reikalinga PVM sąskaita faktūra įmonei</span>
        </label>

        {needInvoice && (
          <div className="row2">
            <div className="field">
              <label>Įmonės pavadinimas<span className="req">*</span></label>
              <input
                type="text"
                value={form.company}
                onChange={(e) => setField("company", e.target.value)}
                placeholder="UAB Pavadinimas"
                className={errors.company ? "invalid" : ""}
              />
              {errors.company && <div className="err">{errors.company}</div>}
            </div>
            <div className="field">
              <label>Įmonės kodas<span className="req">*</span></label>
              <input
                type="text"
                value={form.vat}
                onChange={(e) => setField("vat", e.target.value)}
                placeholder="123456789"
                className={errors.vat ? "invalid" : ""}
              />
              {errors.vat && <div className="err">{errors.vat}</div>}
            </div>
          </div>
        )}

        <div className="field">
          <label>Komentaras (neprivaloma)</label>
          <textarea
            value={form.notes}
            onChange={(e) => setField("notes", e.target.value)}
            placeholder="Pageidavimai dėl pristatymo, klausimai apie produktą..."
          />
        </div>

        {/* Total */}
        <div className="order-total">
          <div>
            <div style={{ color: "var(--muted)" }}>{qty} × {formatEUR(UNIT_PRICE)}</div>
            <div style={{ color: "var(--muted)", marginTop: 4 }}>
              Pristatymas: {shipping === 0 ? <span style={{ color: "var(--ok)" }}>nemokamai</span> : formatEUR(shipping)}
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ color: "var(--muted)", fontSize: 11 }}>Iš viso, su PVM</div>
            <b>{formatEUR(total)}</b>
          </div>
        </div>

        <label className="checkbox" style={{ marginBottom: 4 }}>
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className={errors.agree ? "invalid" : ""} />
          <span>Sutinku su <a href="#" style={{ color: "var(--ink)", textDecoration: "underline" }}>pirkimo taisyklėmis</a> ir <a href="#" style={{ color: "var(--ink)", textDecoration: "underline" }}>privatumo politika</a>.</span>
        </label>
        {errors.agree && <div className="err" style={{ marginTop: -4, marginBottom: 10 }}>{errors.agree}</div>}

        {globalError && (
          <div className="err" style={{ padding: "10px 12px", border: "1px solid var(--warn)", borderRadius: 8, marginBottom: 12, background: "#FFF5EE" }}>
            {globalError}
          </div>
        )}

        <button type="submit" className="btn btn-primary submit" disabled={submitting} style={submitting ? { opacity: 0.7, cursor: "wait" } : null}>
          {submitting ? "Siunčiama…" : <>Pateikti užklausą — {formatEUR(total)}</>}
          {!submitting && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 8h8m0 0L8.5 4.5M12 8l-3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/></svg>}
        </button>
        <div className="form-foot">
          🔒 Jūsų duomenys saugūs. Apmokėjimas po patvirtinimo — pavedimu arba grynaisiais.
        </div>
      </form>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById("order-root"));
root.render(<OrderForm />);
