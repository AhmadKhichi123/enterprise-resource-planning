/*
 * Boutique ERP — browser edition (runs on GitHub Pages, no server needed).
 * Same features and calculations as the Python/Flask version (store_db.py):
 * inventory, point of sale, receipts, returns, expenses, accounts, reports.
 * Data is saved in this browser (localStorage). Use Settings → Backup to keep a copy
 * or to move the data to another device.
 */
"use strict";

// ------------------------------------------------------------- constants
const CATEGORIES = ["Lawn", "Kurti", "Shalwar Kameez", "3-Piece Suit", "Formal / Bridal",
  "Dupatta", "Trousers", "Abaya", "Western", "Accessories", "Other"];
const SIZES = ["XS", "S", "M", "L", "XL", "XXL", "Unstitched", "Free Size"];
const ACCOUNTS = ["Cash", "Bank", "JazzCash", "Easypaisa", "Card"];
const EXPENSE_CATEGORIES = ["Rent", "Salaries", "Electricity", "Gas", "Water", "Internet / Phone",
  "Tailoring / Stitching", "Transport / Delivery", "Packaging", "Marketing", "Maintenance",
  "Taxes / Fees", "Other"];
const KEY = "boutique_erp_v1";

// --------------------------------------------------------------- helpers
const pad = n => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const monthKey = d => (d || today()).slice(0, 7);
const r2 = x => Math.round(x * 100) / 100;
const money = x => { x = Number(x) || 0; return (x < 0 ? "-" : "") + "Rs " + Math.abs(Math.round(x)).toLocaleString("en-US"); };
const n0 = x => Math.round(Number(x) || 0).toLocaleString("en-US");
const pct = x => (Number(x) || 0).toFixed(1) + "%";
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthName = m => { const [y, mm] = (m || "").split("-"); return MONTHS[+mm - 1] ? `${MONTHS[+mm - 1]} ${y}` : m; };
const shortMonth = m => monthName(m).slice(0, 3);
function num(v, name = "Value", integer = false) {
  const s = String(v ?? "").replace(/,/g, "").trim();
  const x = s === "" ? 0 : Number(s);
  if (!Number.isFinite(x)) throw new Error(`${name} must be a number.`);
  return integer ? Math.trunc(x) : x;
}
function validDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s || "") || isNaN(Date.parse(s))) throw new Error("Date must be like 2026-11-18.");
  return s;
}
async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}
function download(filename, text, type = "text/plain") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
function csv(filename, header, rows) {
  const cell = v => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  download(filename, "﻿" + [header, ...rows].map(r => r.map(cell).join(",")).join("\r\n"), "text/csv");
}

// ============================================================ DATA STORE
const emptyDB = () => ({ version: 1, settings: {}, products: [], sales: [], purchases: [],
  expenses: [], transactions: [], seq: { product: 0, sale: 0, purchase: 0, expense: 0, txn: 0 } });
let DB = load();

function load() {
  try { const d = JSON.parse(localStorage.getItem(KEY)); if (d && d.version === 1) return d; } catch (e) { /* ignore */ }
  return emptyDB();
}
function save() { localStorage.setItem(KEY, JSON.stringify(DB)); }
const nextId = k => ++DB.seq[k];
const product = id => DB.products.find(p => p.id === +id);
const sale = id => DB.sales.find(s => s.id === +id);

function txn(date, account, kind, description, amount, ref_table = null, ref_id = null) {
  DB.transactions.push({ id: nextId("txn"), date, account, kind, description, amount: r2(amount), ref_table, ref_id });
}

