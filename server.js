const express = require("express");
const path = require("path");
const fs = require("fs");
const cron = require("node-cron");
const { Document, Packer, Paragraph, HeadingLevel } = require("docx");

const app = express();
const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const ALLOWED_EMAIL_DOMAIN = "deloitte.com";
const EMAIL_RE = new RegExp(`^[^\\s@]+@${ALLOWED_EMAIL_DOMAIN.replace(".", "\\.")}$`, "i");
const NEW_USER_PASSWORD = process.env.NEW_USER_PASSWORD || "harbor-otter-velvet7";
const SNAPSHOT_TIMEZONE = "America/New_York";

function getEasternYMD(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: SNAPSHOT_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const map = {};
  fmt.formatToParts(date).forEach((p) => {
    if (p.type !== "literal") map[p.type] = p.value;
  });
  return `${map.year}-${map.month}-${map.day}`;
}

function mondayOfWeek(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  const diff = dow === 0 ? -6 : 1 - dow;
  dt.setUTCDate(dt.getUTCDate() + diff);
  return dt.toISOString().slice(0, 10);
}

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
    CREATE TABLE IF NOT EXISTS dashboard_snapshots (
      week_start DATE PRIMARY KEY,
      data JSONB NOT NULL,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
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
    async hasUser(email) {
      await ready;
      const { rows } = await pool.query("SELECT 1 FROM dashboard_users WHERE email = $1", [email]);
      return rows.length > 0;
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
    async listSnapshotWeeks() {
      await ready;
      const { rows } = await pool.query(
        "SELECT week_start, captured_at FROM dashboard_snapshots ORDER BY week_start DESC"
      );
      return rows.map((r) => ({
        weekStart: r.week_start.toISOString().slice(0, 10),
        capturedAt: r.captured_at.toISOString(),
      }));
    },
    async saveSnapshot(weekStart, data) {
      await ready;
      await pool.query(
        `INSERT INTO dashboard_snapshots (week_start, data, captured_at) VALUES ($1, $2, now())
         ON CONFLICT (week_start) DO UPDATE SET data = $2, captured_at = now()`,
        [weekStart, data]
      );
    },
    async getSnapshot(weekStart) {
      await ready;
      const { rows } = await pool.query(
        "SELECT data, captured_at FROM dashboard_snapshots WHERE week_start = $1",
        [weekStart]
      );
      return rows[0] ? { data: rows[0].data, capturedAt: rows[0].captured_at.toISOString() } : null;
    },
  };
  console.log("Using Postgres storage (DATABASE_URL is set).");
} else {
  const DATA_FILE = path.join(__dirname, "data.local.json");
  const USERS_FILE = path.join(__dirname, "users.local.json");
  const SNAPSHOTS_FILE = path.join(__dirname, "snapshots.local.json");
  store = {
    async load() {
      if (!fs.existsSync(DATA_FILE)) return null;
      return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    },
    async save(data) {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data));
    },
    async hasUser(email) {
      const users = fs.existsSync(USERS_FILE) ? JSON.parse(fs.readFileSync(USERS_FILE, "utf8")) : {};
      return Object.prototype.hasOwnProperty.call(users, email);
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
    async listSnapshotWeeks() {
      const snaps = fs.existsSync(SNAPSHOTS_FILE) ? JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, "utf8")) : {};
      return Object.keys(snaps)
        .sort((a, b) => (a < b ? 1 : -1))
        .map((weekStart) => ({ weekStart, capturedAt: snaps[weekStart].capturedAt }));
    },
    async saveSnapshot(weekStart, data) {
      const snaps = fs.existsSync(SNAPSHOTS_FILE) ? JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, "utf8")) : {};
      snaps[weekStart] = { data, capturedAt: new Date().toISOString() };
      fs.writeFileSync(SNAPSHOTS_FILE, JSON.stringify(snaps));
    },
    async getSnapshot(weekStart) {
      const snaps = fs.existsSync(SNAPSHOTS_FILE) ? JSON.parse(fs.readFileSync(SNAPSHOTS_FILE, "utf8")) : {};
      return snaps[weekStart] || null;
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
  const password = String((req.body && req.body.password) || "");
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: `Please use your @${ALLOWED_EMAIL_DOMAIN} email address.` });
  }
  try {
    const known = await store.hasUser(email);
    if (!known && password !== NEW_USER_PASSWORD) {
      const message = password
        ? "Incorrect password. Try again."
        : "New here? Enter the password your team shared with you to continue.";
      return res.status(401).json({ error: message, passwordRequired: true });
    }
    await store.logUser(email);
    res.json({ ok: true, email });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to log in" });
  }
});

