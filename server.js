const express = require('express');
const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const { validatePassword } = require('./lib/password-policy');
const { t, getTranslations } = require('./lib/i18n');
const crypto = require('crypto');

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

// Stripe payment links (pre-created, reusable)
const PAYMENT_LINKS = {
  starter: 'https://buy.stripe.com/dRm8wP6DQbCoaoo7T4dka22',
  pro: 'https://buy.stripe.com/6oUaEXbYagWI8gg8X8dka23',
  enterprise: 'https://buy.stripe.com/00wdR95zM5e04005KWdka24'
};

const PLAN_DETAILS = {
  free: { name: 'Gratis', price: 0, api_daily: 100, llm_daily: 10, companies: 1, credits: 3 },
  starter: { name: 'Starter', price: 29, api_daily: 5000, llm_daily: 500, companies: 3, credits: 25 },
  pro: { name: 'Pro', price: 79, api_daily: 25000, llm_daily: 2500, companies: 10, credits: 100 },
  enterprise: { name: 'Enterprise', price: 199, api_daily: 100000, llm_daily: 10000, companies: -1, credits: 500 }
};

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Trust Render's load balancer (REQUIRED for secure cookies in production)
app.set('trust proxy', 1);

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
    maxAge: 30 * 24 * 60 * 60 * 1000,
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
      const result = await pool.query('SELECT id, email, name, role, locale, theme, referral_code FROM users WHERE id = $1', [req.session.userId]);
      req.user = result.rows[0] || null;
    } catch (e) {
      req.user = null;
    }
  }
  next();
});

// Health check (required for Render)
app.get('/health', async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    version: require('./package.json').version
  };

  // Check database connectivity
  try {
    const result = await pool.query('SELECT NOW() as db_time');
    health.database = {
      status: 'connected',
      latency_ms: Date.now() - new Date(result.rows[0].db_time).getTime()
    };
  } catch (err) {
    health.status = 'unhealthy';
    health.database = {
      status: 'disconnected',
      error: err.message
    };
    return res.status(503).json(health);
  }

  // Check required environment variables
  const requiredEnvVars = ['DATABASE_URL', 'POLSIA_API_KEY', 'OPENAI_API_KEY'];
  const missingEnvVars = requiredEnvVars.filter(v => !process.env[v]);
  if (missingEnvVars.length > 0) {
    health.status = 'degraded';
    health.environment_vars = {
      status: 'incomplete',
      missing: missingEnvVars
    };
  } else {
    health.environment_vars = {
      status: 'complete'
    };
  }

  const statusCode = health.status === 'healthy' ? 200 : 503;
  res.status(statusCode).json(health);
});

// API health check endpoint (alias for /health)
app.get('/api/health', async (req, res) => {
  req.url = '/health';
  app.handle(req, res);
});

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// ====== AUTH API ROUTES ======