const store = {
  addProduct(f) {
    const name = (f.name || "").trim();
    if (!name) throw new Error("Product name is required.");
    const cost = num(f.cost_price, "Cost price"), price = num(f.sale_price, "Sale price");
    const qty = num(f.quantity, "Quantity", true), rl = num(f.reorder_level, "Reorder level", true);
    if (cost < 0 || price < 0 || qty < 0) throw new Error("Prices and quantity cannot be negative.");
    let code = (f.code || "").trim();
    const id = nextId("product");
    if (!code) code = "P" + String(id).padStart(4, "0");
    if (DB.products.some(p => p.code.toLowerCase() === code.toLowerCase())) { DB.seq.product--; throw new Error("That product code is already used."); }
    const p = { id, code, name, category: f.category || "", size: f.size || "", color: (f.color || "").trim(),
      cost_price: cost, sale_price: price, quantity: 0, reorder_level: rl, active: true, created: today() };
    DB.products.push(p);
    if (qty > 0) {
      if (f.record_purchase) this.restock(id, qty, cost, f.supplier || "", f.account || "Cash", today());
      else p.quantity = qty;
    }
    save();
    return id;
  },
  updateProduct(id, f) {
    const p = product(id);
    const name = (f.name || "").trim();
    if (!name) throw new Error("Product name is required.");
    const code = (f.code || "").trim() || p.code;
    if (DB.products.some(x => x.id !== p.id && x.code.toLowerCase() === code.toLowerCase())) throw new Error("That product code is already used.");
    Object.assign(p, { name, code, category: f.category || "", size: f.size || "", color: (f.color || "").trim(),
      cost_price: num(f.cost_price, "Cost price"), sale_price: num(f.sale_price, "Sale price"),
      reorder_level: num(f.reorder_level, "Reorder level", true) });
    save();
  },
  restock(id, qty, unitCost, supplier = "", account = "Cash", date = today()) {
    qty = num(qty, "Quantity", true); unitCost = num(unitCost, "Cost");
    if (qty <= 0) throw new Error("Quantity must be more than zero.");
    const p = product(id);
    const newQ = p.quantity + qty;
    p.cost_price = r2(((p.quantity * p.cost_price) + qty * unitCost) / newQ);   // weighted average cost
    p.quantity = newQ;
    const total = qty * unitCost, pid = nextId("purchase");
    DB.purchases.push({ id: pid, date, product_id: p.id, name: p.name, qty, unit_cost: unitCost, total, supplier, account });
    txn(date, account, "Purchase", `Stock: ${qty} x ${p.name}` + (supplier ? ` (${supplier})` : ""), -total, "purchases", pid);
    save();
  },
  adjustStock(id, qty) {
    qty = num(qty, "Quantity", true);
    if (qty < 0) throw new Error("Quantity cannot be negative.");
    product(id).quantity = qty; save();
  },
  deleteProduct(id) { product(id).active = false; save(); },
  listProducts(search = "", category = "All", lowOnly = false) {
    const q = search.toLowerCase();
    return DB.products.filter(p => p.active
      && (!q || [p.name, p.code, p.color].join(" ").toLowerCase().includes(q))
      && (category === "All" || p.category === category)
      && (!lowOnly || p.quantity <= p.reorder_level))
      .sort((a, b) => a.name.localeCompare(b.name));
  },
  stockValue() {
    const ps = DB.products.filter(p => p.active);
    return { cost: ps.reduce((s, p) => s + p.quantity * p.cost_price, 0),
      retail: ps.reduce((s, p) => s + p.quantity * p.sale_price, 0), units: ps.reduce((s, p) => s + p.quantity, 0) };
  },
  recordSale(items, { customer = "", phone = "", account = "Cash", discount = 0, date = today() } = {}) {
    if (!items.length) throw new Error("Add at least one item to the sale.");
    discount = num(discount, "Discount");
    let subtotal = 0, cost = 0;
    const need = {};
    const rows = items.map(it => {
      const p = product(it.id), qty = num(it.qty, "Quantity", true), price = num(it.price, "Price");
      if (!p || !p.active) throw new Error("A product in the bill no longer exists.");
      if (qty <= 0) throw new Error("Quantity must be more than zero.");
      need[p.id] = (need[p.id] || 0) + qty;
      if (need[p.id] > p.quantity) throw new Error(`Only ${p.quantity} of '${p.name}' in stock.`);
      subtotal += qty * price; cost += qty * p.cost_price;
      return { p, qty, price };
    });
    if (discount < 0 || discount > subtotal) throw new Error("Discount must be between 0 and the subtotal.");
    const id = nextId("sale"), total = subtotal - discount;
    DB.sales.push({ id, date, time: nowTime(), customer, phone, account, subtotal, discount, total,
      cost_total: r2(cost), items: rows.map(r => ({ product_id: r.p.id, name: r.p.name + (r.p.size ? ` (${r.p.size})` : ""),
        qty: r.qty, unit_price: r.price, unit_cost: r.p.cost_price, category: r.p.category })) });
    rows.forEach(r => { r.p.quantity -= r.qty; });
    txn(date, account, "Sale", `Sale #${id}` + (customer ? ` - ${customer}` : ""), total, "sales", id);
    save();
    return id;
  },
  cancelSale(id) {
    const s = sale(id);
    if (!s) throw new Error("Sale not found.");
    s.items.forEach(it => { const p = product(it.product_id); if (p) p.quantity += it.qty; });
    DB.transactions = DB.transactions.filter(t => !(t.ref_table === "sales" && t.ref_id === s.id));
    DB.sales = DB.sales.filter(x => x.id !== s.id);
    save();
  },
  listSales(start, end, q = "") {
    q = q.toLowerCase();
    return DB.sales.filter(s => (!start || s.date >= start) && (!end || s.date <= end)
      && (!q || (s.customer || "").toLowerCase().includes(q) || (s.phone || "").includes(q) || String(s.id) === q))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  },
  addExpense(f) {
    const amount = num(f.amount, "Amount");
    if (amount <= 0) throw new Error("Amount must be more than zero.");
    const date = validDate(f.date), id = nextId("expense"), category = (f.category || "Other").trim() || "Other";
    DB.expenses.push({ id, date, category, description: (f.description || "").trim(), amount, account: f.account || "Cash" });
    txn(date, f.account || "Cash", "Expense", category + (f.description ? `: ${f.description.trim()}` : ""), -amount, "expenses", id);
    save();
  },
  deleteExpense(id) {
    DB.expenses = DB.expenses.filter(e => e.id !== +id);
    DB.transactions = DB.transactions.filter(t => !(t.ref_table === "expenses" && t.ref_id === +id));
    save();
  },
  listExpenses(month) {
    return DB.expenses.filter(e => !month || e.date.startsWith(month)).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  },
  expensesByCategory(month) {
    const m = {};
    this.listExpenses(month).forEach(e => { m[e.category] = (m[e.category] || 0) + e.amount; });
    return Object.entries(m).map(([category, total]) => ({ category, total })).sort((a, b) => b.total - a.total);
  },
  manualEntry(account, kind, description, amount, date) {
    amount = Math.abs(num(amount, "Amount"));
    if (!amount) throw new Error("Amount must be more than zero.");
    if (!["Opening", "Deposit", "Withdrawal"].includes(kind)) throw new Error("Unknown entry type.");
    txn(validDate(date), account, kind, description, kind === "Withdrawal" ? -amount : amount, "manual");
    save();
  },
  transfer(from, to, amount, description, date) {
    amount = num(amount, "Amount");
    if (amount <= 0 || from === to) throw new Error("Enter a positive amount and two different accounts.");
    date = validDate(date);
    const d = description || `${from} → ${to}`;
    txn(date, from, "Transfer", d, -amount, "manual"); txn(date, to, "Transfer", d, amount, "manual");
    save();
  },
  deleteManual(id) {
    const t = DB.transactions.find(x => x.id === +id);
    if (!t || t.ref_table !== "manual") throw new Error("Only manual entries can be deleted here.");
    DB.transactions = DB.transactions.filter(x => x.id !== +id); save();
  },
  balances() {
    const b = Object.fromEntries(ACCOUNTS.map(a => [a, 0]));
    DB.transactions.forEach(t => { b[t.account] = (b[t.account] || 0) + t.amount; });
    return b;
  },
  ledger(account = "All", month = null) {
    const match = t => account === "All" || t.account === account;
    const sorted = DB.transactions.filter(match).sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    let bal = month ? sorted.filter(t => t.date.slice(0, 7) < month).reduce((s, t) => s + t.amount, 0) : 0;
    const start = bal;
    const rows = sorted.filter(t => !month || t.date.startsWith(month)).map(t => { bal += t.amount; return [t, bal]; });
    return { start, rows };
  },
  monthSummary(month) {
    const ss = DB.sales.filter(s => s.date.startsWith(month));
    const revenue = ss.reduce((s, x) => s + x.total, 0), cogs = ss.reduce((s, x) => s + x.cost_total, 0);
    const expenses = DB.expenses.filter(e => e.date.startsWith(month)).reduce((s, e) => s + e.amount, 0);
    const gross = revenue - cogs, net = gross - expenses;
    return { month, sales_count: ss.length, units_sold: ss.reduce((s, x) => s + x.items.reduce((a, i) => a + i.qty, 0), 0),
      revenue, discounts: ss.reduce((s, x) => s + x.discount, 0), cogs, gross_profit: gross, expenses, net_profit: net,
      purchases: DB.purchases.filter(p => p.date.startsWith(month)).reduce((s, p) => s + p.total, 0),
      gross_margin: revenue ? gross / revenue * 100 : 0, net_margin: revenue ? net / revenue * 100 : 0 };
  },
  daySummary(d = today()) {
    const ss = DB.sales.filter(s => s.date === d);
    return { n: ss.length, revenue: ss.reduce((s, x) => s + x.total, 0), gross: ss.reduce((s, x) => s + x.total - x.cost_total, 0) };
  },
  monthsWithData() {
    const set = new Set([monthKey()]);
    [DB.sales, DB.expenses, DB.purchases, DB.transactions].forEach(list => list.forEach(x => set.add(x.date.slice(0, 7))));
    return [...set].sort().reverse();
  },
  lastNMonths(n = 12) {
    let [y, m] = monthKey().split("-").map(Number); const out = [];
    for (let i = 0; i < n; i++) { out.push(`${y}-${pad(m)}`); if (--m === 0) { m = 12; y--; } }
    return out.reverse();
  },
  bestSellers(month, limit = 10) {
    const m = {};
    DB.sales.filter(s => s.date.startsWith(month)).forEach(s => s.items.forEach(i => {
      const r = m[i.name] || (m[i.name] = { name: i.name, qty: 0, revenue: 0, profit: 0 });
      r.qty += i.qty; r.revenue += i.qty * i.unit_price; r.profit += i.qty * (i.unit_price - i.unit_cost);
    }));
    return Object.values(m).sort((a, b) => b.qty - a.qty).slice(0, limit);
  },
  salesByCategory(month) {
    const m = {};
    DB.sales.filter(s => s.date.startsWith(month)).forEach(s => s.items.forEach(i => {
      const c = i.category || "Other", r = m[c] || (m[c] = { category: c, qty: 0, revenue: 0 });
      r.qty += i.qty; r.revenue += i.qty * i.unit_price;
    }));
    return Object.values(m).sort((a, b) => b.revenue - a.revenue);
  },
};

// ===================================================================== UI
const root = document.getElementById("root");
const view = { invQ: "", invCat: "All", invLow: false, salesStart: monthKey() + "-01", salesEnd: today(), salesQ: "",
  expMonth: monthKey(), accAcc: "All", accMonth: monthKey(), repMonth: monthKey(), cart: [], posQ: "" };
let flashMsg = null;

