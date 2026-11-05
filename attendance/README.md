# Softmasters Attendance System — Full Stack

A full-stack employee attendance management system built with:

- **Frontend** — plain HTML/CSS/JS (no framework), served as static files
- **Backend** — Node.js + Express REST API
- **Database** — PostgreSQL

---

## Project Structure

```
softmasters/
├── index.js            ← Entry point (loads .env → starts server)
├── package.json
├── schema.sql          ← Run this once to create DB tables
├── .env.example        ← Copy to .env and fill in your DB credentials
├── src/
│   ├── server.js       ← Express app & all API routes
│   └── db.js           ← PostgreSQL connection pool
└── public/
    └── index.html      ← The admin UI (served as a static file)
```

---

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up PostgreSQL

Create a database:
```sql
CREATE DATABASE softmasters;
```

Run the schema:
```bash
psql -d softmasters -f schema.sql
```

### 3. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your database credentials:
```
DATABASE_URL=postgresql://postgres:yourpassword@localhost:5432/softmasters
PORT=3000
```

### 4. Start the server

**Development** (auto-restarts on changes):
```bash
npm run dev
```

**Production:**
```bash
npm start
```

Open your browser at **http://localhost:3000**

Default login: `admin` / `admin123` — change it under **Settings → Admin credentials**.
To choose the first password yourself, set `ADMIN_USER` / `ADMIN_PASSWORD` in `.env`
before the server's first start (they are only used to create the account).

**Forgot the admin password?** Delete the stored account and restart the server;
it is re-created from `.env` (or the defaults):
```sql
DELETE FROM settings WHERE key = 'admin';
```

---

## API Endpoints

🔒 = admin only: requires `Authorization: Bearer <token>` from `/api/auth/login`.

| Method | Path | Description |
|--------|------|-------------|
| POST   | `/api/auth/login` | Admin login → session token (5 wrong tries = 5-min lockout) |
| POST   | `/api/auth/logout` | End the admin session |
| GET    | `/api/auth/me` 🔒 | Check the session is still valid |
| PUT    | `/api/auth/credentials` 🔒 | Change admin username/password (needs current password) |
| GET    | `/api/records` 🔒 | Fetch all attendance records |
| POST   | `/api/records` | Employee check-in/out — verifies name + PIN, GPS and day rules |
| GET    | `/api/checkin/status` | Whether `?name=` has checked in/out on `?date=` |
| DELETE | `/api/records/:id` 🔒 | Delete a record by ID |
| POST   | `/api/records/replace` 🔒 | Bulk-replace all records (Clear All) |
| GET    | `/api/employees` 🔒 | Fetch all registered employees |
| POST   | `/api/employees` 🔒 | Register a new employee |
| PUT    | `/api/employees/:id` 🔒 | Edit an employee (a rename also moves their records) |
| DELETE | `/api/employees/:id` 🔒 | Remove an employee |
| GET    | `/api/settings/gps` | Office location and radius |
| POST   | `/api/settings/gps` 🔒 | Save office location and radius |

---

## Deploying

### Render / Railway / Fly.io
1. Push this project to a GitHub repo
2. Connect the repo to your hosting provider
3. Set the `DATABASE_URL` environment variable to your hosted Postgres connection string
4. Set start command to `node index.js`

### Supabase (hosted Postgres)
Use the Supabase connection string (with `?sslmode=require`) as `DATABASE_URL`.

---

## Features

- ✅ Employee check-in / check-out with server-side PIN validation (5 wrong PINs = 5-min lockout)
- ✅ GPS geofence enforcement (checked on the server)
- ✅ QR code station for employee self-service
- ✅ Real-time dashboard (auto-refreshes every 30 s)
- ✅ Late / Early Departure / Overstay detection
- ✅ Employee registry with photo upload
- ✅ Export to CSV & Excel (daily, weekly, monthly, headcount, summary)
- ✅ Server-side admin login (scrypt-hashed password stored in the database)
- ✅ Session tokens required for every admin API call (8-hour idle timeout)
- ✅ Brute-force login protection on the server

---

Developed by **Yeboah Deborah Ntiriwah** — YDN Tech  
Full-stack migration by Softmasters Engineering
