"""
store_db.py - Database and business logic for the Boutique ERP web app.

All data is kept in a single SQLite file (data/boutique.db by default,
or the path in the BOUTIQUE_DB environment variable).
"""

import sqlite3
import os
from datetime import date, datetime
from werkzeug.security import generate_password_hash, check_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DB_FILE = os.environ.get("BOUTIQUE_DB", os.path.join(BASE_DIR, "data", "boutique.db"))

CATEGORIES = ["Lawn", "Kurti", "Shalwar Kameez", "3-Piece Suit", "Formal / Bridal",
              "Dupatta", "Trousers", "Abaya", "Western", "Accessories", "Other"]
SIZES = ["XS", "S", "M", "L", "XL", "XXL", "Unstitched", "Free Size"]
ACCOUNTS = ["Cash", "Bank", "JazzCash", "Easypaisa", "Card"]
EXPENSE_CATEGORIES = ["Rent", "Salaries", "Electricity", "Gas", "Water", "Internet / Phone",
                      "Tailoring / Stitching", "Transport / Delivery", "Packaging",
                      "Marketing", "Maintenance", "Taxes / Fees", "Other"]


def today():
    return date.today().isoformat()


def month_key(d=None):
    """Return 'YYYY-MM' for a date string or today."""
    return (d or today())[:7]