function flash(msg, kind = "ok") { flashMsg = { msg, kind }; }
function showToast() {
  if (!flashMsg) return;
  document.querySelectorAll(".toast").forEach(t => t.remove());
  const el = document.createElement("div");
  el.className = `flash ${flashMsg.kind} toast`;
  el.setAttribute("role", flashMsg.kind === "error" ? "alert" : "status");
  el.textContent = flashMsg.msg;
  document.body.appendChild(el);
  flashMsg = null;
  setTimeout(() => el.remove(), 3500);
}
const go = hash => { if (location.hash === hash) render(); else location.hash = hash; };
const opts = (list, sel) => list.map(x => `<option ${x === sel ? "selected" : ""}>${esc(x)}</option>`).join("");
const accOpts = sel => opts(ACCOUNTS, sel);
const datalist = (id, list) => `<datalist id="${id}">${list.map(x => `<option value="${esc(x)}">`).join("")}</datalist>`;
const monthPicker = (name, sel) => `<div><label for="mp-${name}">Month</label><select id="mp-${name}" data-change="${name}">
  ${store.monthsWithData().map(m => `<option value="${m}" ${m === sel ? "selected" : ""}>${monthName(m)}</option>`).join("")}</select></div>`;
const stat = (label, value, sub = "", cls = "") =>
  `<div class="stat"><div class="label">${label}</div><div class="value ${cls}">${value}</div>${sub ? `<div class="small muted">${sub}</div>` : ""}</div>`;
const table = (head, body, empty, foot = "") => `<div class="table-wrap"><table><thead><tr>${head}</tr></thead>
  <tbody>${body || `<tr><td colspan="12" class="empty">${empty}</td></tr>`}</tbody>${foot}</table></div>`;

// ---------------------------------------------------------- auth screens
function authed() { return sessionStorage.getItem("unlocked") === "1" || localStorage.getItem("remember") === DB.settings.pass_hash; }

function setupView() {
  return `<main class="auth"><div class="logo" aria-hidden="true">👗</div><h1>Welcome</h1>
  <p class="muted center">Set up the shop. This page only appears once on this device.</p>
  <form class="card" data-form="setup">
    <h2>Shop details (printed on receipts)</h2>
    <p><label for="sn">Shop name</label><input id="sn" name="shop_name" required></p>
    <p><label for="sa">Address</label><input id="sa" name="shop_address"></p>
    <p><label for="sp">Phone</label><input id="sp" name="shop_phone"></p>
    <h2>Password to open the app</h2>
    <p><label for="pw">Password (at least 6 characters)</label><input id="pw" type="password" name="password" minlength="6" required autocomplete="new-password"></p>
    <p><label for="pw2">Repeat password</label><input id="pw2" type="password" name="password2" minlength="6" required autocomplete="new-password"></p>
    <button class="btn primary block" type="submit">Create shop</button>
  </form>
  <p class="muted small center">Already have a backup file? <label class="btn sm" style="display:inline-block">Restore backup<input type="file" accept=".json" data-restore hidden></label></p></main>`;
}
function loginView() {
  return `<main class="auth"><div class="logo" aria-hidden="true">👗</div><h1>${esc(DB.settings.shop_name)}</h1>
  <p class="muted center">Enter the password to continue</p>
  <form class="card" data-form="login">
    <p><label for="p">Password</label><input id="p" type="password" name="password" required autofocus autocomplete="current-password"></p>
    <p><label class="check"><input type="checkbox" name="remember" value="1"> Keep me logged in on this device</label></p>
    <button class="btn primary block" type="submit">Open</button>
  </form></main>`;
}

// ---------------------------------------------------------------- shell
function shell(active, content) {
  const link = (h, ico, text, keys) => `<a href="#/${h}" class="${keys.includes(active) ? "active" : ""}" ${keys[0] === active ? 'aria-current="page"' : ""}>
    <span class="ico" aria-hidden="true">${ico}</span>${text}</a>`;
  return `<header class="topbar">
    <button class="menu-btn" aria-label="Open menu" aria-expanded="false" aria-controls="sidenav" data-act="menu">☰</button>
    <a class="brand" href="#/">${esc(DB.settings.shop_name || "Boutique ERP")}</a>
    <button type="button" data-act="logout">Log out</button></header>
  <div class="layout"><nav class="side" id="sidenav" aria-label="Main">
    ${link("", "🏠", "Dashboard", ["dashboard"])}${link("sale", "🛍️", "New Sale", ["sale"])}
    ${link("inventory", "👗", "Inventory", ["inventory", "product"])}${link("sales", "🧾", "Sales History", ["sales", "receipt"])}
    ${link("expenses", "💸", "Expenses", ["expenses"])}${link("accounts", "🏦", "Accounts", ["accounts"])}
    ${link("reports", "📊", "Reports", ["reports"])}${link("settings", "⚙️", "Settings", ["settings"])}
  </nav><main id="main">${content}</main></div>`;
}

// ------------------------------------------------------------ dashboard
function dashboardView() {
  const day = store.daySummary(), ms = store.monthSummary(monthKey()), sv = store.stockValue(), bal = store.balances();
  const hist = store.lastNMonths(6).map(m => store.monthSummary(m));
  const peak = Math.max(1, ...hist.map(h => Math.max(h.revenue, h.expenses, Math.abs(h.net_profit))));
  const h = v => (Math.abs(v) / peak * 100).toFixed(1) + "%";
  const low = store.listProducts("", "All", true), recent = store.listSales().slice(0, 8);
  const total = Object.values(bal).reduce((a, b) => a + b, 0);
  const backupNote = !DB.settings.last_backup || DB.settings.last_backup < new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10)
    ? `<div class="notice">💾 Data is saved in this browser. <a href="#/settings">Download a backup</a> regularly so nothing is lost.</div>` : "";
  return `${backupNote}<div class="page-head"><div><h1>Dashboard</h1><div class="muted">${today()}</div></div>
    <div class="actions"><a class="btn primary" href="#/sale">+ New Sale</a><a class="btn" href="#/expenses">+ Expense</a></div></div>
  <div class="stats">
    ${stat("Today's sales", money(day.revenue), `${day.n} sale(s) · profit ${money(day.gross)}`)}
    ${stat("This month's revenue", money(ms.revenue), `${ms.sales_count} sales · ${ms.units_sold} items`)}
    ${stat("This month's net profit", money(ms.net_profit), `Gross margin ${pct(ms.gross_margin)}`, ms.net_profit >= 0 ? "green" : "red")}
    ${stat("This month's expenses", money(ms.expenses))}
    ${stat("Stock value (cost)", money(sv.cost), `${sv.units} items · retail ${money(sv.retail)}`)}
    ${stat("Total money", money(total), `<a href="#/accounts">See accounts →</a>`)}
  </div>
  <div class="grid g2">
    <div class="card"><h2>Last 6 months</h2>
      <div class="chart" role="img" aria-label="Revenue, expenses and net profit for the last 6 months">
      ${hist.map(x => `<div class="col"><div class="bars">
        <div class="bar b-rev" style="height:${h(x.revenue)}" title="Revenue ${money(x.revenue)}"></div>
        <div class="bar b-exp" style="height:${h(x.expenses)}" title="Expenses ${money(x.expenses)}"></div>
        <div class="bar ${x.net_profit >= 0 ? "b-pos" : "b-neg"}" style="height:${h(x.net_profit)}" title="Net profit ${money(x.net_profit)}"></div>
      </div><div class="lbl">${shortMonth(x.month)}</div></div>`).join("")}</div>
      <div class="legend"><span><i class="b-rev"></i>Revenue</span><span><i class="b-exp"></i>Expenses</span><span><i class="b-pos"></i>Profit</span><span><i class="b-neg"></i>Loss</span></div>
    </div>
    <div class="card"><h2>⚠ Low stock — reorder soon</h2>
      ${low.length ? table("<th>Product</th><th>Size</th><th class='num'>Left</th>",
        low.map(p => `<tr class="low"><td><a href="#/product/${p.id}">${esc(p.name)}</a></td><td>${esc(p.size)}</td><td class="num">${p.quantity}</td></tr>`).join(""), "")
        : `<p class="empty">All products are well stocked.</p>`}
    </div>
  </div>
  <div class="card"><h2>Recent sales</h2>
    ${recent.length ? table("<th>#</th><th>Date</th><th>Customer</th><th class='hide-sm'>Paid by</th><th class='num'>Total</th>",
      recent.map(s => `<tr><td><a href="#/receipt/${s.id}">${s.id}</a></td><td class="nowrap">${s.date}</td><td>${esc(s.customer || "-")}</td><td class="hide-sm">${esc(s.account)}</td><td class="num">${money(s.total)}</td></tr>`).join(""), "")
      : `<p class="empty">No sales yet. <a href="#/sale">Make the first sale →</a></p>`}
  </div>`;
}

