"""
Boutique ERP - web app for a women's clothing business.

Inventory, point-of-sale with receipts, sales history & returns, monthly
expenses, accounts (Cash / Bank / JazzCash / Easypaisa / Card) and
profit & revenue reports. Works in any browser, on phone or computer,
with password login.

Run locally:   pip install -r requirements.txt
               python app.py          -> open http://127.0.0.1:5000
"""

import csv
import io
import json
import os
import secrets
import tempfile
from datetime import datetime, timedelta
from functools import wraps
from urllib.parse import quote

from flask import (Flask, abort, flash, g, redirect, render_template, request,
                   send_file, session, url_for, Response)

from store_db import (StoreDB, ACCOUNTS, CATEGORIES, EXPENSE_CATEGORIES, SIZES,
                      BASE_DIR, month_key, today)

# ------------------------------------------------------------------- config
app = Flask(__name__)


def _secret_key():
    key = os.environ.get("SECRET_KEY")
    if key:
        return key
    path = os.path.join(BASE_DIR, "data", "secret_key.txt")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if not os.path.exists(path):
        with open(path, "w") as fh:
            fh.write(secrets.token_hex(32))
    with open(path) as fh:
        return fh.read().strip()


app.config.update(
    SECRET_KEY=_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    # Set HTTPS_ONLY=1 on the server (PythonAnywhere / Render) so the login
    # cookie is only ever sent over an encrypted connection.
    SESSION_COOKIE_SECURE=os.environ.get("HTTPS_ONLY") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
)


def db():
    if "db" not in g:
        g.db = StoreDB()
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    d = g.pop("db", None)
    if d is not None:
        d.close()


# ------------------------------------------------------------------ helpers
@app.template_filter("money")
def money(x):
    x = float(x or 0)
    return f"{'-' if x < 0 else ''}Rs {abs(x):,.0f}"


@app.template_filter("monthname")
def month_label(m):
    try:
        return datetime.strptime(m, "%Y-%m").strftime("%B %Y")
    except (ValueError, TypeError):
        return m


@app.template_filter("shortmonth")
def short_month(m):
    try:
        return datetime.strptime(m, "%Y-%m").strftime("%b")
    except (ValueError, TypeError):
        return m


def num(value, name="Value", integer=False):
    try:
        v = float(str(value or "0").replace(",", "").strip() or 0)
    except ValueError:
        raise ValueError(f"{name} must be a number.")
    return int(v) if integer else v


def valid_date(s):
    try:
        datetime.strptime((s or "").strip(), "%Y-%m-%d")
        return s.strip()
    except ValueError:
        raise ValueError("Date must be in the form YYYY-MM-DD, e.g. 2026-11-18.")


def valid_month(s):
    try:
        datetime.strptime((s or "").strip(), "%Y-%m")
        return s.strip()
    except ValueError:
        return month_key()


def current_user():
    uid = session.get("uid")
    return db().get_user(uid) if uid else None


def login_required(f):
    @wraps(f)
    def wrapper(*a, **k):
        if not current_user():
            return redirect(url_for("login", next=request.path))
        return f(*a, **k)
    return wrapper


def owner_required(f):
    @wraps(f)
    @login_required
    def wrapper(*a, **k):
        if current_user()["role"] != "owner":
            flash("Only the owner can open that page.", "error")
            return redirect(url_for("new_sale"))
        return f(*a, **k)
    return wrapper


def csv_response(filename, header, rows):
    buf = io.StringIO()
    buf.write("﻿")  # so Excel opens Urdu / special characters correctly
    w = csv.writer(buf)
    w.writerow(header)
    w.writerows(rows)
    return Response(buf.getvalue(), mimetype="text/csv",
                    headers={"Content-Disposition": f"attachment; filename={filename}"})


# ------------------------------------------------------------ CSRF + context
@app.before_request
def protect():
    if "csrf" not in session:
        session["csrf"] = secrets.token_hex(16)
    if request.method == "POST":
        if request.form.get("csrf") != session["csrf"]:
            abort(400, "Form expired. Go back, refresh the page and try again.")
    # First run: no users yet -> create the owner account.
    if request.endpoint not in ("setup", "static") and db().user_count() == 0:
        return redirect(url_for("setup"))