class StoreDB:
    def __init__(self, path=None):
        self.path = path or DB_FILE
        os.makedirs(os.path.dirname(os.path.abspath(self.path)), exist_ok=True)
        self.conn = sqlite3.connect(self.path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._create_tables()

    # ------------------------------------------------------------------ setup
    def _create_tables(self):
        c = self.conn
        c.executescript("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL COLLATE NOCASE,
            full_name TEXT,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL DEFAULT 'staff',   -- owner | staff
            created TEXT);

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT);

        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            code TEXT UNIQUE,
            name TEXT NOT NULL,
            category TEXT,
            size TEXT,
            color TEXT,
            cost_price REAL NOT NULL DEFAULT 0,
            sale_price REAL NOT NULL DEFAULT 0,
            quantity INTEGER NOT NULL DEFAULT 0,
            reorder_level INTEGER NOT NULL DEFAULT 3,
            active INTEGER NOT NULL DEFAULT 1,
            created TEXT);

        CREATE TABLE IF NOT EXISTS sales (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            time TEXT,
            customer TEXT,
            phone TEXT,
            account TEXT NOT NULL DEFAULT 'Cash',
            subtotal REAL NOT NULL DEFAULT 0,
            discount REAL NOT NULL DEFAULT 0,
            total REAL NOT NULL DEFAULT 0,
            cost_total REAL NOT NULL DEFAULT 0,
            note TEXT,
            sold_by TEXT);

        CREATE TABLE IF NOT EXISTS sale_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sale_id INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
            product_id INTEGER,
            name TEXT,
            qty INTEGER NOT NULL,
            unit_price REAL NOT NULL,
            unit_cost REAL NOT NULL);

        CREATE TABLE IF NOT EXISTS purchases (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            product_id INTEGER,
            name TEXT,
            qty INTEGER NOT NULL,
            unit_cost REAL NOT NULL,
            total REAL NOT NULL,
            supplier TEXT,
            account TEXT NOT NULL DEFAULT 'Cash');

        CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            category TEXT NOT NULL,
            description TEXT,
            amount REAL NOT NULL,
            account TEXT NOT NULL DEFAULT 'Cash');

        CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            account TEXT NOT NULL,
            kind TEXT NOT NULL,          -- Sale, Purchase, Expense, Deposit, Withdrawal, Transfer, Opening
            description TEXT,
            amount REAL NOT NULL,        -- positive = money in, negative = money out
            ref_table TEXT,
            ref_id INTEGER);
        """)
        c.commit()

    def close(self):
        self.conn.close()

    def backup(self, dest_path):
        """Consistent copy of the live database (safe while the app is running)."""
        self.conn.commit()
        dest = sqlite3.connect(dest_path)
        with dest:
            self.conn.backup(dest)
        dest.close()

    # ------------------------------------------------------------------ users
    def user_count(self):
        return self.conn.execute("SELECT COUNT(*) AS n FROM users").fetchone()["n"]

    def create_user(self, username, password, full_name="", role="staff"):
        username = username.strip()
        if not username or len(username) < 3:
            raise ValueError("Username must be at least 3 characters.")
        if len(password) < 6:
            raise ValueError("Password must be at least 6 characters.")
        if role not in ("owner", "staff"):
            raise ValueError("Unknown role.")
        try:
            cur = self.conn.execute(
                "INSERT INTO users(username,full_name,password_hash,role,created) VALUES (?,?,?,?,?)",
                (username, full_name.strip(), generate_password_hash(password), role, today()))
        except sqlite3.IntegrityError:
            raise ValueError("That username is already taken.")
        self.conn.commit()
        return cur.lastrowid

    def check_login(self, username, password):
        u = self.conn.execute("SELECT * FROM users WHERE username=?", (username.strip(),)).fetchone()
        if u and check_password_hash(u["password_hash"], password):
            return u
        return None

    def get_user(self, uid):
        return self.conn.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()

    def list_users(self):
        return self.conn.execute("SELECT * FROM users ORDER BY role, username").fetchall()

    def set_password(self, uid, password):
        if len(password) < 6:
            raise ValueError("Password must be at least 6 characters.")
        self.conn.execute("UPDATE users SET password_hash=? WHERE id=?",
                          (generate_password_hash(password), uid))
        self.conn.commit()

    def delete_user(self, uid):
        u = self.get_user(uid)
        if not u:
            return
        if u["role"] == "owner":
            n = self.conn.execute("SELECT COUNT(*) AS n FROM users WHERE role='owner'").fetchone()["n"]
            if n <= 1:
                raise ValueError("You cannot delete the only owner account.")
        self.conn.execute("DELETE FROM users WHERE id=?", (uid,))
        self.conn.commit()

    # --------------------------------------------------------------- settings
    def get_setting(self, key, default=""):
        r = self.conn.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return r["value"] if r else default

    def set_setting(self, key, value):
        self.conn.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?,?)", (key, str(value)))
        self.conn.commit()

    # -------------------------------------------------------------- products
    def _next_code(self):
        r = self.conn.execute("SELECT MAX(id) AS m FROM products").fetchone()
        return f"P{(r['m'] or 0) + 1:04d}"

    def add_product(self, name, category, size, color, cost_price, sale_price,
                    quantity=0, reorder_level=3, code=None, supplier="", account="Cash",
                    record_purchase=True):
        """Add a new product. Opening stock is recorded as a purchase (money out)
        unless record_purchase is False (e.g. stock already owned)."""
        name = name.strip()
        if not name:
            raise ValueError("Product name is required.")
        cost_price, sale_price = float(cost_price), float(sale_price)
        quantity, reorder_level = int(quantity), int(reorder_level)
        if cost_price < 0 or sale_price < 0 or quantity < 0:
            raise ValueError("Prices and quantity cannot be negative.")
        code = (code or "").strip() or self._next_code()
        cur = self.conn.execute(
            """INSERT INTO products(code,name,category,size,color,cost_price,sale_price,
               quantity,reorder_level,created) VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (code, name, category, size, color, cost_price, sale_price, 0, reorder_level, today()))
        pid = cur.lastrowid
        if quantity > 0:
            if record_purchase:
                self.restock(pid, quantity, cost_price, supplier, account, commit=False)
            else:
                self.conn.execute("UPDATE products SET quantity=? WHERE id=?", (quantity, pid))
        self.conn.commit()
        return pid

    def update_product(self, pid, **fields):
        allowed = {"code", "name", "category", "size", "color", "cost_price",
                   "sale_price", "reorder_level"}
        sets = {k: v for k, v in fields.items() if k in allowed}
        if not sets:
            return
        cols = ", ".join(f"{k}=?" for k in sets)
        self.conn.execute(f"UPDATE products SET {cols} WHERE id=?", (*sets.values(), pid))
        self.conn.commit()

    def adjust_stock(self, pid, new_qty):
        """Correct stock count (e.g. after physical count / damaged items). No money moves."""
        if int(new_qty) < 0:
            raise ValueError("Quantity cannot be negative.")
        self.conn.execute("UPDATE products SET quantity=? WHERE id=?", (int(new_qty), pid))
        self.conn.commit()

    def delete_product(self, pid):
        # Soft delete keeps old sales history intact.
        self.conn.execute("UPDATE products SET active=0 WHERE id=?", (pid,))
        self.conn.commit()

    def get_product(self, pid):
        return self.conn.execute("SELECT * FROM products WHERE id=?", (pid,)).fetchone()

    def list_products(self, search="", category="All", low_stock_only=False):
        q = "SELECT * FROM products WHERE active=1"
        args = []
        if search:
            q += " AND (name LIKE ? OR code LIKE ? OR color LIKE ?)"
            args += [f"%{search}%"] * 3
        if category and category != "All":
            q += " AND category=?"
            args.append(category)
        if low_stock_only:
            q += " AND quantity <= reorder_level"
        q += " ORDER BY name"
        return self.conn.execute(q, args).fetchall()

    def restock(self, pid, qty, unit_cost, supplier="", account="Cash", d=None, commit=True):
        """Buy more stock: increases quantity, updates cost price (weighted average),
        records a purchase and money going out of the chosen account."""
        qty, unit_cost = int(qty), float(unit_cost)
        if qty <= 0:
            raise ValueError("Quantity must be more than zero.")
        p = self.get_product(pid)
        old_q, old_c = p["quantity"], p["cost_price"]
        new_q = old_q + qty
        avg_cost = ((old_q * old_c) + (qty * unit_cost)) / new_q if new_q else unit_cost
        self.conn.execute("UPDATE products SET quantity=?, cost_price=? WHERE id=?",
                          (new_q, round(avg_cost, 2), pid))
        d = d or today()
        total = qty * unit_cost
        cur = self.conn.execute(
            """INSERT INTO purchases(date,product_id,name,qty,unit_cost,total,supplier,account)
               VALUES (?,?,?,?,?,?,?,?)""",
            (d, pid, p["name"], qty, unit_cost, total, supplier, account))
        self._txn(d, account, "Purchase", f"Stock: {qty} x {p['name']}"
                  + (f" ({supplier})" if supplier else ""), -total, "purchases", cur.lastrowid)
        if commit:
            self.conn.commit()

    def purchases_for(self, pid):
        return self.conn.execute(
            "SELECT * FROM purchases WHERE product_id=? ORDER BY date DESC, id DESC", (pid,)).fetchall()

    def stock_value(self):
        r = self.conn.execute(
            """SELECT COALESCE(SUM(quantity*cost_price),0) AS cost,
                      COALESCE(SUM(quantity*sale_price),0) AS retail,
                      COALESCE(SUM(quantity),0) AS units
               FROM products WHERE active=1""").fetchone()
        return dict(r)

    # ----------------------------------------------------------------- sales
    def record_sale(self, items, customer="", phone="", account="Cash", discount=0.0,
                    note="", d=None, sold_by=""):
        """items: list of dicts {product_id, qty, unit_price}. Returns sale id."""
        if not items:
            raise ValueError("Add at least one item to the sale.")
        d = d or today()
        discount = float(discount or 0)
        subtotal = cost_total = 0.0
        rows = []
        for it in items:
            p = self.get_product(it["product_id"])
            qty = int(it["qty"])
            if qty <= 0:
                raise ValueError("Quantity must be more than zero.")
            if qty > p["quantity"]:
                raise ValueError(f"Only {p['quantity']} of '{p['name']}' in stock.")
            price = float(it.get("unit_price", p["sale_price"]))
            subtotal += qty * price
            cost_total += qty * p["cost_price"]
            rows.append((p, qty, price))
        if discount < 0 or discount > subtotal:
            raise ValueError("Discount must be between 0 and the subtotal.")
        total = subtotal - discount
        try:
            cur = self.conn.execute(
                """INSERT INTO sales(date,time,customer,phone,account,subtotal,discount,total,
                   cost_total,note,sold_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (d, datetime.now().strftime("%H:%M"), customer, phone, account,
                 subtotal, discount, total, cost_total, note, sold_by))
            sid = cur.lastrowid
            for p, qty, price in rows:
                self.conn.execute(
                    """INSERT INTO sale_items(sale_id,product_id,name,qty,unit_price,unit_cost)
                       VALUES (?,?,?,?,?,?)""", (sid, p["id"], p["name"], qty, price, p["cost_price"]))
                self.conn.execute("UPDATE products SET quantity=quantity-? WHERE id=?", (qty, p["id"]))
            self._txn(d, account, "Sale", f"Sale #{sid}" + (f" - {customer}" if customer else ""),
                      total, "sales", sid)
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise
        return sid

    def cancel_sale(self, sid):
        """Cancel/return a whole sale: stock goes back, money is reversed."""
        s = self.get_sale(sid)
        if not s:
            raise ValueError("Sale not found.")
        for it in self.sale_items(sid):
            if it["product_id"]:
                self.conn.execute("UPDATE products SET quantity=quantity+? WHERE id=?",
                                  (it["qty"], it["product_id"]))
        self.conn.execute("DELETE FROM transactions WHERE ref_table='sales' AND ref_id=?", (sid,))
        self.conn.execute("DELETE FROM sales WHERE id=?", (sid,))
        self.conn.commit()

    def get_sale(self, sid):
        return self.conn.execute("SELECT * FROM sales WHERE id=?", (sid,)).fetchone()

    def sale_items(self, sid):
        return self.conn.execute("SELECT * FROM sale_items WHERE sale_id=?", (sid,)).fetchall()

    def list_sales(self, start=None, end=None, search=""):
        q = "SELECT * FROM sales WHERE 1=1"
        args = []
        if start:
            q += " AND date>=?"; args.append(start)
        if end:
            q += " AND date<=?"; args.append(end)
        if search:
            q += " AND (customer LIKE ? OR phone LIKE ? OR CAST(id AS TEXT)=?)"
            args += [f"%{search}%", f"%{search}%", search]
        q += " ORDER BY date DESC, id DESC"
        return self.conn.execute(q, args).fetchall()

    # -------------------------------------------------------------- expenses
    def add_expense(self, category, description, amount, account="Cash", d=None):
        amount = float(amount)
        if amount <= 0:
            raise ValueError("Amount must be more than zero.")
        d = d or today()
        cur = self.conn.execute(
            "INSERT INTO expenses(date,category,description,amount,account) VALUES (?,?,?,?,?)",
            (d, category, description, amount, account))
        self._txn(d, account, "Expense", f"{category}" + (f": {description}" if description else ""),
                  -amount, "expenses", cur.lastrowid)
        self.conn.commit()
        return cur.lastrowid

    def delete_expense(self, eid):
        self.conn.execute("DELETE FROM transactions WHERE ref_table='expenses' AND ref_id=?", (eid,))
        self.conn.execute("DELETE FROM expenses WHERE id=?", (eid,))
        self.conn.commit()

    def list_expenses(self, month=None):
        if month:
            return self.conn.execute(
                "SELECT * FROM expenses WHERE substr(date,1,7)=? ORDER BY date DESC, id DESC",
                (month,)).fetchall()
        return self.conn.execute("SELECT * FROM expenses ORDER BY date DESC, id DESC").fetchall()

    def expenses_by_category(self, month):
        return self.conn.execute(
            """SELECT category, SUM(amount) AS total FROM expenses
               WHERE substr(date,1,7)=? GROUP BY category ORDER BY total DESC""",
            (month,)).fetchall()

    # -------------------------------------------------------------- accounts
    def _txn(self, d, account, kind, description, amount, ref_table=None, ref_id=None):
        self.conn.execute(
            """INSERT INTO transactions(date,account,kind,description,amount,ref_table,ref_id)
               VALUES (?,?,?,?,?,?,?)""", (d, account, kind, description, amount, ref_table, ref_id))

    def manual_entry(self, account, kind, description, amount, d=None):
        """Owner deposit (capital in), withdrawal (owner takes money out), or opening balance."""
        amount = abs(float(amount))
        if amount == 0:
            raise ValueError("Amount must be more than zero.")
        sign = -1 if kind == "Withdrawal" else 1
        self._txn(d or today(), account, kind, description, sign * amount, "manual", None)
        self.conn.commit()

    def transfer(self, from_acc, to_acc, amount, description="", d=None):
        amount = float(amount)
        if amount <= 0 or from_acc == to_acc:
            raise ValueError("Enter a positive amount and two different accounts.")
        d = d or today()
        desc = description or f"{from_acc} → {to_acc}"
        self._txn(d, from_acc, "Transfer", desc, -amount, "manual", None)
        self._txn(d, to_acc, "Transfer", desc, amount, "manual", None)
        self.conn.commit()

    def delete_manual_txn(self, tid):
        r = self.conn.execute("SELECT ref_table FROM transactions WHERE id=?", (tid,)).fetchone()
        if not r or r["ref_table"] != "manual":
            raise ValueError("Only manual entries can be deleted here. "
                             "Delete sales/expenses from their own tabs.")
        self.conn.execute("DELETE FROM transactions WHERE id=?", (tid,))
        self.conn.commit()

    def account_balances(self):
        rows = self.conn.execute(
            "SELECT account, SUM(amount) AS bal FROM transactions GROUP BY account").fetchall()
        bal = {a: 0.0 for a in ACCOUNTS}
        for r in rows:
            bal[r["account"]] = r["bal"]
        return bal

    def ledger(self, account="All", month=None):
        q = "SELECT * FROM transactions WHERE 1=1"
        args = []
        if account != "All":
            q += " AND account=?"; args.append(account)
        if month:
            q += " AND substr(date,1,7)=?"; args.append(month)
        q += " ORDER BY date, id"
        rows = self.conn.execute(q, args).fetchall()
        # Running balance (starting from balance before the month)
        start_bal = 0.0
        if month:
            q2 = "SELECT COALESCE(SUM(amount),0) AS b FROM transactions WHERE substr(date,1,7)<?"
            a2 = [month]
            if account != "All":
                q2 += " AND account=?"; a2.append(account)
            start_bal = self.conn.execute(q2, a2).fetchone()["b"]
        out, bal = [], start_bal
        for r in rows:
            bal += r["amount"]
            out.append((r, bal))
        return start_bal, out

    # --------------------------------------------------------------- reports
    def month_summary(self, month):
        s = self.conn.execute(
            """SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS revenue,
                      COALESCE(SUM(cost_total),0) AS cogs, COALESCE(SUM(discount),0) AS disc
               FROM sales WHERE substr(date,1,7)=?""", (month,)).fetchone()
        e = self.conn.execute(
            "SELECT COALESCE(SUM(amount),0) AS exp FROM expenses WHERE substr(date,1,7)=?",
            (month,)).fetchone()
        p = self.conn.execute(
            "SELECT COALESCE(SUM(total),0) AS pur FROM purchases WHERE substr(date,1,7)=?",
            (month,)).fetchone()
        units = self.conn.execute(
            """SELECT COALESCE(SUM(qty),0) AS u FROM sale_items si JOIN sales s ON s.id=si.sale_id
               WHERE substr(s.date,1,7)=?""", (month,)).fetchone()["u"]
        revenue, cogs, exp = s["revenue"], s["cogs"], e["exp"]
        gross = revenue - cogs
        net = gross - exp
        return {
            "month": month, "sales_count": s["n"], "units_sold": units,
            "revenue": revenue, "discounts": s["disc"], "cogs": cogs,
            "gross_profit": gross, "expenses": exp, "net_profit": net,
            "purchases": p["pur"],
            "gross_margin": (gross / revenue * 100) if revenue else 0.0,
            "net_margin": (net / revenue * 100) if revenue else 0.0,
        }

    def day_summary(self, d=None):
        d = d or today()
        r = self.conn.execute(
            """SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS revenue,
                      COALESCE(SUM(total-cost_total),0) AS gross
               FROM sales WHERE date=?""", (d,)).fetchone()
        return dict(r)

    def months_with_data(self):
        rows = self.conn.execute(
            """SELECT DISTINCT substr(date,1,7) AS m FROM (
                 SELECT date FROM sales UNION SELECT date FROM expenses
                 UNION SELECT date FROM purchases UNION SELECT date FROM transactions)
               ORDER BY m DESC""").fetchall()
        months = [r["m"] for r in rows]
        if month_key() not in months:
            months.insert(0, month_key())
        return months

    def last_n_months(self, n=12):
        y, m = map(int, month_key().split("-"))
        out = []
        for _ in range(n):
            out.append(f"{y:04d}-{m:02d}")
            m -= 1
            if m == 0:
                m, y = 12, y - 1
        return list(reversed(out))

    def best_sellers(self, month=None, limit=10):
        q = """SELECT si.name, SUM(si.qty) AS qty, SUM(si.qty*si.unit_price) AS revenue,
                      SUM(si.qty*(si.unit_price-si.unit_cost)) AS profit
               FROM sale_items si JOIN sales s ON s.id=si.sale_id"""
        args = []
        if month:
            q += " WHERE substr(s.date,1,7)=?"; args.append(month)
        q += " GROUP BY si.name ORDER BY qty DESC LIMIT ?"
        args.append(limit)
        return self.conn.execute(q, args).fetchall()

    def sales_by_category(self, month):
        return self.conn.execute(
            """SELECT COALESCE(p.category,'Other') AS category, SUM(si.qty) AS qty,
                      SUM(si.qty*si.unit_price) AS revenue
               FROM sale_items si JOIN sales s ON s.id=si.sale_id
               LEFT JOIN products p ON p.id=si.product_id
               WHERE substr(s.date,1,7)=? GROUP BY category ORDER BY revenue DESC""",
            (month,)).fetchall()

    def daily_sales(self, month):
        return self.conn.execute(
            """SELECT date, SUM(total) AS revenue, SUM(total-cost_total) AS gross
               FROM sales WHERE substr(date,1,7)=? GROUP BY date ORDER BY date""",
            (month,)).fetchall()