app.post("/api/export/docx", async (req, res) => {
  try {
    const { title, subtitle, groups } = req.body || {};
    const children = [
      new Paragraph({ text: String(title || "Action Items"), heading: HeadingLevel.TITLE }),
    ];
    if (subtitle) {
      children.push(new Paragraph({ text: String(subtitle), heading: HeadingLevel.HEADING_3 }));
    }
    (groups || []).forEach((group) => {
      children.push(
        new Paragraph({
          text: String(group.heading || ""),
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 300 },
        })
      );
      (group.items || []).forEach((line) => {
        children.push(new Paragraph({ text: String(line), bullet: { level: 0 } }));
      });
    });

    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader("Content-Disposition", 'attachment; filename="action-items.docx"');
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate document" });
  }
});

function formatDateLong(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

function flattenSnapshotItems(items, depth, out) {
  (items || []).forEach((item) => {
    const meta = [];
    if (item.owner) meta.push("Owner: " + item.owner);
    if (item.due) meta.push("Due: " + item.due);
    const status = item.archived ? " [Archived]" : item.done ? " [Completed]" : "";
    const metaStr = meta.length ? " (" + meta.join(", ") + ")" : "";
    out.push({ text: stripHtml(item.text) + metaStr + status, depth });
    if (item.sub && item.sub.length) flattenSnapshotItems(item.sub, depth + 1, out);
  });
}

function buildSnapshotChildren(data, weekStart, capturedAt) {
  const children = [
    new Paragraph({
      text: `${data.title || "Ops Dashboard"} — Week of ${formatDateLong(weekStart)}`,
      heading: HeadingLevel.TITLE,
    }),
    new Paragraph({
      text: `Lead: ${data.lead || "—"}   |   Snapshot captured ${new Date(capturedAt).toLocaleString("en-US", {
        timeZone: SNAPSHOT_TIMEZONE,
      })} ET`,
      heading: HeadingLevel.HEADING_3,
    }),
  ];

  const groups = [
    { label: null, rows: ["row1"] },
    { label: "PMO Items", rows: ["row2", "row3"] },
    { label: "Initiative Updates", rows: ["row4", "row5"] },
    { label: "Sub Market Leads", rows: ["row6"] },
  ];

  groups.forEach((group) => {
    if (group.label) {
      children.push(
        new Paragraph({ text: group.label, heading: HeadingLevel.HEADING_1, spacing: { before: 400 } })
      );
    }
    group.rows.forEach((rowKey) => {
      (data[rowKey] || []).forEach((section) => {
        children.push(
          new Paragraph({ text: section.title || "", heading: HeadingLevel.HEADING_2, spacing: { before: 200 } })
        );
        const flat = [];
        flattenSnapshotItems(section.items, 0, flat);
        if (flat.length === 0) {
          children.push(new Paragraph({ text: "No items." }));
        } else {
          flat.forEach((line) => {
            children.push(new Paragraph({ text: line.text, bullet: { level: line.depth } }));
          });
        }
      });
    });
  });

  return children;
}

app.get("/api/snapshots", async (req, res) => {
  try {
    const weeks = await store.listSnapshotWeeks();
    res.json({ weeks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to list snapshots" });
  }
});

app.get("/api/snapshots/:weekStart/docx", async (req, res) => {
  const weekStart = req.params.weekStart;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return res.status(400).json({ error: "Invalid week" });
  }
  try {
    const snapshot = await store.getSnapshot(weekStart);
    if (!snapshot) return res.status(404).json({ error: "No snapshot for that week" });
    const children = buildSnapshotChildren(snapshot.data, weekStart, snapshot.capturedAt);
    const doc = new Document({ sections: [{ children }] });
    const buffer = await Packer.toBuffer(doc);
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    res.setHeader("Content-Disposition", `attachment; filename="snapshot-week-of-${weekStart}.docx"`);
    res.send(buffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to generate snapshot document" });
  }
});

cron.schedule(
  "59 23 * * 5",
  async () => {
    try {
      const data = await store.load();
      if (!data) return;
      const weekStart = mondayOfWeek(getEasternYMD(new Date()));
      await store.saveSnapshot(weekStart, data);
      console.log(`Captured weekly snapshot for week of ${weekStart}`);
    } catch (err) {
      console.error("Weekly snapshot job failed:", err);
    }
  },
  { timezone: SNAPSHOT_TIMEZONE }
);

app.listen(PORT, () => console.log(`Ops dashboard listening on port ${PORT}`));