@app.context_processor
def inject():
    return {
        "user": current_user() if session.get("uid") else None,
        "csrf": session.get("csrf", ""),
        "shop_name": db().get_setting("shop_name", "Boutique ERP"),
        "ACCOUNTS": ACCOUNTS, "CATEGORIES": CATEGORIES, "SIZES": SIZES,
        "EXPENSE_CATEGORIES": EXPENSE_CATEGORIES, "today": today(),
    }


@app.after_request
def security_headers(resp):
    resp.headers["X-Frame-Options"] = "DENY"
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "same-origin"
    return resp


# ===================================================================== AUTH
@app.route("/setup", methods=["GET", "POST"])
def setup():
    if db().user_count() > 0:
        return redirect(url_for("login"))
    if request.method == "POST":
        f = request.form
        try:
            if f["password"] != f["password2"]:
                raise ValueError("The two passwords do not match.")
            uid = db().create_user(f["username"], f["password"], f.get("full_name", ""), "owner")
            for k in ("shop_name", "shop_address", "shop_phone"):
                db().set_setting(k, f.get(k, "").strip())
            db().set_setting("receipt_footer", "Thank you for shopping with us!")
        except ValueError as e:
            flash(str(e), "error")
            return render_template("setup.html", form=f)
        session.clear()
        session["uid"] = uid
        session.permanent = True
        flash("Welcome! Start by entering opening balances in Accounts and adding products.", "ok")
        return redirect(url_for("dashboard"))
    return render_template("setup.html", form={})


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        u = db().check_login(request.form.get("username", ""), request.form.get("password", ""))
        if u:
            csrf = session.get("csrf")
            session.clear()
            session["uid"] = u["id"]
            session["csrf"] = csrf or secrets.token_hex(16)
            session.permanent = bool(request.form.get("remember"))
            nxt = request.args.get("next", "")
            if not nxt.startswith("/") or nxt.startswith("//"):
                nxt = url_for("dashboard") if u["role"] == "owner" else url_for("new_sale")
            return redirect(nxt)
        flash("Wrong username or password.", "error")
    return render_template("login.html")


@app.route("/logout", methods=["POST"])
def logout():
    session.clear()
    return redirect(url_for("login"))


# ================================================================ DASHBOARD
@app.route("/")
@login_required
def dashboard():
    if current_user()["role"] != "owner":
        return redirect(url_for("new_sale"))
    d = db()
    months = d.last_n_months(6)
    hist = [d.month_summary(m) for m in months]
    peak = max([1] + [max(h["revenue"], h["expenses"], abs(h["net_profit"])) for h in hist])
    return render_template(
        "dashboard.html", day=d.day_summary(), ms=d.month_summary(month_key()),
        sv=d.stock_value(), bal=d.account_balances(), hist=hist, peak=peak,
        low=d.list_products(low_stock_only=True), recent=d.list_sales()[:8])


# ================================================================ INVENTORY
@app.route("/inventory")
@login_required
def inventory():
    q, cat = request.args.get("q", "").strip(), request.args.get("cat", "All")
    low = request.args.get("low") == "1"
    return render_template("inventory.html", products=db().list_products(q, cat, low),
                           sv=db().stock_value(), q=q, cat=cat, low=low)


def product_from_form(f):
    return dict(
        name=f.get("name", "").strip(), category=f.get("category", ""),
        size=f.get("size", ""), color=f.get("color", "").strip(),
        cost_price=num(f.get("cost_price"), "Cost price"),
        sale_price=num(f.get("sale_price"), "Sale price"),
        reorder_level=num(f.get("reorder_level", 3), "Reorder level", True))


@app.route("/inventory/new", methods=["GET", "POST"])
@owner_required
def product_new():
    if request.method == "POST":
        f = request.form
        try:
            p = product_from_form(f)
            pid = db().add_product(
                p["name"], p["category"], p["size"], p["color"], p["cost_price"],
                p["sale_price"], num(f.get("quantity"), "Quantity", True), p["reorder_level"],
                f.get("code", ""), f.get("supplier", "").strip(), f.get("account", "Cash"),
                record_purchase=bool(f.get("record_purchase")))
        except ValueError as e:
            flash(str(e), "error")
            return render_template("product_form.html", p=f, new=True)
        except Exception:
            flash("That product code is already used. Choose another or leave it blank.", "error")
            return render_template("product_form.html", p=f, new=True)
        flash(f"Added '{p['name']}'.", "ok")
        return redirect(url_for("product", pid=pid))
    return render_template("product_form.html", p={"reorder_level": 3, "quantity": 0,
                                                   "record_purchase": "1"}, new=True)


