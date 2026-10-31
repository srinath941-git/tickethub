const express = require('express');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const client = require('prom-client');

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  port: 5432,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});
pool.on('error', e => console.log('DB connection error:', e.message));
const JWT_SECRET = process.env.JWT_SECRET;

// ---- Prometheus metrics ----
client.collectDefaultMetrics();
const ticketsBooked = new client.Counter({ name: 'tickets_booked_total', help: 'Seats booked' });
const bookingConflicts = new client.Counter({ name: 'booking_conflicts_total', help: 'Bookings rejected because a seat was taken' });
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration',
  labelNames: ['method', 'route', 'status'],
});
app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => end({ method: req.method, route: req.route ? req.route.path : 'other', status: res.statusCode }));
  next();
});

// ---- Database setup (retries until PostgreSQL is ready) ----
const SCHEMA = `
  CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name VARCHAR(80) NOT NULL, email VARCHAR(120) UNIQUE NOT NULL, password_hash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS events (id SERIAL PRIMARY KEY, title VARCHAR(120) NOT NULL, venue VARCHAR(120) NOT NULL, starts_at TIMESTAMPTZ NOT NULL, price INT NOT NULL);
  CREATE TABLE IF NOT EXISTS seats (id SERIAL PRIMARY KEY, event_id INT REFERENCES events(id), label VARCHAR(8) NOT NULL, status VARCHAR(12) NOT NULL DEFAULT 'available', UNIQUE (event_id, label));
  CREATE TABLE IF NOT EXISTS bookings (id SERIAL PRIMARY KEY, user_id INT REFERENCES users(id), event_id INT REFERENCES events(id), seats TEXT[] NOT NULL, total INT NOT NULL, created_at TIMESTAMPTZ DEFAULT NOW());`;

const SAMPLE_EVENTS = [
  ['Sunset Music Fest', 'Hyderabad Open Arena', 30, 1500],
  ['City Cricket Night', 'Riverside Stadium', 12, 2500],
  ['Comedy Club Live', 'Jubilee Auditorium', 7, 600],
];

async function initDb() {
  for (let i = 1; i <= 30; i++) {
    let c;
    try {
      c = await pool.connect();
      await c.query('SELECT pg_advisory_lock(7)');
      await c.query(SCHEMA);
      const { rows } = await c.query('SELECT COUNT(*)::int AS n FROM events');
      if (rows[0].n === 0) {
        for (const [title, venue, days, price] of SAMPLE_EVENTS) {
          const ev = await c.query(
            'INSERT INTO events(title, venue, starts_at, price) VALUES($1, $2, NOW() + make_interval(days => $3), $4) RETURNING id',
            [title, venue, days, price]);
          await c.query(
            `INSERT INTO seats(event_id, label)
             SELECT $1::int, r || n FROM unnest(ARRAY['A','B','C','D','E']) AS r, generate_series(1, 8) AS n`,
            [ev.rows[0].id]);
        }
      }
      await c.query('SELECT pg_advisory_unlock(7)');
      c.release();
      console.log('Database ready');
      return;
    } catch (e) {
      if (c) c.release(true);
      console.log(`DB not ready (${i}/30): ${e.message}`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  process.exit(1);
}

// ---- Authentication ----
function tokenFor(u) {
  return { name: u.name, token: jwt.sign({ id: u.id, name: u.name }, JWT_SECRET, { expiresIn: '8h' }) };
}

function auth(req, res, next) {
  try {
    req.user = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    next();
  } catch (e) {
    res.status(401).json({ error: 'Please log in' });
  }
}

app.post('/api/auth/register', async (req, res) => {
  const { name, email, password } = req.body || {};
  if (!name || !email || !email.includes('@') || !password || password.length < 6)
    return res.status(400).json({ error: 'Name, a valid email and a password of 6+ characters are required' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO users(name, email, password_hash) VALUES($1, $2, $3) RETURNING id, name',
      [name.slice(0, 80), email.toLowerCase(), hash]);
    res.status(201).json(tokenFor(r.rows[0]));
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Email already registered' });
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body || {};
  try {
    const r = await pool.query('SELECT id, name, password_hash FROM users WHERE email = $1', [String(email || '').toLowerCase()]);
    const u = r.rows[0];
    if (!u || !(await bcrypt.compare(String(password || ''), u.password_hash)))
      return res.status(401).json({ error: 'Invalid email or password' });
    res.json(tokenFor(u));
  } catch (e) {
    res.status(500).json({ error: 'Login failed' });
  }
});

// ---- Events and seats ----
app.get('/api/events', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT e.id, e.title, e.venue, e.starts_at, e.price,
             COUNT(*) FILTER (WHERE s.status = 'available')::int AS available
      FROM events e JOIN seats s ON s.event_id = e.id
      GROUP BY e.id ORDER BY e.starts_at`);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not load events' });
  }
});

app.get('/api/events/:id/seats', async (req, res) => {
  try {
    const r = await pool.query('SELECT label, status FROM seats WHERE event_id = $1 ORDER BY label', [parseInt(req.params.id, 10) || 0]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not load seats' });
  }
});

// ---- Bookings (the double-booking protection lives here) ----
app.post('/api/bookings', auth, async (req, res) => {
  const eventId = parseInt(req.body.eventId, 10);
  const seats = [...new Set(Array.isArray(req.body.seats) ? req.body.seats.map(String) : [])];
  if (!eventId || seats.length < 1 || seats.length > 6)
    return res.status(400).json({ error: 'Choose between 1 and 6 seats' });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const upd = await c.query(
      `UPDATE seats SET status = 'booked' WHERE event_id = $1 AND label = ANY($2) AND status = 'available' RETURNING label`,
      [eventId, seats]);
    if (upd.rowCount !== seats.length) {
      await c.query('ROLLBACK');
      bookingConflicts.inc();
      return res.status(409).json({ error: 'One or more seats were just taken. Please pick again.' });
    }
    const price = (await c.query('SELECT price FROM events WHERE id = $1', [eventId])).rows[0].price;
    const total = price * seats.length;
    const b = await c.query(
      'INSERT INTO bookings(user_id, event_id, seats, total) VALUES($1, $2, $3, $4) RETURNING id',
      [req.user.id, eventId, seats, total]);
    await c.query('COMMIT');
    ticketsBooked.inc(seats.length);
    res.status(201).json({ id: b.rows[0].id, total });
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'Booking failed' });
  } finally {
    c.release();
  }
});

app.get('/api/bookings', auth, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.id, e.title, b.seats, b.total, b.created_at
       FROM bookings b JOIN events e ON e.id = b.event_id
       WHERE b.user_id = $1 ORDER BY b.id DESC`, [req.user.id]);
    res.json(r.rows);
  } catch (e) {
    res.status(500).json({ error: 'Could not load bookings' });
  }
});

// ---- Health and metrics ----
app.get('/api/health', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch (e) { res.status(500).json({ status: 'database unavailable' }); }
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

initDb().then(() => app.listen(3000, () => console.log('API listening on 3000')));