function generateReferralCode() {
  return 'POL' + crypto.randomBytes(4).toString('hex').toUpperCase();
}

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, name, referral_code } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Correo y contraseña son requeridos' });
    }

    const validation = validatePassword(password);
    if (!validation.valid) {
      return res.status(400).json({ error: validation.errors[0] });
    }

    const existing = await pool.query('SELECT id FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (existing.rows.length > 0) {
      return res.status(409).json({ error: 'Ya existe una cuenta con este correo' });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const userRefCode = generateReferralCode();

    // Check if referral code is valid
    let referredBy = null;
    if (referral_code) {
      const referrer = await pool.query('SELECT id FROM users WHERE referral_code = $1', [referral_code]);
      if (referrer.rows.length > 0) {
        referredBy = referrer.rows[0].id;
      }
    }

    const result = await pool.query(
      `INSERT INTO users (email, name, password_hash, locale, role, referral_code, referred_by, theme)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, email, name, role, locale, theme, referral_code`,
      [email.toLowerCase().trim(), name || '', passwordHash, 'es', 'user', userRefCode, referredBy, 'dark']
    );

    const user = result.rows[0];
    req.session.userId = user.id;

    // Create default free subscription
    await pool.query(
      `INSERT INTO subscriptions (user_id, plan_slug, status, started_at)
       VALUES ($1, 'free', 'active', NOW())`,
      [user.id]
    );

    // Create initial credits
    await pool.query(
      `INSERT INTO credits (user_id, credits_total, credits_used, period_start, period_end)
       VALUES ($1, 3, 0, NOW(), NOW() + INTERVAL '30 days')`,
      [user.id]
    );

    // If referred, award bonus credits to referrer
    if (referredBy) {
      await pool.query(
        `INSERT INTO referrals (referrer_id, referred_id, referral_code, status, bonus_credits, redeemed_at)
         VALUES ($1, $2, $3, 'completed', 5, NOW())`,
        [referredBy, user.id, referral_code]
      );
      // Add bonus credits to referrer
      await pool.query(
        `UPDATE credits SET credits_total = credits_total + 5, updated_at = NOW()
         WHERE user_id = $1 AND period_end > NOW()`,
        [referredBy]
      );
    }

    res.status(201).json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, theme: user.theme } });
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
      'SELECT id, email, name, password_hash, role, locale, theme, referral_code FROM users WHERE LOWER(email) = LOWER($1)',
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
    res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, theme: user.theme } });
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

// ====== THEME API ======

app.post('/api/theme', requireAuth, async (req, res) => {
  try {
    const { theme } = req.body;
    if (!['light', 'dark'].includes(theme)) {
      return res.status(400).json({ error: 'Tema inválido' });
    }
    await pool.query('UPDATE users SET theme = $1, updated_at = NOW() WHERE id = $2', [theme, req.user.id]);
    res.json({ ok: true, theme });
  } catch (err) {
    res.status(500).json({ error: 'Error al guardar tema' });
  }
});

// ====== BILLING API ======