@app.route("/inventory/<int:pid>")
@login_required
def product(pid):
    p = db().get_product(pid)
    if not p or not p["active"]:
        abort(404)
    return render_template("product.html", p=p, purchases=db().purchases_for(pid))


@app.route("/inventory/<int:pid>/edit", methods=["GET", "POST"])
@owner_required
def product_edit(pid):
    p = db().get_product(pid)
    if not p:
        abort(404)
    if request.method == "POST":
        try:
            fields = product_from_form(request.form)
            if not fields["name"]:
                raise ValueError("Product name is required.")
            fields["code"] = request.form.get("code", "").strip() or p["code"]
            db().update_product(pid, **fields)
        except ValueError as e:
            flash(str(e), "error")
            return render_template("product_form.html", p=request.form, new=False, pid=pid)
        except Exception:
            flash("That product code is already used.", "error")
            return render_template("product_form.html", p=request.form, new=False, pid=pid)
        flash("Product updated.", "ok")
        return redirect(url_for("product", pid=pid))
    return render_template("product_form.html", p=dict(p), new=False, pid=pid)


@app.route("/inventory/<int:pid>/restock", methods=["POST"])
@owner_required
def product_restock(pid):
    f = request.form
    try:
        db().restock(pid, num(f.get("qty"), "Quantity", True), num(f.get("unit_cost"), "Cost"),
                     f.get("supplier", "").strip(), f.get("account", "Cash"), valid_date(f.get("date")))
        flash("Stock added and payment recorded.", "ok")
    except ValueError as e:
        flash(str(e), "error")
    return redirect(url_for("product", pid=pid))


@app.route("/inventory/<int:pid>/adjust", methods=["POST"])
@owner_required
def product_adjust(pid):
    try:
        db().adjust_stock(pid, num(request.form.get("qty"), "Quantity", True))
        flash("Stock count corrected.", "ok")
    except ValueError as e:
        flash(str(e), "error")
    return redirect(url_for("product", pid=pid))


@app.route("/inventory/<int:pid>/delete", methods=["POST"])
@owner_required
def product_delete(pid):
    db().delete_product(pid)
    flash("Product removed. Past sales are kept.", "ok")
    return redirect(url_for("inventory"))


@app.route("/inventory/export.csv")
@owner_required
def inventory_csv():
    rows = [[p["code"], p["name"], p["category"], p["size"], p["color"], p["cost_price"],
             p["sale_price"], p["quantity"], p["quantity"] * p["cost_price"]]
            for p in db().list_products()]
    return csv_response(f"inventory_{today()}.csv",
                        ["Code", "Name", "Category", "Size", "Colour", "Cost", "Price",
                         "Stock", "Stock Value"], rows)


# ===================================================================== SALE
@app.route("/sale", methods=["GET", "POST"])
@login_required
def new_sale():
    if request.method == "POST":
        f = request.form
        try:
            items = json.loads(f.get("cart") or "[]")
            sid = db().record_sale(
                [{"product_id": int(i["id"]), "qty": int(i["qty"]),
                  "unit_price": float(i["price"])} for i in items],
                customer=f.get("customer", "").strip(), phone=f.get("phone", "").strip(),
                account=f.get("account", "Cash"), discount=num(f.get("discount"), "Discount"),
                d=valid_date(f.get("date") or today()), sold_by=current_user()["username"])
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
            flash(str(e) or "Could not save the sale.", "error")
            return redirect(url_for("new_sale"))
        flash(f"Sale #{sid} saved.", "ok")
        return redirect(url_for("receipt", sid=sid))
    products = [{"id": p["id"], "code": p["code"], "name": p["name"], "cat": p["category"],
                 "size": p["size"], "color": p["color"], "price": p["sale_price"],
                 "stock": p["quantity"]} for p in db().list_products() if p["quantity"] > 0]
    return render_template("sale.html", products=products)


@app.route("/sales")
@login_required
def sales():
    start = request.args.get("start") or month_key() + "-01"
    end = request.args.get("end") or today()
    q = request.args.get("q", "").strip()
    try:
        valid_date(start), valid_date(end)
    except ValueError as e:
        flash(str(e), "error")
        start, end = month_key() + "-01", today()
    rows = db().list_sales(start, end, q)
    return render_template("sales.html", rows=rows, start=start, end=end, q=q,
                           total=sum(r["total"] for r in rows),
                           profit=sum(r["total"] - r["cost_total"] for r in rows))