// ------------------------------------------------------------ inventory
function inventoryView() {
  const ps = store.listProducts(view.invQ, view.invCat, view.invLow), sv = store.stockValue();
  return `<div class="page-head"><div><h1>Inventory</h1>
      <div class="muted">${sv.units} items in stock · cost ${money(sv.cost)} · retail value ${money(sv.retail)}</div></div>
    <div class="actions"><a class="btn primary" href="#/product/new">+ Add Product</a><button class="btn" data-act="inv-csv">Export to Excel (CSV)</button></div></div>
  <div class="filters">
    <div><label for="iq">Search</label><input id="iq" data-input="invQ" value="${esc(view.invQ)}" placeholder="Name, code or colour"></div>
    <div><label for="ic">Category</label><select id="ic" data-change="invCat"><option>All</option>${opts(CATEGORIES, view.invCat)}</select></div>
    <label class="check"><input type="checkbox" data-change="invLow" ${view.invLow ? "checked" : ""}> Low stock only</label>
  </div>
  <div id="invtable">${inventoryTable(ps)}</div>`;
}
function inventoryTable(ps) {
  return table(`<th>Code</th><th>Product</th><th class="hide-sm">Category</th><th>Size</th><th class="hide-sm">Colour</th>
    <th class="num hide-sm">Cost</th><th class="num">Price</th><th class="num hide-sm">Profit/item</th><th class="num">Stock</th><th class="num hide-sm">Stock value</th>`,
  ps.map(p => { const low = p.quantity <= p.reorder_level; return `<tr class="${low ? "low" : ""}"><td>${esc(p.code)}</td>
    <td><a href="#/product/${p.id}">${esc(p.name)}</a></td><td class="hide-sm">${esc(p.category)}</td><td>${esc(p.size)}</td><td class="hide-sm">${esc(p.color)}</td>
    <td class="num hide-sm">${money(p.cost_price)}</td><td class="num">${money(p.sale_price)}</td><td class="num hide-sm">${money(p.sale_price - p.cost_price)}</td>
    <td class="num">${p.quantity}${low ? ' <span class="badge red">low</span>' : ""}</td><td class="num hide-sm">${money(p.quantity * p.cost_price)}</td></tr>`; }).join(""),
  `No products found. <a href="#/product/new">Add one →</a>`);
}

function productFormView(id) {
  const isNew = id === "new", p = isNew ? { reorder_level: 3, quantity: 0 } : product(id);
  if (!p) return notFound();
  const v = k => esc(p[k] ?? "");
  return `<div class="page-head"><h1>${isNew ? "Add product" : "Edit product"}</h1>
    <a class="btn" href="${isNew ? "#/inventory" : "#/product/" + p.id}">Cancel</a></div>
  <form class="card" data-form="product" data-id="${isNew ? "" : p.id}">
    <div class="fields">
      <div><label for="name">Product name *</label><input id="name" name="name" required value="${v("name")}"></div>
      <div><label for="code">Code ${isNew ? "(blank = automatic)" : ""}</label><input id="code" name="code" value="${v("code")}"></div>
      <div><label for="cat">Category</label><input id="cat" name="category" list="cats" value="${v("category")}">${datalist("cats", CATEGORIES)}</div>
      <div><label for="size">Size</label><input id="size" name="size" list="sizes" value="${v("size")}">${datalist("sizes", SIZES)}</div>
      <div><label for="color">Colour</label><input id="color" name="color" value="${v("color")}"></div>
    </div>
    <div class="fields">
      <div><label for="cost">Cost price (Rs) *</label><input id="cost" name="cost_price" inputmode="decimal" required value="${v("cost_price")}"></div>
      <div><label for="sale">Sale price (Rs) *</label><input id="sale" name="sale_price" inputmode="decimal" required value="${v("sale_price")}"></div>
      <div><label for="rl">Warn when stock is at or below</label><input id="rl" name="reorder_level" inputmode="numeric" value="${v("reorder_level")}"></div>
    </div>
    ${isNew ? `<h2>Opening stock</h2><div class="fields">
      <div><label for="qty">Quantity</label><input id="qty" name="quantity" inputmode="numeric" value="0"></div>
      <div><label for="sup">Supplier</label><input id="sup" name="supplier"></div>
      <div><label for="acc">Paid from</label><select id="acc" name="account">${accOpts()}</select></div></div>
      <p><label class="check"><input type="checkbox" name="record_purchase" value="1" checked>
      Record this stock as a purchase (takes the money out of the account). Untick if the stock was already in the shop.</label></p>` : ""}
    <button class="btn primary" type="submit">Save</button></form>`;
}

function productView(id) {
  const p = product(id);
  if (!p || !p.active) return notFound();
  const purchases = DB.purchases.filter(x => x.product_id === p.id).sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id);
  return `<div class="page-head"><div><h1>${esc(p.name)}</h1><div class="muted">${esc([p.code, p.category, p.size, p.color].filter(Boolean).join(" · "))}</div></div>
    <div class="actions"><a class="btn" href="#/inventory">← Inventory</a><a class="btn" href="#/product/${p.id}/edit">Edit</a>
      <button class="btn danger" data-act="del-product" data-id="${p.id}">Delete</button></div></div>
  <div class="stats">${stat("In stock", p.quantity, "", p.quantity <= p.reorder_level ? "red" : "")}${stat("Sale price", money(p.sale_price))}
    ${stat("Cost price (average)", money(p.cost_price))}${stat("Profit per item", money(p.sale_price - p.cost_price))}</div>
  <div class="grid g2">
    <form class="card" data-form="restock" data-id="${p.id}"><h2>Restock (bought more)</h2><div class="fields">
      <div><label for="rq">Quantity bought</label><input id="rq" name="qty" inputmode="numeric" required></div>
      <div><label for="rc">Cost per piece (Rs)</label><input id="rc" name="unit_cost" inputmode="decimal" value="${Math.round(p.cost_price)}" required></div>
      <div><label for="rs">Supplier</label><input id="rs" name="supplier"></div>
      <div><label for="ra">Paid from</label><select id="ra" name="account">${accOpts()}</select></div>
      <div><label for="rd">Date</label><input id="rd" type="date" name="date" value="${today()}" required></div></div>
      <button class="btn primary" type="submit">Add stock</button></form>
    <form class="card" data-form="adjust" data-id="${p.id}"><h2>Correct stock count</h2>
      <p class="muted small">Use after counting the shelf, or for damaged / lost items. No money is recorded.</p>
      <div class="fields"><div><label for="aq">Actual quantity</label><input id="aq" name="qty" inputmode="numeric" value="${p.quantity}" required></div></div>
      <button class="btn" type="submit">Save count</button></form>
  </div>
  <div class="card"><h2>Purchase history</h2>${purchases.length ? table("<th>Date</th><th class='num'>Qty</th><th class='num'>Cost/piece</th><th class='num'>Total</th><th>Supplier</th><th>Paid from</th>",
    purchases.map(r => `<tr><td>${r.date}</td><td class="num">${r.qty}</td><td class="num">${money(r.unit_cost)}</td><td class="num">${money(r.total)}</td><td>${esc(r.supplier || "-")}</td><td>${esc(r.account)}</td></tr>`).join(""), "")
    : `<p class="empty">No purchases recorded.</p>`}</div>`;
}

