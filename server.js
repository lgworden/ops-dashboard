const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ALLOWED_EMAIL_DOMAIN = "deloitte.com";
const EMAIL_RE = new RegExp(`^[^\\s@]+@${ALLOWED_EMAIL_DOMAIN.replace(".", "\\.")}$`, "i");

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

let store;

if (DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const ready = pool.query(`
    CREATE TABLE IF NOT EXISTS dashboard_state (
      id INTEGER PRIMARY KEY DEFAULT 1,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT single_row CHECK (id = 1)
    );
    CREATE TABLE IF NOT EXISTS dashboard_users (
      email TEXT PRIMARY KEY,
      first_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
      visits INTEGER NOT NULL DEFAULT 1
    );
  `);

  store = {
    async load() {
      await ready;
      const { rows } = await pool.query("SELECT data FROM dashboard_state WHERE id = 1");
      return rows[0] ? rows[0].data : null;
    },
    async save(data) {
      await ready;
      await pool.query(
        `INSERT INTO dashboard_state (id, data, updated_at) VALUES (1, $1, now())
         ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = now()`,
        [data]
      );
    },
    async logUser(email) {
      await ready;
      await pool.query(
        `INSERT INTO dashboard_users (email, first_seen, last_seen, visits)
         VALUES ($1, now(), now(), 1)
         ON CONFLICT (email) DO UPDATE SET last_seen = now(), visits = dashboard_users.visits + 1`,
        [email]
      );
    },
  };
  console.log("Using Postgres storage (DATABASE_URL is set).");
} else {
  const DATA_FILE = path.join(__dirname, "data.local.json");
  const USERS_FILE = path.join(__dirname, "users.local.json");
  store = {
    async load() {
      if (!fs.existsSync(DATA_FILE)) return null;
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    },
    async save(data) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data));
    },
    async logUser(email) {
      const users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) : {};
      const now = new Date().toISOString();
      const existing = users[email];
      users[email] = {
        first_seen: existing ? existing.first_seen : now,
        last_seen: now,
        visits: existing ? existing.visits + 1 : 1,
      };
      fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    },
  };
  console.log("DATABASE_URL not set — using data.local.json (local dev only, not for production).");
}

app.get("/api/dashboard", async (req, res) => {
  try {
    const data = await store.load();
    res.json({ data });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to load dashboard data" });
  }
});

app.put("/api/dashboard", async (req, res) => {
  try {
    await store.save(req.body);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to save dashboard data" });
  }
});

app.post("/api/login", async (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: `Please use your @${ALLOWED_EMAIL_DOMAIN} email address.` });
  }
  try {
    await store.logUser(email);
    res.json({ ok: true, email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to log in" });
  }
});

app.listen(PORT, () => console.log(`Ops dashboard listening on port ${PORT}`));