// Get current subscription & usage
app.get('/api/billing', requireAuth, async (req, res) => {
  try {
    // Get active subscription
    const subResult = await pool.query(
      `SELECT s.*, sp.name as plan_name, sp.price_cents, sp.api_calls_daily, sp.llm_calls_daily,
              sp.max_companies, sp.task_credits as plan_credits
       FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_slug = sp.slug
       WHERE s.user_id = $1 AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
      [req.user.id]
    );

    const subscription = subResult.rows[0] || {
      plan_slug: 'free', plan_name: 'Gratis', price_cents: 0,
      api_calls_daily: 100, llm_calls_daily: 10, max_companies: 1, plan_credits: 3
    };

    // Get today's usage
    const usageResult = await pool.query(
      `SELECT COALESCE(SUM(api_calls), 0) as api_calls, COALESCE(SUM(llm_calls), 0) as llm_calls
       FROM usage_tracking WHERE user_id = $1 AND usage_date = CURRENT_DATE`,
      [req.user.id]
    );
    const usage = usageResult.rows[0];

    // Get credits
    const creditsResult = await pool.query(
      `SELECT COALESCE(SUM(credits_total - credits_used), 0) as available
       FROM credits WHERE user_id = $1 AND period_end > NOW()`,
      [req.user.id]
    );
    const credits = creditsResult.rows[0];

    // Get company count
    const companyResult = await pool.query(
      'SELECT COUNT(*) as count FROM companies WHERE owner_id = $1',
      [req.user.id]
    );

    res.json({
      subscription: {
        plan_slug: subscription.plan_slug,
        plan_name: subscription.plan_name,
        price: subscription.price_cents / 100,
        status: subscription.status || 'active',
        started_at: subscription.started_at,
        expires_at: subscription.expires_at
      },
      limits: {
        api_calls_daily: subscription.api_calls_daily,
        llm_calls_daily: subscription.llm_calls_daily,
        max_companies: subscription.max_companies,
        task_credits: subscription.plan_credits
      },
      usage: {
        api_calls_today: parseInt(usage.api_calls),
        llm_calls_today: parseInt(usage.llm_calls)
      },
      credits: {
        available: parseInt(credits.available)
      },
      companies: {
        count: parseInt(companyResult.rows[0].count)
      }
    });
  } catch (err) {
    console.error('Billing error:', err.message);
    res.status(500).json({ error: 'Error al cargar facturación' });
  }
});

// Get pricing plans
app.get('/api/plans', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM subscription_plans WHERE is_active = TRUE ORDER BY sort_order'
    );
    const plans = result.rows.map(p => ({
      ...p,
      price: p.price_cents / 100,
      payment_link: PAYMENT_LINKS[p.slug] || null
    }));
    res.json({ plans });
  } catch (err) {
    res.json({ plans: Object.entries(PLAN_DETAILS).map(([slug, d]) => ({
      slug, ...d, payment_link: PAYMENT_LINKS[slug] || null
    }))});
  }
});

// Subscribe / upgrade plan
app.post('/api/billing/subscribe', requireAuth, async (req, res) => {
  try {
    const { plan_slug } = req.body;
    if (!PLAN_DETAILS[plan_slug]) {
      return res.status(400).json({ error: 'Plan no válido' });
    }

    if (plan_slug === 'free') {
      return res.status(400).json({ error: 'Ya tienes el plan gratuito' });
    }

    const paymentLink = PAYMENT_LINKS[plan_slug];
    if (!paymentLink) {
      return res.status(400).json({ error: 'Link de pago no disponible' });
    }

    // Create pending subscription
    const sub = await pool.query(
      `INSERT INTO subscriptions (user_id, plan_slug, status, stripe_payment_link, started_at)
       VALUES ($1, $2, 'pending_payment', $3, NOW()) RETURNING id`,
      [req.user.id, plan_slug, paymentLink]
    );

    // Build payment URL with prefill
    const stripeUrl = new URL(paymentLink);
    stripeUrl.searchParams.set('prefilled_email', req.user.email);
    stripeUrl.searchParams.set('client_reference_id', `sub_${sub.rows[0].id}`);

    res.json({
      subscription_id: sub.rows[0].id,
      payment_url: stripeUrl.toString(),
      plan: PLAN_DETAILS[plan_slug]
    });
  } catch (err) {
    console.error('Subscribe error:', err.message);
    res.status(500).json({ error: 'Error al procesar suscripción' });
  }
});

// Verify payment (with fraud detection)
app.post('/api/billing/verify', requireAuth, async (req, res) => {
  try {
    const { subscription_id, session_id } = req.body;
    const clientIp = req.ip || req.headers['x-forwarded-for'];
    const userAgent = req.headers['user-agent'] || '';

    const subResult = await pool.query(
      `SELECT * FROM subscriptions WHERE id = $1 AND user_id = $2 AND status = 'pending_payment'`,
      [subscription_id, req.user.id]
    );

    if (subResult.rows.length === 0) {
      return res.status(404).json({ error: 'Suscripción no encontrada' });
    }

    const sub = subResult.rows[0];

    // Rate limiting
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    if (sub.verification_attempts >= 3 && new Date(sub.last_verification_attempt) > oneDayAgo) {
      return res.status(429).json({ error: 'Demasiados intentos. Contacta soporte.' });
    }

    // Update attempt counter
    await pool.query(
      `UPDATE subscriptions SET verification_attempts = COALESCE(verification_attempts, 0) + 1,
       last_verification_attempt = NOW() WHERE id = $1`,
      [subscription_id]
    );

    // Fraud scoring
    let fraudScore = 0;
    let fraudIndicators = {};

    const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);
    if (new Date(sub.created_at) < thirtyMinutesAgo) {
      fraudScore += 40;
      fraudIndicators.expired = true;
    }
    if ((sub.verification_attempts || 0) > 0) {
      fraudScore += 20 * (sub.verification_attempts || 0);
      fraudIndicators.multiple_attempts = sub.verification_attempts;
    }
    if (!session_id) {
      fraudScore += 30;
      fraudIndicators.no_session_id = true;
    }

    // Try Polsia verification
    let verifiedByPolsia = false;
    if (session_id && process.env.POLSIA_API_KEY) {
      try {
        const verifyUrl = `https://polsia.com/api/company-payments/verify?session_id=${session_id}`;
        const verifyRes = await fetch(verifyUrl, {
          headers: { 'Authorization': `Bearer ${process.env.POLSIA_API_KEY}` }
        });
        if (verifyRes.ok) {
          const data = await verifyRes.json();
          if (data.verified) {
            verifiedByPolsia = true;
            fraudScore = 0;
            fraudIndicators = { polsia_verified: true };
          }
        }
      } catch (e) {
        console.error('Polsia verify error:', e.message);
      }
    }

    const shouldApprove = verifiedByPolsia || fraudScore < 50;

    // Audit log
    await pool.query(
      `INSERT INTO subscription_audit_log (subscription_id, user_id, action, verification_method,
       verified_by_polsia, client_ip, user_agent, fraud_indicators)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [subscription_id, req.user.id, shouldApprove ? 'approved' : 'blocked',
       verifiedByPolsia ? 'polsia_api' : 'fraud_analysis',
       verifiedByPolsia, clientIp, userAgent, JSON.stringify({ ...fraudIndicators, fraud_score: fraudScore })]
    );

    if (shouldApprove) {
      // Activate subscription
      await pool.query(
        `UPDATE subscriptions SET status = 'active', verification_method = $1,
         verified_by_polsia = $2, fraud_score = $3, updated_at = NOW()
         WHERE id = $4`,
        [verifiedByPolsia ? 'polsia_api' : 'fraud_analysis', verifiedByPolsia, fraudScore, subscription_id]
      );

      // Deactivate old subscriptions
      await pool.query(
        `UPDATE subscriptions SET status = 'superseded', updated_at = NOW()
         WHERE user_id = $1 AND id != $2 AND status = 'active'`,
        [req.user.id, subscription_id]
      );

      // Update credits for the new plan
      const planCredits = PLAN_DETAILS[sub.plan_slug]?.credits || 3;
      await pool.query(
        `INSERT INTO credits (user_id, credits_total, credits_used, period_start, period_end)
         VALUES ($1, $2, 0, NOW(), NOW() + INTERVAL '30 days')`,
        [req.user.id, planCredits]
      );

      // Create invoice
      const planPrice = PLAN_DETAILS[sub.plan_slug]?.price || 0;
      await pool.query(
        `INSERT INTO invoices (user_id, subscription_id, amount_cents, status, description, paid_at)
         VALUES ($1, $2, $3, 'paid', $4, NOW())`,
        [req.user.id, subscription_id, planPrice * 100, `Suscripción ${PLAN_DETAILS[sub.plan_slug]?.name || sub.plan_slug}`]
      );

      res.json({ verified: true, status: 'active', plan: sub.plan_slug });
    } else {
      await pool.query(
        `UPDATE subscriptions SET status = 'pending_review', fraud_score = $1 WHERE id = $2`,
        [fraudScore, subscription_id]
      );
      res.status(403).json({
        error: 'Verificación de pago requerida',
        fraud_score: fraudScore,
        message: 'Tu suscripción está pendiente de revisión. Contacta soporte@polsia.com'
      });
    }
  } catch (err) {
    console.error('Verify error:', err.message);
    res.status(500).json({ error: 'Error al verificar pago' });
  }
});

// Get invoices
app.get('/api/billing/invoices', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*, s.plan_slug FROM invoices i
       LEFT JOIN subscriptions s ON i.subscription_id = s.id
       WHERE i.user_id = $1 ORDER BY i.created_at DESC LIMIT 50`,
      [req.user.id]
    );
    res.json({ invoices: result.rows.map(inv => ({
      ...inv,
      amount: inv.amount_cents / 100
    }))});
  } catch (err) {
    res.status(500).json({ error: 'Error al cargar facturas' });
  }
});