// ------------------------------------------------------------------ POS
function saleView() {
  return `<div class="page-head"><h1>New Sale</h1></div>
  <div class="pos">
    <div class="card"><h2>1. Tap a product to add it</h2>
      <input id="search" type="search" data-input="posQ" value="${esc(view.posQ)}" placeholder="Search name, code or colour…" aria-label="Search products" autocomplete="off">
      <div class="plist" id="plist" role="list" style="margin-top:10px">${posList()}</div></div>
    <form class="card bill" data-form="sale"><h2>2. Bill</h2>
      <div id="cart" aria-live="polite">${cartHtml()}</div>
      <div class="fields" style="margin-top:12px">
        <div><label for="customer">Customer name</label><input id="customer" name="customer"></div>
        <div><label for="phone">Phone (for WhatsApp receipt)</label><input id="phone" name="phone" inputmode="tel" placeholder="03xx xxxxxxx"></div>
        <div><label for="account">Paid by</label><select id="account" name="account">${accOpts()}</select></div>
        <div><label for="discount">Discount (Rs)</label><input id="discount" name="discount" inputmode="decimal" value="0" data-input="discount"></div>
        <div><label for="date">Date</label><input id="date" type="date" name="date" value="${today()}"></div>
      </div>
      <div class="totalbox"><div id="subline" class="small"></div><div class="big" id="total">Rs 0</div></div>
      <button class="btn primary block" type="submit">✔ Complete Sale</button></form>
  </div>`;
}
function posList() {
  const q = view.posQ.toLowerCase();
  const list = DB.products.filter(p => p.active && p.quantity > 0 && (!q || [p.name, p.code, p.color, p.category].join(" ").toLowerCase().includes(q)))
    .sort((a, b) => a.name.localeCompare(b.name));
  return list.length ? list.map(p => `<div class="prod" role="listitem" tabindex="0" data-add="${p.id}">
    <div><div class="nm">${esc(p.name)}</div><div class="small muted">${esc(p.code)} · ${esc(p.size)} · ${esc(p.color)} · ${p.quantity} in stock</div></div>
    <div class="price">${money(p.sale_price)}</div></div>`).join("") : `<p class="empty">No products in stock match.</p>`;
}
function cartHtml() {
  if (!view.cart.length) return `<p class="empty">No items yet.</p>`;
  return `<div class="cart-row small muted"><span>Item</span><span>Qty</span><span>Price</span><span></span></div>` +
    view.cart.map((c, i) => `<div class="cart-row"><span>${esc(c.name)}</span>
      <input aria-label="Quantity" inputmode="numeric" value="${c.qty}" data-cart="${i}" data-f="qty">
      <input aria-label="Price" inputmode="decimal" value="${c.price}" data-cart="${i}" data-f="price">
      <button type="button" class="x" aria-label="Remove ${esc(c.name)}" data-rm="${i}">×</button></div>`).join("");
}
function updateTotals() {
  const sub = view.cart.reduce((s, c) => s + c.qty * c.price, 0);
  const el = document.getElementById("discount"); const disc = el ? (Number(el.value.replace(/,/g, "")) || 0) : 0;
  const items = view.cart.reduce((s, c) => s + c.qty, 0);
  const sl = document.getElementById("subline"), t = document.getElementById("total");
  if (sl) sl.textContent = `${items} item(s) · Subtotal ${money(sub)} · Discount ${money(disc)}`;
  if (t) t.textContent = "TOTAL " + money(sub - disc);
}
function addToCart(id) {
  const p = product(id), line = view.cart.find(c => c.id === p.id);
  if (line) { if (line.qty < p.quantity) line.qty++; else return alert(`Only ${p.quantity} in stock.`); }
  else view.cart.push({ id: p.id, name: p.name + (p.size ? ` (${p.size})` : ""), qty: 1, price: p.sale_price, stock: p.quantity });
  document.getElementById("cart").innerHTML = cartHtml(); updateTotals();
}

// -------------------------------------------------------- sales/receipt
function salesView() {
  const rows = store.listSales(view.salesStart, view.salesEnd, view.salesQ);
  const tot = rows.reduce((s, r) => s + r.total, 0), prof = rows.reduce((s, r) => s + r.total - r.cost_total, 0);
  return `<div class="page-head"><div><h1>Sales History</h1><div class="muted">${rows.length} sales · revenue ${money(tot)} · profit ${money(prof)}</div></div>
    <button class="btn" data-act="sales-csv">Export to Excel (CSV)</button></div>
  <form class="filters" data-form="salesfilter">
    <div><label for="ss">From</label><input id="ss" type="date" name="start" value="${view.salesStart}"></div>
    <div><label for="se">To</label><input id="se" type="date" name="end" value="${view.salesEnd}"></div>
    <div><label for="sq">Customer / phone / sale #</label><input id="sq" name="q" value="${esc(view.salesQ)}"></div>
    <button class="btn primary" type="submit">Show</button></form>
  ${table(`<th>#</th><th>Date</th><th>Customer</th><th class="hide-sm">Phone</th><th class="hide-sm">Paid by</th><th class="num hide-sm">Discount</th><th class="num">Total</th><th class="num hide-sm">Profit</th>`,
    rows.map(s => `<tr><td><a href="#/receipt/${s.id}">${s.id}</a></td><td class="nowrap">${s.date} <span class="muted small">${s.time || ""}</span></td>
      <td><a href="#/receipt/${s.id}">${esc(s.customer || "-")}</a></td><td class="hide-sm">${esc(s.phone)}</td><td class="hide-sm">${esc(s.account)}</td>
      <td class="num hide-sm">${money(s.discount)}</td><td class="num">${money(s.total)}</td><td class="num hide-sm">${money(s.total - s.cost_total)}</td></tr>`).join(""),
    "No sales in this period.")}`;
}
function receiptView(id) {
  const s = sale(id), st = DB.settings;
  if (!s) return notFound();
  const lines = [`*${st.shop_name}*`, `Receipt #${s.id} - ${s.date}`,
    ...s.items.map(i => `${i.name} x${i.qty} = Rs ${n0(i.qty * i.unit_price)}`),
    ...(s.discount ? [`Discount: Rs ${n0(s.discount)}`] : []), `*Total: Rs ${n0(s.total)}*`, st.receipt_footer || "Thank you!"];
  let ph = (s.phone || "").replace(/\D/g, ""); if (ph.startsWith("0")) ph = "92" + ph.slice(1);
  const wa = `https://wa.me/${ph}?text=${encodeURIComponent(lines.join("\n"))}`;
  return `<div class="page-head no-print"><h1>Receipt #${s.id}</h1><div class="actions">
    <button class="btn primary" type="button" data-act="print">🖨 Print</button>
    <a class="btn" href="${wa}" target="_blank" rel="noopener">💬 Send on WhatsApp</a>
    <a class="btn" href="#/sale">+ Next sale</a>
    <button class="btn danger" data-act="cancel-sale" data-id="${s.id}">Cancel sale / Return</button></div></div>
  <div class="receipt"><h2>${esc(st.shop_name)}</h2>${st.shop_address ? `<div class="c">${esc(st.shop_address)}</div>` : ""}
    ${st.shop_phone ? `<div class="c">${esc(st.shop_phone)}</div>` : ""}<hr>
    <div>Receipt #: ${s.id}</div><div>Date: ${s.date} ${s.time || ""}</div>
    ${s.customer ? `<div>Customer: ${esc(s.customer)}</div>` : ""}${s.phone ? `<div>Phone: ${esc(s.phone)}</div>` : ""}<hr>
    <table><thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Price</th><th class="num">Amount</th></tr></thead>
    <tbody>${s.items.map(i => `<tr><td>${esc(i.name)}</td><td class="num">${i.qty}</td><td class="num">${n0(i.unit_price)}</td><td class="num">${n0(i.qty * i.unit_price)}</td></tr>`).join("")}</tbody></table><hr>
    <table><tr><td>Subtotal</td><td class="num">${n0(s.subtotal)}</td></tr>${s.discount ? `<tr><td>Discount</td><td class="num">-${n0(s.discount)}</td></tr>` : ""}
      <tr><td><b>TOTAL (Rs)</b></td><td class="num"><b>${n0(s.total)}</b></td></tr><tr><td>Paid by</td><td class="num">${esc(s.account)}</td></tr></table><hr>
    <div class="c">${esc(st.receipt_footer || "Thank you!")}</div></div>`;
}