@app.route("/sales/<int:sid>")
@login_required
def receipt(sid):
    s = db().get_sale(sid)
    if not s:
        abort(404)
    items = db().sale_items(sid)
    shop = db().get_setting("shop_name", "Boutique")
    text = [f"*{shop}*", f"Receipt #{sid} - {s['date']}"]
    text += [f"{i['name']} x{i['qty']} = Rs {i['qty'] * i['unit_price']:,.0f}" for i in items]
    if s["discount"]:
        text.append(f"Discount: Rs {s['discount']:,.0f}")
    text += [f"*Total: Rs {s['total']:,.0f}*", db().get_setting("receipt_footer", "Thank you!")]
    phone = "".join(ch for ch in (s["phone"] or "") if ch.isdigit())
    if phone.startswith("0"):
        phone = "92" + phone[1:]          # 0300... -> 92300... for WhatsApp
    wa = f"https://wa.me/{phone}?text={quote(chr(10).join(text))}"
    return render_template("receipt.html", s=s, items=items, wa=wa,
                           address=db().get_setting("shop_address"),
                           phone=db().get_setting("shop_phone"),
                           footer=db().get_setting("receipt_footer", "Thank you!"))


@app.route("/sales/<int:sid>/cancel", methods=["POST"])
@owner_required
def sale_cancel(sid):
    try:
        db().cancel_sale(sid)
        flash(f"Sale #{sid} cancelled. Items returned to stock.", "ok")
    except ValueError as e:
        flash(str(e), "error")
    return redirect(url_for("sales"))


@app.route("/sales/export.csv")
@owner_required
def sales_csv():
    rows = [[s["id"], s["date"], s["customer"], s["phone"], s["account"], s["subtotal"],
             s["discount"], s["total"], s["cost_total"], s["total"] - s["cost_total"], s["sold_by"]]
            for s in db().list_sales(request.args.get("start"), request.args.get("end"),
                                     request.args.get("q", ""))]
    return csv_response(f"sales_{today()}.csv",
                        ["Sale #", "Date", "Customer", "Phone", "Paid by", "Subtotal",
                         "Discount", "Total", "Cost", "Profit", "Sold by"], rows)


# ================================================================= EXPENSES
@app.route("/expenses", methods=["GET", "POST"])
@owner_required
def expenses():
    if request.method == "POST":
        f = request.form
        try:
            d = valid_date(f.get("date"))
            db().add_expense(f.get("category") or "Other", f.get("description", "").strip(),
                             num(f.get("amount"), "Amount"), f.get("account", "Cash"), d)
            flash("Expense added.", "ok")
            return redirect(url_for("expenses", month=d[:7]))
        except ValueError as e:
            flash(str(e), "error")
    m = valid_month(request.args.get("month"))
    rows = db().list_expenses(m)
    return render_template("expenses.html", rows=rows, month=m, months=db().months_with_data(),
                           bycat=db().expenses_by_category(m), total=sum(r["amount"] for r in rows))


@app.route("/expenses/<int:eid>/delete", methods=["POST"])
@owner_required
def expense_delete(eid):
    db().delete_expense(eid)
    flash("Expense deleted.", "ok")
    return redirect(request.referrer or url_for("expenses"))


# ================================================================= ACCOUNTS
@app.route("/accounts")
@owner_required
def accounts():
    acc = request.args.get("account", "All")
    if acc not in ACCOUNTS:
        acc = "All"
    m = valid_month(request.args.get("month"))
    start, rows = db().ledger(acc, m)
    tin = sum(r["amount"] for r, _ in rows if r["amount"] > 0)
    tout = -sum(r["amount"] for r, _ in rows if r["amount"] < 0)
    return render_template("accounts.html", bal=db().account_balances(), rows=rows, start=start,
                           acc=acc, month=m, months=db().months_with_data(), tin=tin, tout=tout)


@app.route("/accounts/entry", methods=["POST"])
@owner_required
def account_entry():
    f = request.form
    try:
        kind = f.get("kind")
        if kind not in ("Opening", "Deposit", "Withdrawal"):
            raise ValueError("Unknown entry type.")
        db().manual_entry(f.get("account", "Cash"), kind, f.get("description", "").strip(),
                          num(f.get("amount"), "Amount"), valid_date(f.get("date")))
        flash("Entry saved.", "ok")
    except ValueError as e:
        flash(str(e), "error")
    return redirect(url_for("accounts"))