// Get usage history
app.get('/api/billing/usage', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT usage_date, SUM(api_calls) as api_calls, SUM(llm_calls) as llm_calls
       FROM usage_tracking WHERE user_id = $1 AND usage_date >= CURRENT_DATE - INTERVAL '30 days'
       GROUP BY usage_date ORDER BY usage_date DESC`,
      [req.user.id]
    );
    res.json({ usage: result.rows });
  } catch (err) {
    res.status(500).json({ error: 'Error al cargar uso' });
  }
});

// ====== REFERRAL API ======

app.get('/api/referral', requireAuth, async (req, res) => {
  try {
    // Ensure user has a referral code
    let code = req.user.referral_code;
    if (!code) {
      code = generateReferralCode();
      await pool.query('UPDATE users SET referral_code = $1 WHERE id = $2', [code, req.user.id]);
    }

    // Get referral stats
    const stats = await pool.query(
      `SELECT COUNT(*) as total_referrals,
              SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
              SUM(CASE WHEN status = 'completed' THEN bonus_credits ELSE 0 END) as total_bonus
       FROM referrals WHERE referrer_id = $1`,
      [req.user.id]
    );

    res.json({
      referral_code: code,
      referral_url: `${req.protocol}://${req.get('host')}/signup?ref=${code}`,
      stats: {
        total: parseInt(stats.rows[0].total_referrals) || 0,
        completed: parseInt(stats.rows[0].completed) || 0,
        bonus_credits: parseInt(stats.rows[0].total_bonus) || 0
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al cargar referidos' });
  }
});