// ------------------------------------------------------------- expenses
function expensesView() {
  const m = view.expMonth, rows = store.listExpenses(m), total = rows.reduce((s, e) => s + e.amount, 0);
  return `<div class="page-head"><div><h1>Expenses</h1><div class="muted">${monthName(m)} · total ${money(total)}</div></div></div>
  <form class="card" data-form="expense"><h2>Add expense</h2><div class="fields">
    <div><label for="ed">Date</label><input id="ed" type="date" name="date" value="${today()}" required></div>
    <div><label for="ec">Category</label><input id="ec" name="category" list="ecats" value="${EXPENSE_CATEGORIES[0]}" required>${datalist("ecats", EXPENSE_CATEGORIES)}</div>
    <div><label for="edesc">Description</label><input id="edesc" name="description"></div>
    <div><label for="eamt">Amount (Rs)</label><input id="eamt" name="amount" inputmode="decimal" required></div>
    <div><label for="eacc">Paid from</label><select id="eacc" name="account">${accOpts()}</select></div></div>
    <button class="btn primary" type="submit">+ Add expense</button></form>
  <div class="filters">${monthPicker("expMonth", m)}</div>
  <div class="grid" style="grid-template-columns: minmax(0,3fr) minmax(240px,1fr)">
    ${table(`<th>Date</th><th>Category</th><th>Description</th><th class="hide-sm">Paid from</th><th class="num">Amount</th><th></th>`,
      rows.map(e => `<tr><td class="nowrap">${e.date}</td><td>${esc(e.category)}</td><td>${esc(e.description)}</td><td class="hide-sm">${esc(e.account)}</td>
        <td class="num">${money(e.amount)}</td><td><button class="btn sm danger" data-act="del-expense" data-id="${e.id}" aria-label="Delete expense">✕</button></td></tr>`).join(""),
      "No expenses this month.", rows.length ? `<tfoot><tr><td colspan="4">Total</td><td class="num">${money(total)}</td><td></td></tr></tfoot>` : "")}
    <div class="card"><h2>By category</h2><table>${store.expensesByCategory(m).map(r => `<tr><td>${esc(r.category)}</td><td class="num">${money(r.total)}</td></tr>`).join("")
      || `<tr><td class="muted">Nothing yet</td></tr>`}</table></div></div>`;
}

// ------------------------------------------------------------- accounts
function accountsView() {
  const bal = store.balances(), { start, rows } = store.ledger(view.accAcc, view.accMonth);
  const tin = rows.reduce((s, [t]) => s + Math.max(0, t.amount), 0), tout = rows.reduce((s, [t]) => s + Math.max(0, -t.amount), 0);
  return `<div class="page-head"><h1>Accounts</h1></div>
  <div class="stats">${ACCOUNTS.map(a => stat(a, money(bal[a]), "", bal[a] < 0 ? "red" : "")).join("")}
    ${stat("TOTAL", money(Object.values(bal).reduce((a, b) => a + b, 0)))}</div>
  <div class="grid g2">
    <form class="card" data-form="entry"><h2>Add money in / out</h2><div class="fields">
      <div><label for="k">Type</label><select id="k" name="kind"><option value="Opening">Opening balance (money already there)</option>
        <option value="Deposit">Money in (owner deposit / other income)</option><option value="Withdrawal">Money out (owner withdrawal)</option></select></div>
      <div><label for="ea">Account</label><select id="ea" name="account">${accOpts()}</select></div>
      <div><label for="eam">Amount (Rs)</label><input id="eam" name="amount" inputmode="decimal" required></div>
      <div><label for="edn">Description</label><input id="edn" name="description"></div>
      <div><label for="edt">Date</label><input id="edt" type="date" name="date" value="${today()}" required></div></div>
      <button class="btn primary" type="submit">Save</button></form>
    <form class="card" data-form="transfer"><h2>Transfer between accounts</h2><p class="muted small">E.g. depositing the day's cash into the bank.</p><div class="fields">
      <div><label for="tf">From</label><select id="tf" name="from">${accOpts("Cash")}</select></div>
      <div><label for="tt">To</label><select id="tt" name="to">${accOpts("Bank")}</select></div>
      <div><label for="tam">Amount (Rs)</label><input id="tam" name="amount" inputmode="decimal" required></div>
      <div><label for="tn">Note</label><input id="tn" name="description"></div>
      <div><label for="tdt">Date</label><input id="tdt" type="date" name="date" value="${today()}" required></div></div>
      <button class="btn primary" type="submit">Transfer</button></form>
  </div>
  <h2>Ledger</h2>
  <div class="filters"><div><label for="acct">Account</label><select id="acct" data-change="accAcc"><option>All</option>${opts(ACCOUNTS, view.accAcc)}</select></div>
    ${monthPicker("accMonth", view.accMonth)}<div class="muted">Balance at start of month: <b>${money(start)}</b></div></div>
  ${table(`<th>Date</th><th>Account</th><th class="hide-sm">Type</th><th>Description</th><th class="num">In</th><th class="num">Out</th><th class="num">Balance</th><th></th>`,
    rows.map(([t, b]) => `<tr><td class="nowrap">${t.date}</td><td>${esc(t.account)}</td><td class="hide-sm"><span class="badge">${esc(t.kind)}</span></td><td>${esc(t.description)}</td>
      <td class="num green">${t.amount >= 0 ? money(t.amount) : ""}</td><td class="num red">${t.amount < 0 ? money(-t.amount) : ""}</td><td class="num">${money(b)}</td>
      <td>${t.ref_table === "manual" ? `<button class="btn sm danger" data-act="del-txn" data-id="${t.id}" aria-label="Delete entry">✕</button>` : ""}</td></tr>`).join(""),
    "No transactions this month.",
    `<tfoot><tr><td colspan="4">Money in ${money(tin)} · out ${money(tout)}</td><td colspan="4" class="num">Change ${money(tin - tout)}</td></tr></tfoot>`)}`;
}

