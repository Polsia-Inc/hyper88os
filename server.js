const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { validatePassword } = require('./lib/password-policy');
const { t, getTranslations } = require('./lib/i18n');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session management
app.use(session({
  store: new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true,
  }),
  secret: process.env.SESSION_SECRET || 'polsia-es-secret-' + (process.env.DATABASE_URL || '').slice(-8),
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  }
}));

// Auth middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  if (req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  res.redirect('/login');
}

// Make user data available to all requests
app.use(async (req, res, next) => {
  if (req.session && req.session.userId) {
    try {
      const result = await pool.query('SELECT id, email, name, role, locale FROM users WHERE id = $1', [req.session.userId]);
      req.user = result.rows[0] || null;
    } catch (e) {
      req.user = null;
    }
  }
  next();
});

// Health check (required for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ====== AUTH API ROUTES ======

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
    }

    const validation = validatePassword(password);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.errors[0] });
    }

    // Check if user exists
    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Ya existe una cuenta con este correo' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (email, name, password_hash, locale, role) VALUES ($1, $2, $3, $4, $5) RETURNING id, email, name, role, locale',
      [email.toLowerCase().trim(), name || '', passwordHash, 'es', 'user']
    );

    const user = result.rows[0];
    req.session.userId = user.id;

    res.status(201).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error('Signup error:', err.message);
    res.status(500).json({ error: 'Error al crear la cuenta' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
    }

    const result = await pool.query(
      'SELECT id, email, name, password_hash, role, locale FROM users WHERE LOWER(email) = LOWER($1)',
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    }

    const user = result.rows[0];
    if (!user.password_hash) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    }

    req.session.userId = user.id;
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
  } catch (err) {
    console.error('Login error:', err.message);
    res.status(500).json({ error: 'Error al iniciar sesión' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: 'Error al cerrar sesión' });
    }
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  if (req.user) {
    return res.json({ user: req.user });
  }
  res.status(401).json({ error: 'No autenticado' });
});

// ====== PAGE ROUTES ======

// Landing page
app.get('/', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.redirect('/login');
  }
});

// Auth pages
app.get('/login', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup', (req, res) => {
  if (req.user) return res.redirect('/dashboard');
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

// Dashboard (protected)
app.get('/dashboard', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Dashboard API endpoints
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const stats = {
      agents: { active: 0, total: 0 },
      tasks: { pending: 0, in_progress: 0, completed: 0 },
      recent_activity: []
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Error al cargar estadísticas' });
  }
});

// Settings API
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT key, value FROM settings WHERE user_id = $1', [req.user.id]);
    const settings = {};
    result.rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: 'Error al cargar configuración' });
  }
});

app.post('/api/settings', requireAuth, async (req, res) => {
  try {
    const { key, value } = req.body;
    await pool.query(
      `INSERT INTO settings (user_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (user_id, key) DO UPDATE SET value = $3, updated_at = NOW()`,
      [req.user.id, key, JSON.stringify(value)]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar configuración' });
  }
});

app.listen(port, () => {
  console.log(`Polsia ES running on port ${port}`);
});