// ====== SETTINGS API ======

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

// ====== TASKS API ======

// List tasks (with filtering)
app.get('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { status, tag, priority, search, sort = 'sort_order', order = 'asc' } = req.query;

    let query = `SELECT t.*, u.name as creator_name FROM tasks t
                 LEFT JOIN users u ON t.created_by = u.id
                 WHERE t.created_by = $1`;
    const params = [req.user.id];
    let paramIdx = 2;

    if (status && status !== 'all') {
      query += ` AND t.status = $${paramIdx}`;
      params.push(status);
      paramIdx++;
    }
    if (tag && tag !== 'all') {
      query += ` AND t.tag = $${paramIdx}`;
      params.push(tag);
      paramIdx++;
    }
    if (priority && priority !== 'all') {
      query += ` AND t.priority = $${paramIdx}`;
      params.push(priority);
      paramIdx++;
    }
    if (search) {
      query += ` AND (t.title ILIKE $${paramIdx} OR t.description ILIKE $${paramIdx})`;
      params.push(`%${search}%`);
      paramIdx++;
    }

    // Sorting
    const validSorts = ['sort_order', 'created_at', 'priority', 'status', 'title'];
    const sortCol = validSorts.includes(sort) ? sort : 'sort_order';
    const sortDir = order === 'desc' ? 'DESC' : 'ASC';

    if (sortCol === 'priority') {
      query += ` ORDER BY CASE t.priority WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 WHEN 'low' THEN 4 END ${sortDir}, t.sort_order ASC`;
    } else {
      query += ` ORDER BY t.${sortCol} ${sortDir}`;
    }

    const result = await pool.query(query, params);

    // Get counts per status
    const countsResult = await pool.query(
      `SELECT status, COUNT(*)::int as count FROM tasks WHERE created_by = $1 GROUP BY status`,
      [req.user.id]
    );
    const counts = {};
    countsResult.rows.forEach(r => { counts[r.status] = r.count; });

    res.json({ tasks: result.rows, counts });
  } catch (err) {
    console.error('List tasks error:', err.message);
    res.status(500).json({ error: 'Error al cargar tareas' });
  }
});

// Get single task with history and logs
app.get('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const taskResult = await pool.query(
      `SELECT t.*, u.name as creator_name FROM tasks t
       LEFT JOIN users u ON t.created_by = u.id
       WHERE t.id = $1 AND t.created_by = $2`,
      [req.params.id, req.user.id]
    );

    if (taskResult.rows.length === 0) {
      return res.status(404).json({ error: 'Tarea no encontrada' });
    }

    // Get status history
    const historyResult = await pool.query(
      `SELECT h.*, u.name as changed_by_name FROM task_status_history h
       LEFT JOIN users u ON h.changed_by = u.id
       WHERE h.task_id = $1 ORDER BY h.created_at DESC`,
      [req.params.id]
    );

    // Get logs
    const logsResult = await pool.query(
      `SELECT * FROM task_logs WHERE task_id = $1 ORDER BY created_at DESC LIMIT 100`,
      [req.params.id]
    );

    res.json({
      task: taskResult.rows[0],
      history: historyResult.rows,
      logs: logsResult.rows
    });
  } catch (err) {
    console.error('Get task error:', err.message);
    res.status(500).json({ error: 'Error al cargar tarea' });
  }
});