@app.route("/accounts/transfer", methods=["POST"])
@owner_required
def account_transfer():
    f = request.form
    try:
        db().transfer(f.get("from"), f.get("to"), num(f.get("amount"), "Amount"),
                      f.get("description", "").strip(), valid_date(f.get("date")))
        flash("Transfer saved.", "ok")
    except ValueError as e:
        flash(str(e), "error")
    return redirect(url_for("accounts"))


@app.route("/accounts/<int:tid>/delete", methods=["POST"])
@owner_required
def account_delete(tid):
    try:
        db().delete_manual_txn(tid)
        flash("Entry deleted.", "ok")
    except ValueError as e:
        flash(str(e), "error")
    return redirect(request.referrer or url_for("accounts"))


# ================================================================== REPORTS
@app.route("/reports")
@owner_required
def reports():
    m = valid_month(request.args.get("month"))
    year = [db().month_summary(x) for x in db().last_n_months(12)]
    return render_template("reports.html", month=m, months=db().months_with_data(),
                           s=db().month_summary(m), expcat=db().expenses_by_category(m),
                           best=db().best_sellers(m), bycat=db().sales_by_category(m),
                           year=list(reversed(year)))


@app.route("/reports/export.csv")
@owner_required
def reports_csv():
    rows = []
    for m in db().last_n_months(12):
        x = db().month_summary(m)
        rows.append([m, x["sales_count"], x["units_sold"], x["revenue"], x["discounts"],
                     x["cogs"], x["gross_profit"], x["expenses"], x["net_profit"],
                     round(x["net_margin"], 1), x["purchases"]])
    return csv_response(f"profit_report_{today()}.csv",
                        ["Month", "Sales", "Items Sold", "Revenue", "Discounts", "Cost of Goods",
                         "Gross Profit", "Expenses", "Net Profit", "Net Margin %",
                         "Stock Bought"], rows)


# ================================================================= SETTINGS
@app.route("/settings", methods=["GET", "POST"])
@login_required
def settings():
    me = current_user()
    if request.method == "POST":
        action = request.form.get("action")
        f = request.form
        try:
            if action == "password":
                if not db().check_login(me["username"], f.get("old", "")):
                    raise ValueError("Current password is wrong.")
                if f.get("new") != f.get("new2"):
                    raise ValueError("The new passwords do not match.")
                db().set_password(me["id"], f.get("new", ""))
                flash("Password changed.", "ok")
            elif me["role"] != "owner":
                abort(403)
            elif action == "shop":
                for k in ("shop_name", "shop_address", "shop_phone", "receipt_footer"):
                    db().set_setting(k, f.get(k, "").strip())
                flash("Shop details saved.", "ok")
            elif action == "add_user":
                db().create_user(f.get("username", ""), f.get("password", ""),
                                 f.get("full_name", ""), f.get("role", "staff"))
                flash("User added.", "ok")
            elif action == "delete_user":
                uid = int(f.get("uid", 0))
                if uid == me["id"]:
                    raise ValueError("You cannot delete your own account while logged in.")
                db().delete_user(uid)
                flash("User deleted.", "ok")
            elif action == "reset_password":
                db().set_password(int(f.get("uid", 0)), f.get("password", ""))
                flash("Password reset.", "ok")
        except ValueError as e:
            flash(str(e), "error")
        return redirect(url_for("settings"))
    keys = ("shop_name", "shop_address", "shop_phone", "receipt_footer")
    return render_template("settings.html", shop={k: db().get_setting(k) for k in keys},
                           users=db().list_users() if me["role"] == "owner" else [])


@app.route("/settings/backup")
@owner_required
def backup():
    tmp = os.path.join(tempfile.gettempdir(), f"boutique_backup_{today()}.db")
    db().backup(tmp)
    return send_file(tmp, as_attachment=True, download_name=f"boutique_backup_{today()}.db")


@app.errorhandler(404)
def not_found(_e):
    return render_template("message.html", title="Not found",
                           text="That page or record does not exist."), 404


if __name__ == "__main__":
    # host="0.0.0.0" lets phones on the same Wi-Fi open it via this computer's IP address.
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5000)),
            debug=os.environ.get("DEBUG") == "1")
