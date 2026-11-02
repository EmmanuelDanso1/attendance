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

Default login: `admin` / `admin123`

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET    | `/api/records` | Fetch all attendance records |
| POST   | `/api/records` | Add a single check-in/out record |
| DELETE | `/api/records/:id` | Delete a record by ID |
| POST   | `/api/records/replace` | Bulk-replace all records (Clear All) |
| GET    | `/api/employees` | Fetch all registered employees |
| POST   | `/api/employees` | Register a new employee |
| DELETE | `/api/employees/:id` | Remove an employee |

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

- ✅ Employee check-in / check-out with PIN validation
- ✅ GPS geofence enforcement
- ✅ QR code station for employee self-service
- ✅ Real-time dashboard (auto-refreshes every 30 s)
- ✅ Late / Early Departure / Overstay detection
- ✅ Employee registry with photo upload
- ✅ Export to CSV & Excel (daily, weekly, monthly, headcount, summary)
- ✅ Admin credentials with SHA-256 hashed passwords
- ✅ Session management (8-hour timeout)
- ✅ Brute-force login protection

---

Developed by **Yeboah Deborah Ntiriwah** — YDN Tech  
Full-stack migration by Softmasters Engineering