// Create task
app.post('/api/tasks', requireAuth, async (req, res) => {
  try {
    const { title, description, tag, priority, complexity, estimated_hours, assigned_agent } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'El título es requerido' });
    }

    // Get max sort_order
    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) + 1 as next_order FROM tasks WHERE created_by = $1',
      [req.user.id]
    );

    const result = await pool.query(
      `INSERT INTO tasks (title, description, status, tag, priority, complexity, estimated_hours, assigned_agent, created_by, sort_order)
       VALUES ($1, $2, 'todo', $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        title.trim(),
        description || '',
        tag || 'general',
        priority || 'medium',
        complexity || 3,
        estimated_hours || 1.0,
        assigned_agent || null,
        req.user.id,
        maxOrder.rows[0].next_order
      ]
    );

    const task = result.rows[0];

    // Log creation in status history
    await pool.query(
      `INSERT INTO task_status_history (task_id, old_status, new_status, changed_by, note)
       VALUES ($1, NULL, 'todo', $2, 'Tarea creada')`,
      [task.id, req.user.id]
    );

    // Add creation log
    await pool.query(
      `INSERT INTO task_logs (task_id, level, message) VALUES ($1, 'info', 'Tarea creada')`,
      [task.id]
    );

    res.status(201).json({ task });
  } catch (err) {
    console.error('Create task error:', err.message);
    res.status(500).json({ error: 'Error al crear tarea' });
  }
});

// Update task
app.put('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const { title, description, status, tag, priority, complexity, estimated_hours, assigned_agent } = req.body;

    // Verify ownership
    const existing = await pool.query(
      'SELECT * FROM tasks WHERE id = $1 AND created_by = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Tarea no encontrada' });
    }

    const oldTask = existing.rows[0];
    const validStatuses = ['todo', 'in_progress', 'completed', 'failed', 'rejected'];
    const newStatus = status && validStatuses.includes(status) ? status : oldTask.status;

    // Update timestamps based on status change
    let startedAt = oldTask.started_at;
    let completedAt = oldTask.completed_at;
    let failedAt = oldTask.failed_at;

    if (newStatus !== oldTask.status) {
      if (newStatus === 'in_progress' && !startedAt) startedAt = new Date();
      if (newStatus === 'completed') completedAt = new Date();
      if (newStatus === 'failed') failedAt = new Date();
    }

    const result = await pool.query(
      `UPDATE tasks SET
        title = $1, description = $2, status = $3, tag = $4,
        priority = $5, complexity = $6, estimated_hours = $7,
        assigned_agent = $8, started_at = $9, completed_at = $10,
        failed_at = $11, updated_at = NOW()
       WHERE id = $12 AND created_by = $13 RETURNING *`,
      [
        title !== undefined ? title.trim() : oldTask.title,
        description !== undefined ? description : oldTask.description,
        newStatus,
        tag || oldTask.tag,
        complexity || oldTask.complexity,
        estimated_hours || oldTask.estimated_hours,
        assigned_agent !== undefined ? assigned_agent : oldTask.assigned_agent,
        startedAt,
        completedAt,
        failedAt,
        req.params.id,
        req.user.id
      ]
    );

    // Log status change
    if (newStatus !== oldTask.status) {
      await pool.query(
        `INSERT INTO task_status_history (task_id, old_status, new_status, changed_by)
         VALUES ($1, $2, $3, $4)`,
        [req.params.id, oldTask.status, newStatus, req.user.id]
      );
      const statusLabels = { todo: 'Por hacer', in_progress: 'En progreso', completed: 'Completada', failed: 'Fallida', rejected: 'Rechazada' };
      await pool.query(
        `INSERT INTO task_logs (task_id, level, message) VALUES ($1, 'info', $2)`,
        [req.params.id, `Estado cambiado: ${statusLabels[oldTask.status] || oldTask.status} → ${statusLabels[newStatus] || newStatus}`]
      );
    }

    res.json({ task: result.rows[0] });
  } catch (err) {
    console.error('Update task error:', err.message);
    res.status(500).json({ error: 'Error al actualizar tarea' });
  }
});

// Delete task
app.delete('/api/tasks/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM tasks WHERE id = $1 AND created_by = $2 RETURNING id',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tarea no encontrada' });
    }
    res.json({ ok: true, deleted: result.rows[0].id });
  } catch (err) {
    console.error('Delete task error:', err.message);
    res.status(500).json({ error: 'Error al eliminar tarea' });
  }
});

// Reorder tasks
app.post('/api/tasks/reorder', requireAuth, async (req, res) => {
  try {
    const { task_ids } = req.body;
    if (!Array.isArray(task_ids) || task_ids.length === 0) {
      return res.status(400).json({ error: 'Se requiere lista de IDs' });
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (let i = 0; i < task_ids.length; i++) {
        await client.query(
          'UPDATE tasks SET sort_order = $1, updated_at = NOW() WHERE id = $2 AND created_by = $3',
          [i + 1, task_ids[i], req.user.id]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Reorder tasks error:', err.message);
    res.status(500).json({ error: 'Error al reordenar tareas' });
  }
});

// Add log to task
app.post('/api/tasks/:id/logs', requireAuth, async (req, res) => {
  try {
    const { level, message, metadata } = req.body;

    // Verify ownership
    const task = await pool.query('SELECT id FROM tasks WHERE id = $1 AND created_by = $2', [req.params.id, req.user.id]);
    if (task.rows.length === 0) {
      return res.status(404).json({ error: 'Tarea no encontrada' });
    }

    const result = await pool.query(
      `INSERT INTO task_logs (task_id, level, message, metadata) VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, level || 'info', message, JSON.stringify(metadata || {})]
    );

    res.status(201).json({ log: result.rows[0] });
  } catch (err) {
    console.error('Add log error:', err.message);
    res.status(500).json({ error: 'Error al agregar log' });
  }
});