// -------------------------------------------------------------- reports
function reportsView() {
  const m = view.repMonth, s = store.monthSummary(m);
  const year = store.lastNMonths(12).map(x => store.monthSummary(x)).reverse();
  const sum = k => year.reduce((a, x) => a + x[k], 0);
  return `<div class="page-head"><h1>Reports</h1><button class="btn" data-act="rep-csv">Export 12 months to Excel (CSV)</button></div>
  <div class="filters">${monthPicker("repMonth", m)}</div>
  <div class="grid g2">
    <div class="card"><h2>Profit &amp; Loss — ${monthName(m)}</h2><p class="muted small">${s.sales_count} sales · ${s.units_sold} items sold</p>
      <table class="pl">
        <tr><td><b>Sales revenue</b></td><td class="num"><b>${money(s.revenue)}</b></td></tr>
        <tr><td class="ind">after discounts given of</td><td class="num muted">${money(s.discounts)}</td></tr>
        <tr><td>Less: cost of clothes sold</td><td class="num">${money(-s.cogs)}</td></tr>
        <tr class="total"><td>Gross profit <span class="muted small">(${pct(s.gross_margin)})</span></td><td class="num">${money(s.gross_profit)}</td></tr>
        <tr><td colspan="2" style="padding-top:12px">Less: expenses</td></tr>
        ${store.expensesByCategory(m).map(r => `<tr><td class="ind">${esc(r.category)}</td><td class="num">${money(-r.total)}</td></tr>`).join("")}
        <tr class="total"><td>Total expenses</td><td class="num">${money(-s.expenses)}</td></tr>
        <tr class="grand"><td>NET PROFIT <span class="muted small">(${pct(s.net_margin)})</span></td><td class="num ${s.net_profit >= 0 ? "green" : "red"}">${money(s.net_profit)}</td></tr>
      </table><p class="muted small">Stock bought this month: ${money(s.purchases)}. Stock counts as a cost only when it is sold.</p></div>
    <div>
      <div class="card"><h2>Best sellers</h2>${table("<th>Product</th><th class='num'>Sold</th><th class='num'>Revenue</th><th class='num'>Profit</th>",
        store.bestSellers(m).map(r => `<tr><td>${esc(r.name)}</td><td class="num">${r.qty}</td><td class="num">${money(r.revenue)}</td><td class="num">${money(r.profit)}</td></tr>`).join(""), "No sales this month.")}</div>
      <div class="card"><h2>Sales by category</h2>${table("<th>Category</th><th class='num'>Items</th><th class='num'>Revenue</th>",
        store.salesByCategory(m).map(r => `<tr><td>${esc(r.category)}</td><td class="num">${r.qty}</td><td class="num">${money(r.revenue)}</td></tr>`).join(""), "No sales this month.")}</div>
    </div></div>
  <div class="card"><h2>Last 12 months</h2>${table(`<th>Month</th><th class="num">Revenue</th><th class="num hide-sm">Cost of goods</th><th class="num hide-sm">Gross profit</th><th class="num">Expenses</th><th class="num">Net profit</th><th class="num hide-sm">Margin</th><th class="num hide-sm">Stock bought</th>`,
    year.map(x => `<tr><td><a href="#" data-month="${x.month}">${monthName(x.month)}</a></td><td class="num">${money(x.revenue)}</td><td class="num hide-sm">${money(x.cogs)}</td>
      <td class="num hide-sm">${money(x.gross_profit)}</td><td class="num">${money(x.expenses)}</td><td class="num ${x.net_profit > 0 ? "green" : x.net_profit < 0 ? "red" : ""}">${money(x.net_profit)}</td>
      <td class="num hide-sm">${pct(x.net_margin)}</td><td class="num hide-sm">${money(x.purchases)}</td></tr>`).join(""), "",
    `<tfoot><tr><td>Total</td><td class="num">${money(sum("revenue"))}</td><td class="num hide-sm">${money(sum("cogs"))}</td><td class="num hide-sm">${money(sum("gross_profit"))}</td>
      <td class="num">${money(sum("expenses"))}</td><td class="num">${money(sum("net_profit"))}</td><td class="hide-sm"></td><td class="num hide-sm">${money(sum("purchases"))}</td></tr></tfoot>`)}</div>`;
}

// ------------------------------------------------------------- settings
function settingsView() {
  const st = DB.settings, v = k => esc(st[k] || "");
  return `<div class="page-head"><h1>Settings</h1></div>
  <div class="grid g2">
    <form class="card" data-form="shop"><h2>Shop details (on receipts)</h2>
      <p><label for="sn">Shop name</label><input id="sn" name="shop_name" value="${v("shop_name")}" required></p>
      <p><label for="sa">Address</label><input id="sa" name="shop_address" value="${v("shop_address")}"></p>
      <p><label for="sp">Phone</label><input id="sp" name="shop_phone" value="${v("shop_phone")}"></p>
      <p><label for="sf">Receipt message</label><input id="sf" name="receipt_footer" value="${v("receipt_footer")}"></p>
      <button class="btn primary" type="submit">Save</button></form>
    <form class="card" data-form="password"><h2>Change password</h2>
      <p><label for="o">Current password</label><input id="o" type="password" name="old" required autocomplete="current-password"></p>
      <p><label for="n">New password</label><input id="n" type="password" name="new" minlength="6" required autocomplete="new-password"></p>
      <p><label for="n2">Repeat new password</label><input id="n2" type="password" name="new2" minlength="6" required autocomplete="new-password"></p>
      <button class="btn primary" type="submit">Change password</button></form>
  </div>
  <div class="card"><h2>Backup &amp; restore</h2>
    <p class="muted">All shop data is saved <b>in this browser on this device</b>. Download a backup at least once a week and keep it on a USB drive or in Google Drive.
      To use the app on another phone or computer, download a backup here and restore it there.</p>
    <p class="small muted">Last backup: ${st.last_backup || "never"}</p>
    <div class="actions"><button class="btn primary" data-act="backup">⬇ Download backup</button>
      <label class="btn">⬆ Restore from backup<input type="file" accept=".json" data-restore hidden></label></div></div>
  <div class="card"><h2>Danger zone</h2><p class="muted small">Delete all shop data from this browser. Download a backup first.</p>
    <button class="btn danger" data-act="wipe">Delete all data</button></div>`;
}
const notFound = () => `<div class="card"><h1>Not found</h1><p>That page or record does not exist.</p><a class="btn" href="#/">Go home</a></div>`;

