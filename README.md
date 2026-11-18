# Boutique ERP — Women's Clothing Business Manager

A web app for running a women's clothing shop. You open it in any browser, on a phone, tablet or computer, and log in with a password.
It's built with **Python (Flask)**, **HTML/CSS** and **SQLite**.

| Section | What it does |
|---|---|
| **Dashboard** | Today's sales, this month's revenue / expenses / net profit, stock value, total money, low-stock alerts, 6-month chart |
| **New Sale** | Point of sale: tap products to build the bill, set discount and payment method, get a printable receipt or **send it on WhatsApp** |
| **Inventory** | Products with category, size, colour, cost & sale price, profit per item, stock level, restocking, stock-count corrections, purchase history |
| **Sales History** | Search by date, customer, phone or receipt number. Reprint receipts, cancel sales or take returns (stock goes back automatically) |
| **Expenses** | Monthly expenditure (rent, salaries, bills…) with totals by category |
| **Accounts** | Cash, Bank, JazzCash, Easypaisa and Card balances, a full ledger with running balance, owner deposits and withdrawals, transfers |
| **Reports** | Monthly Profit & Loss statement, best sellers, sales by category, 12-month summary, export to Excel (CSV) |
| **Settings** | Shop details for receipts, users (owner / staff), password change, data backup download |

**Users and roles**
- **Owner** sees everything.
- **Staff** (e.g. a salesperson) can make sales, view sales history and check stock. They **cannot** see cost prices, profit, expenses or accounts.

**Security:** passwords are stored hashed, every form is protected against cross-site request forgery, the session cookie is HTTPS-only when hosted, and shop data is never uploaded to GitHub (it's excluded by `.gitignore`).

---

## 🌐 Live app (GitHub Pages)

**https://ahmadkhichi123.github.io/enterprise-resource-planning/**

The `docs/` folder holds a **browser edition** that runs directly on GitHub Pages. It has the same screens and the same profit calculations as the Python version.
On a phone, open the link in Chrome and tap ⋮ → **Add to Home screen** to use it like an app.

**How the two editions differ**

| | Browser edition (`docs/`, GitHub Pages) | Python edition (`app.py`, Flask) |
|---|---|---|
| Runs on | GitHub Pages, nothing to install | PythonAnywhere or the shop computer |
| Where the data is kept | In the browser on each device. Move it between devices with **Settings → Backup / Restore** | One shared database. Phone and computer see the same data |
| Logins | One password per device | Separate owner and staff logins |

GitHub Pages can only host static web pages, so it cannot run the Python server. If the shop needs live, shared data across several devices, use the Python edition (Option A below).

**Turning on GitHub Pages (one-time):** in the repository go to **Settings → Pages**. Under *Build and deployment* choose **Deploy from a branch**, set branch **main** and folder **/docs**, then click **Save**. The link starts working about a minute later.

---

## How profit is calculated
- **Revenue** = sales after discounts
- **Gross profit** = revenue − cost price of the clothes sold
- **Net profit** = gross profit − expenses

Buying stock is not counted as a cost until the clothes are sold, so a month with a big restock won't look like a loss. The cash spent still shows in **Accounts**.
Restocking at a new price updates the cost price using a weighted average.

---

## Option A: Put it online with HTTPS (recommended, free)

Hosting it on **PythonAnywhere** gives you a secure link like `https://yourname.pythonanywhere.com` that works from anywhere.
It also keeps the data file permanently.

1. Create a free **Beginner** account at <https://www.pythonanywhere.com>. Your username becomes part of the web address.
2. Open **Consoles → Bash** and run:
   ```bash
   git clone https://github.com/AhmadKhichi123/enterprise-resource-planning.git
   pip install --user -r enterprise-resource-planning/requirements.txt
   ```
3. Go to the **Web** tab → **Add a new web app** → **Manual configuration** → pick the newest Python version.
4. On the Web tab, open the **WSGI configuration file** link. Replace everything in it with the code below, changing `YOURUSERNAME` to your username:
   ```python
   import os, sys
   path = "/home/YOURUSERNAME/enterprise-resource-planning"
   if path not in sys.path:
       sys.path.insert(0, path)
   os.environ["HTTPS_ONLY"] = "1"
   from app import app as application
   ```
5. Still on the Web tab:
   - **Static files**: URL `/static/`, Directory `/home/YOURUSERNAME/enterprise-resource-planning/static`
   - Turn **Force HTTPS** on
   - Click **Reload**
6. Open `https://YOURUSERNAME.pythonanywhere.com`. The first visit asks you to create the shop and the owner login.

**Notes**
- On a free account, log in to PythonAnywhere once every 3 months and click **"Run until 3 months from today"** on the Web tab. Otherwise the site is paused. Your data is kept.
- **To update** after new code is pushed to GitHub: in a Bash console run `cd enterprise-resource-planning && git pull`, then click **Reload** on the Web tab.
- **On a phone:** open the site in Chrome, tap ⋮ → **Add to Home screen**. It then opens like an app.

## Option B: Run it on the shop computer (works offline)

1. Install Python from <https://www.python.org/downloads/>. Tick **"Add python.exe to PATH"** during installation.
2. Download this repository (**Code → Download ZIP**) and unzip it.
3. Double-click **`run_windows.bat`**. The app opens at <http://127.0.0.1:5000>.
4. Phones on the same Wi-Fi can open `http://<computer's IP>:5000`. Find the IP by typing `ipconfig` in Command Prompt.

## Getting started
1. **Accounts → Add money in / out → Opening balance**: enter the money already in Cash, Bank, JazzCash and so on.
2. **Inventory → + Add Product**: add each item. If the stock was already in the shop, untick *"Record this stock as a purchase"* so no money is taken from the accounts.
3. **Settings → Users**: add a staff login for salespeople if needed.
4. Daily use: **New Sale** for every sale, **Expenses** for spending, **Restock** on a product's page when new stock arrives.
5. **Settings → Download backup** about once a week. Keep the file on a USB drive or in Google Drive.

## Project structure
```
docs/             Browser edition for GitHub Pages (index.html, app.js, style.css)
app.py            Flask web routes, login, roles, CSRF protection
store_db.py       Database and business logic (SQLite)
wsgi.py           Entry point for hosting
templates/        HTML pages (Jinja2)
static/           CSS, app icon, phone "Add to Home screen" manifest
data/             Created automatically: boutique.db (all shop data) + secret key. Not uploaded to GitHub.
```