// ====== AGENTS API ======

const agents = require('./lib/agents');

// List all agents with stats
app.get('/api/agents', requireAuth, async (req, res) => {
  try {
    const agentsWithStats = await agents.getAllAgentsWithStats();
    res.json({ agents: agentsWithStats });
  } catch (err) {
    console.error('List agents error:', err.message);
    res.status(500).json({ error: 'Error al cargar agentes' });
  }
});

// Get agent details
app.get('/api/agents/:id', requireAuth, async (req, res) => {
  try {
    const agentResult = await pool.query('SELECT * FROM agents WHERE id = $1', [req.params.id]);
    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agente no encontrado' });
    }

    const agent = agentResult.rows[0];
    const stats = await agents.getAgentStats(agent.id);
    const history = await agents.getAgentExecutionHistory(agent.id, 50);

    res.json({
      agent,
      stats,
      history
    });
  } catch (err) {
    console.error('Get agent error:', err.message);
    res.status(500).json({ error: 'Error al cargar agente' });
  }
});

// Get agent capabilities
app.get('/api/agents/:id/capabilities', requireAuth, async (req, res) => {
  try {
    const agentResult = await pool.query(
      'SELECT name, type, capabilities, mcp_requirements FROM agents WHERE id = $1',
      [req.params.id]
    );

    if (agentResult.rows.length === 0) {
      return res.status(404).json({ error: 'Agente no encontrado' });
    }

    const agent = agentResult.rows[0];
    res.json({
      name: agent.name,
      type: agent.type,
      capabilities: agent.capabilities,
      mcp_requirements: agent.mcp_requirements
    });
  } catch (err) {
    console.error('Get capabilities error:', err.message);
    res.status(500).json({ error: 'Error al cargar capacidades' });
  }
});