// ================================================================ ROUTER
function render() {
  if (!DB.settings.pass_hash) { root.innerHTML = setupView(); return showToast(); }
  if (!authed()) { root.innerHTML = loginView(); return showToast(); }
  const parts = location.hash.replace(/^#\/?/, "").split("/");
  const [a, b, c] = parts;
  let active = a || "dashboard", html;
  switch (a || "") {
    case "": html = dashboardView(); break;
    case "sale": html = saleView(); break;
    case "inventory": html = inventoryView(); break;
    case "product": html = c === "edit" ? productFormView(b) : b === "new" ? productFormView("new") : productView(b); break;
    case "sales": html = salesView(); break;
    case "receipt": html = receiptView(b); break;
    case "expenses": html = expensesView(); break;
    case "accounts": html = accountsView(); break;
    case "reports": html = reportsView(); break;
    case "settings": html = settingsView(); break;
    default: html = notFound();
  }
  root.innerHTML = shell(active, html);
  document.title = `${(document.querySelector("main h1") || {}).textContent || "Boutique ERP"} · ${DB.settings.shop_name}`;
  if (a === "sale") updateTotals();
  window.scrollTo(0, 0);
  showToast();
}
window.addEventListener("hashchange", render);

// ================================================================ EVENTS
const formHandlers = {
  async setup(f) {
    if (f.password !== f.password2) throw new Error("The two passwords do not match.");
    if (f.password.length < 6) throw new Error("Password must be at least 6 characters.");
    Object.assign(DB.settings, { shop_name: f.shop_name.trim(), shop_address: f.shop_address.trim(), shop_phone: f.shop_phone.trim(),
      receipt_footer: "Thank you for shopping with us!", pass_hash: await sha256(f.password) });
    save(); sessionStorage.setItem("unlocked", "1");
    flash("Welcome! Start by entering opening balances in Accounts and adding products."); go("#/");
  },
  async login(f) {
    if (await sha256(f.password) !== DB.settings.pass_hash) throw new Error("Wrong password.");
    sessionStorage.setItem("unlocked", "1");
    if (f.remember) localStorage.setItem("remember", DB.settings.pass_hash);
    render();
  },
  product(f, form) {
    if (form.dataset.id) { store.updateProduct(form.dataset.id, f); flash("Product updated."); go("#/product/" + form.dataset.id); }
    else { const id = store.addProduct(f); flash(`Added '${f.name.trim()}'.`); go("#/product/" + id); }
  },
  restock(f, form) { store.restock(form.dataset.id, f.qty, f.unit_cost, f.supplier.trim(), f.account, validDate(f.date)); flash("Stock added and payment recorded."); render(); },
  adjust(f, form) { store.adjustStock(form.dataset.id, f.qty); flash("Stock count corrected."); render(); },
  sale(f) {
    if (!view.cart.length) throw new Error("Add at least one item to the bill.");
    const id = store.recordSale(view.cart, { customer: f.customer.trim(), phone: f.phone.trim(), account: f.account,
      discount: f.discount, date: validDate(f.date || today()) });
    view.cart = []; view.posQ = ""; flash(`Sale #${id} saved.`); go("#/receipt/" + id);
  },
  salesfilter(f) { view.salesStart = f.start; view.salesEnd = f.end; view.salesQ = f.q.trim(); render(); },
  expense(f) { store.addExpense(f); view.expMonth = f.date.slice(0, 7); flash("Expense added."); render(); },
  entry(f) { store.manualEntry(f.account, f.kind, f.description.trim(), f.amount, f.date); flash("Entry saved."); render(); },
  transfer(f) { store.transfer(f.from, f.to, f.amount, f.description.trim(), f.date); flash("Transfer saved."); render(); },
  shop(f) {
    if (!f.shop_name.trim()) throw new Error("Shop name is required.");
    ["shop_name", "shop_address", "shop_phone", "receipt_footer"].forEach(k => { DB.settings[k] = f[k].trim(); });
    save(); flash("Shop details saved."); render();
  },
  async password(f) {
    if (await sha256(f.old) !== DB.settings.pass_hash) throw new Error("Current password is wrong.");
    if (f.new !== f.new2) throw new Error("The new passwords do not match.");
    if (f.new.length < 6) throw new Error("Password must be at least 6 characters.");
    DB.settings.pass_hash = await sha256(f.new); save();
    if (localStorage.getItem("remember")) localStorage.setItem("remember", DB.settings.pass_hash);
    flash("Password changed."); render();
  },
};

document.addEventListener("submit", async e => {
  const form = e.target.closest("form[data-form]");
  if (!form) return;
  e.preventDefault();
  const fd = Object.fromEntries(new FormData(form).entries());
  try { await formHandlers[form.dataset.form](fd, form); }
  catch (err) { flash(err.message || String(err), "error"); showToast(); }
});

const actions = {
  menu(el) { const n = document.getElementById("sidenav"); n.classList.toggle("open"); el.setAttribute("aria-expanded", n.classList.contains("open")); },
  logout() { sessionStorage.removeItem("unlocked"); localStorage.removeItem("remember"); render(); },
  print() { window.print(); },
  "del-product"(el) { if (confirm("Remove this product? Past sales are kept.")) { store.deleteProduct(el.dataset.id); flash("Product removed. Past sales are kept."); go("#/inventory"); } },
  "cancel-sale"(el) { if (confirm(`Cancel sale #${el.dataset.id}? Items go back to stock and the money is removed from the account.`)) { store.cancelSale(el.dataset.id); flash(`Sale #${el.dataset.id} cancelled. Items returned to stock.`); go("#/sales"); } },
  "del-expense"(el) { if (confirm("Delete this expense?")) { store.deleteExpense(el.dataset.id); flash("Expense deleted."); render(); } },
  "del-txn"(el) { if (confirm("Delete this entry?")) { store.deleteManual(el.dataset.id); flash("Entry deleted."); render(); } },
  "inv-csv"() { csv(`inventory_${today()}.csv`, ["Code", "Name", "Category", "Size", "Colour", "Cost", "Price", "Stock", "Stock Value"],
    store.listProducts().map(p => [p.code, p.name, p.category, p.size, p.color, p.cost_price, p.sale_price, p.quantity, r2(p.quantity * p.cost_price)])); },
  "sales-csv"() { csv(`sales_${today()}.csv`, ["Sale #", "Date", "Customer", "Phone", "Paid by", "Subtotal", "Discount", "Total", "Cost", "Profit"],
    store.listSales(view.salesStart, view.salesEnd, view.salesQ).map(s => [s.id, s.date, s.customer, s.phone, s.account, s.subtotal, s.discount, s.total, s.cost_total, r2(s.total - s.cost_total)])); },
  "rep-csv"() { csv(`profit_report_${today()}.csv`, ["Month", "Sales", "Items Sold", "Revenue", "Discounts", "Cost of Goods", "Gross Profit", "Expenses", "Net Profit", "Net Margin %", "Stock Bought"],
    store.lastNMonths(12).map(m => { const x = store.monthSummary(m); return [m, x.sales_count, x.units_sold, x.revenue, x.discounts, r2(x.cogs), r2(x.gross_profit), x.expenses, r2(x.net_profit), x.net_margin.toFixed(1), x.purchases]; })); },
  backup() {
    DB.settings.last_backup = today(); save();
    download(`boutique_backup_${today()}.json`, JSON.stringify(DB, null, 1), "application/json");
    flash("Backup downloaded. Keep the file somewhere safe."); render();
  },
  wipe() {
    if (prompt('This deletes ALL shop data from this browser. Type DELETE to confirm.') === "DELETE") {
      localStorage.removeItem(KEY); localStorage.removeItem("remember"); sessionStorage.clear(); DB = emptyDB(); go("#/");
    }
  },
};

document.addEventListener("click", e => {
  const add = e.target.closest("[data-add]"); if (add) return addToCart(+add.dataset.add);
  const rm = e.target.closest("[data-rm]"); if (rm) { view.cart.splice(+rm.dataset.rm, 1); document.getElementById("cart").innerHTML = cartHtml(); return updateTotals(); }
  const mo = e.target.closest("[data-month]"); if (mo) { e.preventDefault(); view.repMonth = mo.dataset.month; return render(); }
  const act = e.target.closest("[data-act]");
  if (act) { try { actions[act.dataset.act](act); } catch (err) { flash(err.message, "error"); showToast(); } }
  if (e.target.closest("nav.side a")) document.getElementById("sidenav")?.classList.remove("open");
});
document.addEventListener("keydown", e => {
  const add = e.target.closest && e.target.closest("[data-add]");
  if (add && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); addToCart(+add.dataset.add); }
});
document.addEventListener("input", e => {
  const k = e.target.dataset.input;
  if (k === "posQ") { view.posQ = e.target.value; document.getElementById("plist").innerHTML = posList(); }
  else if (k === "invQ") { view.invQ = e.target.value; document.getElementById("invtable").innerHTML = inventoryTable(store.listProducts(view.invQ, view.invCat, view.invLow)); }
  else if (k === "discount") updateTotals();
});
document.addEventListener("change", e => {
  const t = e.target;
  if (t.dataset.change) { view[t.dataset.change] = t.type === "checkbox" ? t.checked : t.value; return render(); }
  if (t.dataset.cart !== undefined) {
    const c = view.cart[+t.dataset.cart], f = t.dataset.f;
    let v = Number(t.value.replace(/,/g, ""));
    if (f === "qty") { v = Math.max(1, Math.floor(v || 1)); if (v > c.stock) { alert(`Only ${c.stock} in stock.`); v = c.stock; } }
    else v = Math.max(0, v || 0);
    c[f] = v; document.getElementById("cart").innerHTML = cartHtml(); updateTotals();
  }
  if (t.matches("[data-restore]") && t.files[0]) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const d = JSON.parse(reader.result);
        if (d.version !== 1 || !Array.isArray(d.products) || !d.settings) throw new Error();
        if (DB.settings.pass_hash && !confirm("Replace ALL data on this device with the backup?")) return;
        DB = d; save(); sessionStorage.removeItem("unlocked"); localStorage.removeItem("remember");
        flash("Backup restored. Log in with the password from the backup."); go("#/");
      } catch (err) { flash("That file is not a valid backup.", "error"); showToast(); }
    };
    reader.readAsText(t.files[0]);
  }
});

render();