// Find best agent for a task
app.post('/api/agents/find-best', requireAuth, async (req, res) => {
  try {
    const { tag, title, description, complexity } = req.body;

    if (!title) {
      return res.status(400).json({ error: 'Título requerido' });
    }

    const task = { tag, title, description, complexity };
    const bestAgent = await agents.findBestAgent(task);

    if (!bestAgent) {
      return res.status(404).json({ error: 'No se encontró un agente disponible' });
    }

    res.json({ agent: bestAgent });
  } catch (err) {
    console.error('Find best agent error:', err.message);
    res.status(500).json({ error: 'Error al buscar agente' });
  }
});

// ====== DASHBOARD STATS ======

async function getTaskCounts(userId) {
  try {
    const result = await pool.query(
      `SELECT status, COUNT(*)::int as count FROM tasks WHERE created_by = $1 GROUP BY status`,
      [userId]
    );
    const counts = { todo: 0, in_progress: 0, completed: 0, failed: 0, rejected: 0 };
    result.rows.forEach(r => { counts[r.status] = r.count; });
    return counts;
  } catch (e) {
    return { todo: 0, in_progress: 0, completed: 0, failed: 0, rejected: 0 };
  }
}

async function getRecentTaskActivity(userId) {
  try {
    const result = await pool.query(
      `SELECT h.*, t.title as task_title FROM task_status_history h
       JOIN tasks t ON h.task_id = t.id
       WHERE t.created_by = $1
       ORDER BY h.created_at DESC LIMIT 10`,
      [userId]
    );
    return result.rows;
  } catch (e) {
    return [];
  }
}

app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    // Get billing info for stats
    const subResult = await pool.query(
      `SELECT s.plan_slug, sp.name as plan_name, sp.api_calls_daily, sp.llm_calls_daily
       FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_slug = sp.slug
       WHERE s.user_id = $1 AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
      [req.user.id]
    );
    const sub = subResult.rows[0] || { plan_slug: 'free', plan_name: 'Gratis', api_calls_daily: 100, llm_calls_daily: 10 };

    const usageResult = await pool.query(
      `SELECT COALESCE(SUM(api_calls), 0) as api_today, COALESCE(SUM(llm_calls), 0) as llm_today
       FROM usage_tracking WHERE user_id = $1 AND usage_date = CURRENT_DATE`,
      [req.user.id]
    );

    const creditsResult = await pool.query(
      `SELECT COALESCE(SUM(credits_total - credits_used), 0) as available
       FROM credits WHERE user_id = $1 AND period_end > NOW()`,
      [req.user.id]
    );

    const stats = {
      plan: sub.plan_name,
      plan_slug: sub.plan_slug,
      api_calls_today: parseInt(usageResult.rows[0].api_today),
      api_calls_limit: sub.api_calls_daily,
      llm_calls_today: parseInt(usageResult.rows[0].llm_today),
      llm_calls_limit: sub.llm_calls_daily,
      credits_available: parseInt(creditsResult.rows[0].available),
      agents: { active: 0, total: 0 },
      tasks: await getTaskCounts(req.user.id),
      recent_activity: await getRecentTaskActivity(req.user.id)
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Error al cargar estadísticas' });
  }
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

// Pricing page
app.get('/precios', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

// Tasks page (protected)
app.get('/tareas', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tasks.html'));
});

// Agents page (protected)
app.get('/agentes', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'agents.html'));
});

// Billing page (protected)
app.get('/facturacion', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'billing.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  console.error('Stack:', err.stack);

  // Don't leak error details in production
  const errorResponse = {
    error: process.env.NODE_ENV === 'production'
      ? 'Error interno del servidor'
      : err.message
  };

  res.status(500).json(errorResponse);
});

// Handle 404s
app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Process error handlers
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await pool.end();
  process.exit(0);
});

app.listen(port, () => {
  console.log(`Polsia ES running on port ${port}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Health check: http://localhost:${port}/health`);
});
