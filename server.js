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
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const logger = require('./lib/logger');

const app = express();
const port = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  logger.fatal('DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
  max: 20, // Maximum connections in pool
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Timeout connection attempts after 5s
});

// ====== SECURITY MIDDLEWARE ======

// Helmet: Security headers (CSP, X-Frame-Options, HSTS, etc.)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // Vite requires unsafe-inline for dev
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:", "blob:"],
      connectSrc: ["'self'", "https://api.stripe.com"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: []
    }
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  }
}));

// Compression: gzip for all responses
app.use(compression());

// General rate limiting (per IP)
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requests per 15 min per IP
  message: { error: 'Demasiadas solicitudes, intenta de nuevo más tarde' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(generalLimiter);

// Strict rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20, // 20 auth attempts per 15 min
  message: { error: 'Demasiados intentos de autenticación, intenta de nuevo en 15 minutos' },
  skipSuccessfulRequests: true,
});

// CSRF protection for state-changing operations
const csrfTokens = new Map(); // In-memory store (use Redis in production)
function generateCsrfToken() {
  return crypto.randomBytes(32).toString('hex');
}

function csrfProtection(req, res, next) {
  // Skip CSRF for API key auth (stateless)
  if (req.apiKeyUser) return next();

  // Skip for safe methods
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();

  const token = req.headers['x-csrf-token'] || req.body?._csrf;
  const sessionId = req.session?.id;

  if (!sessionId || !token || csrfTokens.get(sessionId) !== token) {
    return res.status(403).json({ error: 'Token CSRF inválido o faltante' });
  }

  next();
}

// Inject CSRF token into session
app.use((req, res, next) => {
  if (req.session?.id && !csrfTokens.has(req.session.id)) {
    const token = generateCsrfToken();
    csrfTokens.set(req.session.id, token);
    req.csrfToken = token;
  } else if (req.session?.id) {
    req.csrfToken = csrfTokens.get(req.session.id);
  }
  next();
});

// Cleanup old CSRF tokens (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, token] of csrfTokens.entries()) {
    // Remove tokens older than 1 hour (approximate, session-based cleanup is better)
    if (csrfTokens.size > 10000) { // Prevent memory leak
      csrfTokens.delete(sessionId);
    }
  }
}, 60 * 60 * 1000);

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

// Request logging middleware (structured JSON)
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.http(req, res, duration);
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

// Auth middleware (session-based)
function requireAuth(req, res, next) {
  if (req.session && req.session.userId) {
    return next();
  }
  // Check API key auth
  if (req.apiKeyUser) {
    req.user = req.apiKeyUser;
    return next();
  }
  if (req.headers.accept?.includes('application/json')) {
    return res.status(401).json({ error: 'No autenticado' });
  }
  res.redirect('/login');
}

// API key authentication middleware
async function apiKeyAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer pk_')) {
    return next();
  }

  const apiKey = authHeader.replace('Bearer ', '');
  try {
    const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');
    const result = await pool.query(
      `SELECT ak.*, u.id as uid, u.email, u.name, u.role, u.locale, u.theme
       FROM api_keys ak JOIN users u ON ak.user_id = u.id
       WHERE ak.key_hash = $1 AND ak.is_active = true
       AND (ak.expires_at IS NULL OR ak.expires_at > NOW())`,
      [keyHash]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Clave API inválida o expirada' });
    }

    const keyRow = result.rows[0];

    // Rate limiting check
    const windowStart = new Date();
    windowStart.setSeconds(0, 0);

    const rateResult = await pool.query(
      `INSERT INTO api_rate_limits (api_key_id, window_start, request_count)
       VALUES ($1, $2, 1)
       ON CONFLICT (api_key_id, window_start)
       DO UPDATE SET request_count = api_rate_limits.request_count + 1
       RETURNING request_count`,
      [keyRow.id, windowStart]
    );

    if (rateResult.rows[0].request_count > keyRow.rate_limit_per_minute) {
      return res.status(429).json({
        error: 'Límite de tasa excedido',
        limit: keyRow.rate_limit_per_minute,
        retry_after: 60
      });
    }

    // Update last used
    pool.query('UPDATE api_keys SET last_used_at = NOW() WHERE id = $1', [keyRow.id]).catch(() => {});

    req.apiKeyUser = {
      id: keyRow.uid,
      email: keyRow.email,
      name: keyRow.name,
      role: keyRow.role,
      locale: keyRow.locale,
      theme: keyRow.theme
    };
    req.apiKeyId = keyRow.id;
    req.apiKeyScopes = keyRow.scopes || ['read', 'write'];
  } catch (err) {
    console.error('API key auth error:', err.message);
  }
  next();
}

// Scope check middleware factory
function requireScope(scope) {
  return (req, res, next) => {
    if (req.apiKeyId && !req.apiKeyScopes?.includes(scope)) {
      return res.status(403).json({ error: `Scope requerido: ${scope}` });
    }
    next();
  };
}

// Consistent error response helper
function apiError(res, status, message, details = null) {
  const response = {
    ok: false,
    error: message,
    timestamp: new Date().toISOString()
  };
  if (details) response.details = details;
  return res.status(status).json(response);
}

function apiSuccess(res, data, status = 200) {
  return res.status(status).json({
    ok: true,
    ...data,
    timestamp: new Date().toISOString()
  });
}

// API key auth (before user loading)
app.use(apiKeyAuth);

// Make user data available to all requests
app.use(async (req, res, next) => {
  if (req.apiKeyUser) {
    req.user = req.apiKeyUser;
    return next();
  }
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

app.post('/api/auth/signup', authLimiter, async (req, res) => {
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

app.post('/api/auth/login', authLimiter, async (req, res) => {
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

// ====== API KEY MANAGEMENT ======

// Generate new API key
app.post('/api/keys', requireAuth, async (req, res) => {
  try {
    const { name, scopes, rate_limit_per_minute, expires_in_days } = req.body;

    // Generate a secure API key
    const rawKey = 'pk_' + crypto.randomBytes(32).toString('hex');
    const keyHash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const keyPrefix = rawKey.substring(0, 10);

    let expiresAt = null;
    if (expires_in_days) {
      expiresAt = new Date(Date.now() + expires_in_days * 24 * 60 * 60 * 1000);
    }

    const result = await pool.query(
      `INSERT INTO api_keys (user_id, key_hash, key_prefix, name, scopes, rate_limit_per_minute, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, key_prefix, name, scopes, rate_limit_per_minute, expires_at, created_at`,
      [
        req.user.id, keyHash, keyPrefix,
        name || 'default',
        JSON.stringify(scopes || ['read', 'write']),
        rate_limit_per_minute || 60,
        expiresAt
      ]
    );

    // Return the full key ONLY on creation — never shown again
    apiSuccess(res, {
      api_key: rawKey,
      key_info: result.rows[0],
      warning: 'Guarda esta clave. No se mostrará de nuevo.'
    }, 201);
  } catch (err) {
    console.error('Create API key error:', err.message);
    apiError(res, 500, 'Error al crear clave API');
  }
});

// List API keys
app.get('/api/keys', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, key_prefix, name, scopes, rate_limit_per_minute, last_used_at, expires_at, is_active, created_at
       FROM api_keys WHERE user_id = $1 ORDER BY created_at DESC`,
      [req.user.id]
    );
    apiSuccess(res, { keys: result.rows });
  } catch (err) {
    apiError(res, 500, 'Error al cargar claves API');
  }
});

// Revoke API key
app.delete('/api/keys/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE api_keys SET is_active = false, updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id, key_prefix',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return apiError(res, 404, 'Clave API no encontrada');
    }
    apiSuccess(res, { revoked: result.rows[0] });
  } catch (err) {
    apiError(res, 500, 'Error al revocar clave API');
  }
});

// ====== SKILLS API ======

// Search/list skills
app.get('/api/skills', requireAuth, async (req, res) => {
  try {
    const { q, agent_type, active, limit = 50, offset = 0 } = req.query;

    let query = 'SELECT id, name, summary, keywords, agent_types, version, is_active, created_at, updated_at FROM skills WHERE 1=1';
    const params = [];
    let paramIdx = 1;

    if (q) {
      query += ` AND (name ILIKE $${paramIdx} OR summary ILIKE $${paramIdx} OR keywords::text ILIKE $${paramIdx})`;
      params.push(`%${q}%`);
      paramIdx++;
    }

    if (agent_type) {
      query += ` AND agent_types @> $${paramIdx}::jsonb`;
      params.push(JSON.stringify([agent_type]));
      paramIdx++;
    }

    if (active !== undefined) {
      query += ` AND is_active = $${paramIdx}`;
      params.push(active === 'true');
      paramIdx++;
    }

    query += ` ORDER BY name ASC LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    // Get total count
    let countQuery = 'SELECT COUNT(*)::int as total FROM skills WHERE 1=1';
    const countParams = [];
    let cIdx = 1;
    if (q) {
      countQuery += ` AND (name ILIKE $${cIdx} OR summary ILIKE $${cIdx} OR keywords::text ILIKE $${cIdx})`;
      countParams.push(`%${q}%`);
      cIdx++;
    }
    if (agent_type) {
      countQuery += ` AND agent_types @> $${cIdx}::jsonb`;
      countParams.push(JSON.stringify([agent_type]));
      cIdx++;
    }
    if (active !== undefined) {
      countQuery += ` AND is_active = $${cIdx}`;
      countParams.push(active === 'true');
    }

    const countResult = await pool.query(countQuery, countParams);

    apiSuccess(res, {
      skills: result.rows,
      total: countResult.rows[0].total,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) {
    console.error('List skills error:', err.message);
    apiError(res, 500, 'Error al buscar skills');
  }
});

// Get single skill (with full content)
app.get('/api/skills/:id', requireAuth, async (req, res) => {
  try {
    const isNumeric = /^\d+$/.test(req.params.id);
    const query = isNumeric
      ? 'SELECT * FROM skills WHERE id = $1'
      : 'SELECT * FROM skills WHERE name = $1';

    const result = await pool.query(query, [req.params.id]);
    if (result.rows.length === 0) {
      return apiError(res, 404, 'Skill no encontrado');
    }
    apiSuccess(res, { skill: result.rows[0] });
  } catch (err) {
    apiError(res, 500, 'Error al cargar skill');
  }
});

// Create skill
app.post('/api/skills', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const { name, summary, content, keywords, agent_types } = req.body;

    if (!name || !content) {
      return apiError(res, 400, 'Nombre y contenido son requeridos');
    }

    const result = await pool.query(
      `INSERT INTO skills (name, summary, content, keywords, agent_types, created_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        name.trim().toLowerCase().replace(/\s+/g, '-'),
        summary || '',
        content,
        JSON.stringify(keywords || []),
        JSON.stringify(agent_types || []),
        req.user.id
      ]
    );

    apiSuccess(res, { skill: result.rows[0] }, 201);
  } catch (err) {
    if (err.code === '23505') {
      return apiError(res, 409, 'Ya existe un skill con ese nombre');
    }
    console.error('Create skill error:', err.message);
    apiError(res, 500, 'Error al crear skill');
  }
});

// Update skill
app.put('/api/skills/:id', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const { summary, content, keywords, agent_types } = req.body;

    const existing = await pool.query('SELECT * FROM skills WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return apiError(res, 404, 'Skill no encontrado');
    }

    const old = existing.rows[0];
    const result = await pool.query(
      `UPDATE skills SET
        summary = $1, content = $2, keywords = $3, agent_types = $4,
        version = version + 1, updated_at = NOW()
       WHERE id = $5 RETURNING *`,
      [
        summary !== undefined ? summary : old.summary,
        content !== undefined ? content : old.content,
        JSON.stringify(keywords || old.keywords),
        JSON.stringify(agent_types || old.agent_types),
        req.params.id
      ]
    );

    apiSuccess(res, { skill: result.rows[0] });
  } catch (err) {
    console.error('Update skill error:', err.message);
    apiError(res, 500, 'Error al actualizar skill');
  }
});

// Delete skill (soft delete)
app.delete('/api/skills/:id', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE skills SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id, name',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return apiError(res, 404, 'Skill no encontrado');
    }
    apiSuccess(res, { deleted: result.rows[0] });
  } catch (err) {
    apiError(res, 500, 'Error al eliminar skill');
  }
});

// ====== MCP SERVER REGISTRY ======

// List MCP servers
app.get('/api/mcp', requireAuth, async (req, res) => {
  try {
    const { active, transport } = req.query;

    let query = 'SELECT * FROM mcp_servers WHERE 1=1';
    const params = [];
    let idx = 1;

    if (active !== undefined) {
      query += ` AND is_active = $${idx}`;
      params.push(active === 'true');
      idx++;
    }
    if (transport) {
      query += ` AND transport_type = $${idx}`;
      params.push(transport);
      idx++;
    }

    query += ' ORDER BY name ASC';
    const result = await pool.query(query, params);

    // Get agent mappings for each server
    const serversWithAgents = await Promise.all(result.rows.map(async (server) => {
      const agentResult = await pool.query(
        `SELECT a.id, a.name, a.type, ams.is_required
         FROM agent_mcp_servers ams JOIN agents a ON ams.agent_id = a.id
         WHERE ams.mcp_server_id = $1`,
        [server.id]
      );
      return { ...server, mapped_agents: agentResult.rows };
    }));

    apiSuccess(res, { mcp_servers: serversWithAgents });
  } catch (err) {
    console.error('List MCP servers error:', err.message);
    apiError(res, 500, 'Error al cargar servidores MCP');
  }
});

// Get single MCP server
app.get('/api/mcp/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM mcp_servers WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) {
      return apiError(res, 404, 'Servidor MCP no encontrado');
    }

    const server = result.rows[0];
    const agentResult = await pool.query(
      `SELECT a.id, a.name, a.type, ams.is_required, ams.config_overrides
       FROM agent_mcp_servers ams JOIN agents a ON ams.agent_id = a.id
       WHERE ams.mcp_server_id = $1`,
      [req.params.id]
    );

    apiSuccess(res, { mcp_server: server, mapped_agents: agentResult.rows });
  } catch (err) {
    apiError(res, 500, 'Error al cargar servidor MCP');
  }
});

// Register MCP server
app.post('/api/mcp', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const { name, description, server_url, transport_type, config, tools, oauth_required, oauth_config } = req.body;

    if (!name) {
      return apiError(res, 400, 'Nombre es requerido');
    }

    const result = await pool.query(
      `INSERT INTO mcp_servers (name, description, server_url, transport_type, config, tools, oauth_required, oauth_config)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        name.trim().toLowerCase().replace(/\s+/g, '_'),
        description || '',
        server_url || null,
        transport_type || 'stdio',
        JSON.stringify(config || {}),
        JSON.stringify(tools || []),
        oauth_required || false,
        JSON.stringify(oauth_config || {})
      ]
    );

    apiSuccess(res, { mcp_server: result.rows[0] }, 201);
  } catch (err) {
    if (err.code === '23505') {
      return apiError(res, 409, 'Ya existe un servidor MCP con ese nombre');
    }
    console.error('Create MCP server error:', err.message);
    apiError(res, 500, 'Error al registrar servidor MCP');
  }
});

// Update MCP server
app.put('/api/mcp/:id', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const { description, server_url, transport_type, config, tools, oauth_required, oauth_config, is_active } = req.body;

    const existing = await pool.query('SELECT * FROM mcp_servers WHERE id = $1', [req.params.id]);
    if (existing.rows.length === 0) {
      return apiError(res, 404, 'Servidor MCP no encontrado');
    }

    const old = existing.rows[0];
    const result = await pool.query(
      `UPDATE mcp_servers SET
        description = $1, server_url = $2, transport_type = $3, config = $4,
        tools = $5, oauth_required = $6, oauth_config = $7, is_active = $8, updated_at = NOW()
       WHERE id = $9 RETURNING *`,
      [
        description !== undefined ? description : old.description,
        server_url !== undefined ? server_url : old.server_url,
        transport_type || old.transport_type,
        JSON.stringify(config || old.config),
        JSON.stringify(tools || old.tools),
        oauth_required !== undefined ? oauth_required : old.oauth_required,
        JSON.stringify(oauth_config || old.oauth_config),
        is_active !== undefined ? is_active : old.is_active,
        req.params.id
      ]
    );

    apiSuccess(res, { mcp_server: result.rows[0] });
  } catch (err) {
    console.error('Update MCP server error:', err.message);
    apiError(res, 500, 'Error al actualizar servidor MCP');
  }
});

// Delete MCP server (soft delete)
app.delete('/api/mcp/:id', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const result = await pool.query(
      'UPDATE mcp_servers SET is_active = false, updated_at = NOW() WHERE id = $1 RETURNING id, name',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return apiError(res, 404, 'Servidor MCP no encontrado');
    }
    apiSuccess(res, { deleted: result.rows[0] });
  } catch (err) {
    apiError(res, 500, 'Error al eliminar servidor MCP');
  }
});

// Map MCP server to agent
app.post('/api/mcp/:id/agents', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const { agent_id, is_required, config_overrides } = req.body;

    if (!agent_id) {
      return apiError(res, 400, 'agent_id es requerido');
    }

    const result = await pool.query(
      `INSERT INTO agent_mcp_servers (agent_id, mcp_server_id, is_required, config_overrides)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, mcp_server_id) DO UPDATE SET is_required = $3, config_overrides = $4
       RETURNING *`,
      [agent_id, req.params.id, is_required || false, JSON.stringify(config_overrides || {})]
    );

    apiSuccess(res, { mapping: result.rows[0] }, 201);
  } catch (err) {
    console.error('Map MCP to agent error:', err.message);
    apiError(res, 500, 'Error al mapear servidor MCP a agente');
  }
});

// Remove MCP-agent mapping
app.delete('/api/mcp/:id/agents/:agentId', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM agent_mcp_servers WHERE mcp_server_id = $1 AND agent_id = $2 RETURNING id',
      [req.params.id, req.params.agentId]
    );
    if (result.rows.length === 0) {
      return apiError(res, 404, 'Mapeo no encontrado');
    }
    apiSuccess(res, { ok: true });
  } catch (err) {
    apiError(res, 500, 'Error al eliminar mapeo');
  }
});

// ====== COMPANIES API ======

// List companies
app.get('/api/companies', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM companies WHERE owner_id = $1 ORDER BY created_at DESC',
      [req.user.id]
    );
    apiSuccess(res, { companies: result.rows });
  } catch (err) {
    apiError(res, 500, 'Error al cargar empresas');
  }
});

// Get single company
app.get('/api/companies/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM companies WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return apiError(res, 404, 'Empresa no encontrada');
    }
    apiSuccess(res, { company: result.rows[0] });
  } catch (err) {
    apiError(res, 500, 'Error al cargar empresa');
  }
});

// Create company
app.post('/api/companies', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const { name, slug, plan, locale, metadata } = req.body;

    if (!name) {
      return apiError(res, 400, 'Nombre es requerido');
    }

    // Check company limit
    const countResult = await pool.query(
      'SELECT COUNT(*)::int as count FROM companies WHERE owner_id = $1',
      [req.user.id]
    );
    const subResult = await pool.query(
      `SELECT sp.max_companies FROM subscriptions s
       JOIN subscription_plans sp ON s.plan_slug = sp.slug
       WHERE s.user_id = $1 AND s.status = 'active'
       ORDER BY s.created_at DESC LIMIT 1`,
      [req.user.id]
    );
    const maxCompanies = subResult.rows[0]?.max_companies || 1;
    if (maxCompanies > 0 && countResult.rows[0].count >= maxCompanies) {
      return apiError(res, 403, `Límite de empresas alcanzado (${maxCompanies}). Actualiza tu plan.`);
    }

    const companySlug = slug || name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

    const result = await pool.query(
      `INSERT INTO companies (name, slug, owner_id, plan, locale, metadata)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [name.trim(), companySlug, req.user.id, plan || 'free', locale || 'es', JSON.stringify(metadata || {})]
    );

    apiSuccess(res, { company: result.rows[0] }, 201);
  } catch (err) {
    if (err.code === '23505') {
      return apiError(res, 409, 'Ya existe una empresa con ese slug');
    }
    console.error('Create company error:', err.message);
    apiError(res, 500, 'Error al crear empresa');
  }
});

// Update company
app.put('/api/companies/:id', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const { name, plan, locale, metadata } = req.body;

    const existing = await pool.query(
      'SELECT * FROM companies WHERE id = $1 AND owner_id = $2',
      [req.params.id, req.user.id]
    );
    if (existing.rows.length === 0) {
      return apiError(res, 404, 'Empresa no encontrada');
    }

    const old = existing.rows[0];
    const result = await pool.query(
      `UPDATE companies SET name = $1, plan = $2, locale = $3, metadata = $4, updated_at = NOW()
       WHERE id = $5 AND owner_id = $6 RETURNING *`,
      [
        name || old.name,
        plan || old.plan,
        locale || old.locale,
        JSON.stringify(metadata || old.metadata),
        req.params.id,
        req.user.id
      ]
    );

    apiSuccess(res, { company: result.rows[0] });
  } catch (err) {
    apiError(res, 500, 'Error al actualizar empresa');
  }
});

// Delete company
app.delete('/api/companies/:id', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const result = await pool.query(
      'DELETE FROM companies WHERE id = $1 AND owner_id = $2 RETURNING id, name',
      [req.params.id, req.user.id]
    );
    if (result.rows.length === 0) {
      return apiError(res, 404, 'Empresa no encontrada');
    }
    apiSuccess(res, { deleted: result.rows[0] });
  } catch (err) {
    apiError(res, 500, 'Error al eliminar empresa');
  }
});

// ====== EXECUTIONS API ======

// List executions (agent execution logs)
app.get('/api/executions', requireAuth, async (req, res) => {
  try {
    const { agent_id, status, success, limit = 50, offset = 0 } = req.query;

    let query = `SELECT ae.*, a.name as agent_name, a.type as agent_type,
                        t.title as task_title, t.tag as task_tag
                 FROM agent_executions ae
                 JOIN agents a ON ae.agent_id = a.id
                 LEFT JOIN tasks t ON ae.task_id = t.id
                 WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (agent_id) {
      query += ` AND ae.agent_id = $${idx}`;
      params.push(agent_id);
      idx++;
    }
    if (status) {
      query += ` AND ae.status = $${idx}`;
      params.push(status);
      idx++;
    }
    if (success !== undefined) {
      query += ` AND ae.success = $${idx}`;
      params.push(success === 'true');
      idx++;
    }

    query += ` ORDER BY ae.started_at DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await pool.query(query, params);

    apiSuccess(res, {
      executions: result.rows,
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) {
    console.error('List executions error:', err.message);
    apiError(res, 500, 'Error al cargar ejecuciones');
  }
});

// Get single execution
app.get('/api/executions/:id', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ae.*, a.name as agent_name, a.type as agent_type,
              t.title as task_title, t.tag as task_tag, t.description as task_description
       FROM agent_executions ae
       JOIN agents a ON ae.agent_id = a.id
       LEFT JOIN tasks t ON ae.task_id = t.id
       WHERE ae.id = $1`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return apiError(res, 404, 'Ejecución no encontrada');
    }
    apiSuccess(res, { execution: result.rows[0] });
  } catch (err) {
    apiError(res, 500, 'Error al cargar ejecución');
  }
});

// ====== OPENAPI DOCUMENTATION ======

app.get('/api/docs/openapi.json', (req, res) => {
  res.json({
    openapi: '3.0.3',
    info: {
      title: 'Polsia ES API',
      description: 'API pública de Polsia ES — gestión de empresas, tareas, agentes, skills y servidores MCP.',
      version: '1.0.0',
      contact: { email: 'soporte@polsia.app' }
    },
    servers: [
      { url: process.env.APP_URL || `${req.protocol}://${req.get('host')}`, description: 'Producción' }
    ],
    components: {
      securitySchemes: {
        sessionAuth: { type: 'apiKey', in: 'cookie', name: 'connect.sid', description: 'Autenticación por sesión (cookie)' },
        apiKeyAuth: { type: 'http', scheme: 'bearer', description: 'Clave API (Bearer pk_xxx...)' }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', example: false },
            error: { type: 'string' },
            timestamp: { type: 'string', format: 'date-time' }
          }
        },
        Skill: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            summary: { type: 'string' },
            content: { type: 'string' },
            keywords: { type: 'array', items: { type: 'string' } },
            agent_types: { type: 'array', items: { type: 'string' } },
            version: { type: 'integer' },
            is_active: { type: 'boolean' }
          }
        },
        McpServer: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            description: { type: 'string' },
            transport_type: { type: 'string' },
            tools: { type: 'array', items: { type: 'string' } },
            oauth_required: { type: 'boolean' },
            is_active: { type: 'boolean' }
          }
        },
        ApiKey: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            key_prefix: { type: 'string' },
            name: { type: 'string' },
            scopes: { type: 'array', items: { type: 'string' } },
            rate_limit_per_minute: { type: 'integer' },
            is_active: { type: 'boolean' }
          }
        }
      }
    },
    security: [{ sessionAuth: [] }, { apiKeyAuth: [] }],
    paths: {
      '/api/auth/signup': {
        post: { tags: ['Autenticación'], summary: 'Crear cuenta', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' }, name: { type: 'string' }, referral_code: { type: 'string' } } } } } }, responses: { '201': { description: 'Cuenta creada' }, '409': { description: 'Email ya registrado' } } }
      },
      '/api/auth/login': {
        post: { tags: ['Autenticación'], summary: 'Iniciar sesión', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' } } } } } }, responses: { '200': { description: 'Sesión iniciada' } } }
      },
      '/api/auth/me': {
        get: { tags: ['Autenticación'], summary: 'Obtener usuario actual', responses: { '200': { description: 'Datos del usuario' }, '401': { description: 'No autenticado' } } }
      },
      '/api/keys': {
        get: { tags: ['Claves API'], summary: 'Listar claves API', responses: { '200': { description: 'Lista de claves' } } },
        post: { tags: ['Claves API'], summary: 'Generar nueva clave API', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, scopes: { type: 'array', items: { type: 'string' } }, rate_limit_per_minute: { type: 'integer' }, expires_in_days: { type: 'integer' } } } } } }, responses: { '201': { description: 'Clave creada (se muestra UNA sola vez)' } } }
      },
      '/api/keys/{id}': {
        delete: { tags: ['Claves API'], summary: 'Revocar clave API', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Clave revocada' } } }
      },
      '/api/skills': {
        get: { tags: ['Skills'], summary: 'Buscar/listar skills', parameters: [{ name: 'q', in: 'query', schema: { type: 'string' }, description: 'Búsqueda por nombre, resumen o keywords' }, { name: 'agent_type', in: 'query', schema: { type: 'string' }, description: 'Filtrar por tipo de agente' }, { name: 'limit', in: 'query', schema: { type: 'integer', default: 50 } }, { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } }], responses: { '200': { description: 'Lista de skills' } } },
        post: { tags: ['Skills'], summary: 'Crear skill', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name', 'content'], properties: { name: { type: 'string' }, summary: { type: 'string' }, content: { type: 'string' }, keywords: { type: 'array', items: { type: 'string' } }, agent_types: { type: 'array', items: { type: 'string' } } } } } } }, responses: { '201': { description: 'Skill creado' } } }
      },
      '/api/skills/{id}': {
        get: { tags: ['Skills'], summary: 'Obtener skill por ID o nombre', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'Detalle del skill' } } },
        put: { tags: ['Skills'], summary: 'Actualizar skill', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Skill actualizado' } } },
        delete: { tags: ['Skills'], summary: 'Eliminar skill', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Skill eliminado' } } }
      },
      '/api/mcp': {
        get: { tags: ['Servidores MCP'], summary: 'Listar servidores MCP', parameters: [{ name: 'active', in: 'query', schema: { type: 'boolean' } }, { name: 'transport', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Lista de servidores MCP con agentes mapeados' } } },
        post: { tags: ['Servidores MCP'], summary: 'Registrar servidor MCP', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, description: { type: 'string' }, server_url: { type: 'string' }, transport_type: { type: 'string' }, tools: { type: 'array', items: { type: 'string' } }, oauth_required: { type: 'boolean' } } } } } }, responses: { '201': { description: 'Servidor registrado' } } }
      },
      '/api/mcp/{id}': {
        get: { tags: ['Servidores MCP'], summary: 'Obtener servidor MCP', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Detalle del servidor MCP' } } },
        put: { tags: ['Servidores MCP'], summary: 'Actualizar servidor MCP', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Servidor actualizado' } } },
        delete: { tags: ['Servidores MCP'], summary: 'Desactivar servidor MCP', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Servidor desactivado' } } }
      },
      '/api/mcp/{id}/agents': {
        post: { tags: ['Servidores MCP'], summary: 'Mapear servidor MCP a agente', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['agent_id'], properties: { agent_id: { type: 'integer' }, is_required: { type: 'boolean' } } } } } }, responses: { '201': { description: 'Mapeo creado' } } }
      },
      '/api/companies': {
        get: { tags: ['Empresas'], summary: 'Listar empresas', responses: { '200': { description: 'Lista de empresas' } } },
        post: { tags: ['Empresas'], summary: 'Crear empresa', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' }, slug: { type: 'string' }, plan: { type: 'string' }, locale: { type: 'string' } } } } } }, responses: { '201': { description: 'Empresa creada' } } }
      },
      '/api/companies/{id}': {
        get: { tags: ['Empresas'], summary: 'Obtener empresa', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Detalle de la empresa' } } },
        put: { tags: ['Empresas'], summary: 'Actualizar empresa', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Empresa actualizada' } } },
        delete: { tags: ['Empresas'], summary: 'Eliminar empresa', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Empresa eliminada' } } }
      },
      '/api/tasks': {
        get: { tags: ['Tareas'], summary: 'Listar tareas con filtros', parameters: [{ name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'tag', in: 'query', schema: { type: 'string' } }, { name: 'priority', in: 'query', schema: { type: 'string' } }, { name: 'search', in: 'query', schema: { type: 'string' } }], responses: { '200': { description: 'Lista de tareas' } } },
        post: { tags: ['Tareas'], summary: 'Crear tarea', responses: { '201': { description: 'Tarea creada' } } }
      },
      '/api/agents': {
        get: { tags: ['Agentes'], summary: 'Listar agentes con estadísticas', responses: { '200': { description: 'Lista de agentes' } } }
      },
      '/api/agents/find-best': {
        post: { tags: ['Agentes'], summary: 'Encontrar mejor agente para tarea', requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['title'], properties: { tag: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' }, complexity: { type: 'integer' } } } } } }, responses: { '200': { description: 'Mejor agente encontrado' } } }
      },
      '/api/executions': {
        get: { tags: ['Ejecuciones'], summary: 'Listar ejecuciones de agentes', parameters: [{ name: 'agent_id', in: 'query', schema: { type: 'integer' } }, { name: 'status', in: 'query', schema: { type: 'string' } }, { name: 'success', in: 'query', schema: { type: 'boolean' } }], responses: { '200': { description: 'Lista de ejecuciones' } } }
      },
      '/api/executions/{id}': {
        get: { tags: ['Ejecuciones'], summary: 'Obtener ejecución', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'Detalle de la ejecución' } } }
      },
      '/api/billing': {
        get: { tags: ['Facturación'], summary: 'Obtener suscripción y uso actual', responses: { '200': { description: 'Datos de facturación' } } }
      },
      '/api/dashboard/stats': {
        get: { tags: ['Dashboard'], summary: 'Estadísticas del dashboard', responses: { '200': { description: 'Estadísticas generales' } } }
      },
      '/health': {
        get: { tags: ['Sistema'], summary: 'Estado de salud del sistema', security: [], responses: { '200': { description: 'Sistema saludable' }, '503': { description: 'Sistema degradado' } } }
      }
    },
    tags: [
      { name: 'Autenticación', description: 'Registro, login y gestión de sesión' },
      { name: 'Claves API', description: 'Generar y gestionar claves de acceso API' },
      { name: 'Skills', description: 'Procedimientos reutilizables para agentes' },
      { name: 'Servidores MCP', description: 'Registro de servidores Model Context Protocol' },
      { name: 'Empresas', description: 'Gestión de empresas (CRUD)' },
      { name: 'Tareas', description: 'Ciclo de vida completo de tareas' },
      { name: 'Agentes', description: 'Registro y enrutamiento de agentes IA' },
      { name: 'Ejecuciones', description: 'Historial de ejecuciones de agentes' },
      { name: 'Facturación', description: 'Suscripciones, créditos y uso' },
      { name: 'Dashboard', description: 'Estadísticas generales' },
      { name: 'Sistema', description: 'Salud y monitoreo' }
    ]
  });
});

// ====== MEMORY SYSTEM API ======

const MEMORY_LAYER_CONFIG = {
  1: { name: 'Conocimiento del Dominio', maxTokens: 15000, autoOnly: true },
  2: { name: 'Misión y Preferencias', maxTokens: 3000, autoOnly: false },
  3: { name: 'Patrones Globales', maxTokens: 15000, autoOnly: true }
};

// Rough token count estimator (~4 chars per token for Spanish text)
function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

// Ensure memory layers exist for a company
async function ensureMemoryLayers(companyId) {
  for (const layer of [1, 2, 3]) {
    const config = MEMORY_LAYER_CONFIG[layer];
    await pool.query(
      `INSERT INTO memory_layers (company_id, layer, title, content, token_count, max_tokens)
       VALUES ($1, $2, $3, '', 0, $4)
       ON CONFLICT (company_id, layer) DO NOTHING`,
      [companyId, layer, config.name, config.maxTokens]
    );
  }
}

// Search across all memory layers (keyword matching + full-text search)
app.get('/api/memory/search', requireAuth, async (req, res) => {
  try {
    const { query, company_id, limit = 10 } = req.query;

    if (!query) {
      return apiError(res, 400, 'Parámetro query es requerido');
    }

    // Get company to search (first company if not specified)
    let targetCompanyId = company_id;
    if (!targetCompanyId) {
      const compResult = await pool.query(
        'SELECT id FROM companies WHERE owner_id = $1 ORDER BY created_at ASC LIMIT 1',
        [req.user.id]
      );
      if (compResult.rows.length === 0) {
        return apiSuccess(res, { results: [], query });
      }
      targetCompanyId = compResult.rows[0].id;
    }

    await ensureMemoryLayers(targetCompanyId);

    // Full-text search with ranking + fallback to ILIKE keyword search
    const result = await pool.query(
      `SELECT
        layer, title, content, token_count, max_tokens, updated_at,
        ts_rank(search_vector, plainto_tsquery('spanish', $1)) as rank,
        CASE
          WHEN content ILIKE '%' || $1 || '%' THEN 1
          ELSE 0
        END as keyword_match
       FROM memory_layers
       WHERE company_id = $2
         AND (
           search_vector @@ plainto_tsquery('spanish', $1)
           OR content ILIKE '%' || $1 || '%'
           OR title ILIKE '%' || $1 || '%'
         )
       ORDER BY rank DESC, keyword_match DESC, updated_at DESC
       LIMIT $3`,
      [query, targetCompanyId, parseInt(limit)]
    );

    // Format results with layer names
    const results = result.rows.map(row => ({
      layer: row.layer,
      layer_name: MEMORY_LAYER_CONFIG[row.layer]?.name || `Capa ${row.layer}`,
      content: row.content,
      token_count: row.token_count,
      max_tokens: row.max_tokens,
      relevance: Math.round((row.rank + row.keyword_match) * 100) / 100,
      updated_at: row.updated_at
    }));

    apiSuccess(res, { results, query, company_id: targetCompanyId });
  } catch (err) {
    console.error('Memory search error:', err.message);
    apiError(res, 500, 'Error al buscar en memoria');
  }
});

// Read full content of a specific memory layer
app.get('/api/memory/layer/:layer', requireAuth, async (req, res) => {
  try {
    const layer = parseInt(req.params.layer);
    if (![1, 2, 3].includes(layer)) {
      return apiError(res, 400, 'Capa debe ser 1, 2 o 3');
    }

    const { company_id } = req.query;
    let targetCompanyId = company_id;
    if (!targetCompanyId) {
      const compResult = await pool.query(
        'SELECT id FROM companies WHERE owner_id = $1 ORDER BY created_at ASC LIMIT 1',
        [req.user.id]
      );
      if (compResult.rows.length === 0) {
        return apiError(res, 404, 'Sin empresas registradas');
      }
      targetCompanyId = compResult.rows[0].id;
    }

    await ensureMemoryLayers(targetCompanyId);

    const result = await pool.query(
      `SELECT layer, title, content, token_count, max_tokens, metadata, updated_at
       FROM memory_layers WHERE company_id = $1 AND layer = $2`,
      [targetCompanyId, layer]
    );

    if (result.rows.length === 0) {
      return apiError(res, 404, 'Capa de memoria no encontrada');
    }

    const row = result.rows[0];
    apiSuccess(res, {
      layer: row.layer,
      layer_name: MEMORY_LAYER_CONFIG[layer].name,
      content: row.content,
      token_count: row.token_count,
      max_tokens: row.max_tokens,
      usage_percent: row.max_tokens > 0 ? Math.round((row.token_count / row.max_tokens) * 100) : 0,
      metadata: row.metadata,
      updated_at: row.updated_at
    });
  } catch (err) {
    console.error('Memory read error:', err.message);
    apiError(res, 500, 'Error al leer capa de memoria');
  }
});

// Read all 3 memory layers overview
app.get('/api/memory/layers', requireAuth, async (req, res) => {
  try {
    const { company_id } = req.query;
    let targetCompanyId = company_id;
    if (!targetCompanyId) {
      const compResult = await pool.query(
        'SELECT id FROM companies WHERE owner_id = $1 ORDER BY created_at ASC LIMIT 1',
        [req.user.id]
      );
      if (compResult.rows.length === 0) {
        return apiSuccess(res, { layers: [] });
      }
      targetCompanyId = compResult.rows[0].id;
    }

    await ensureMemoryLayers(targetCompanyId);

    const result = await pool.query(
      `SELECT layer, title, content, token_count, max_tokens, metadata, updated_at
       FROM memory_layers WHERE company_id = $1 ORDER BY layer ASC`,
      [targetCompanyId]
    );

    const layers = result.rows.map(row => ({
      layer: row.layer,
      layer_name: MEMORY_LAYER_CONFIG[row.layer]?.name || `Capa ${row.layer}`,
      content: row.content,
      token_count: row.token_count,
      max_tokens: row.max_tokens,
      usage_percent: row.max_tokens > 0 ? Math.round((row.token_count / row.max_tokens) * 100) : 0,
      metadata: row.metadata,
      updated_at: row.updated_at,
      editable: !MEMORY_LAYER_CONFIG[row.layer]?.autoOnly
    }));

    apiSuccess(res, { layers, company_id: targetCompanyId });
  } catch (err) {
    console.error('Memory layers error:', err.message);
    apiError(res, 500, 'Error al cargar capas de memoria');
  }
});

// Update memory layer content (Layer 2 only for manual/CEO updates, Layer 1 & 3 for system)
app.put('/api/memory/layer/:layer', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const layer = parseInt(req.params.layer);
    if (![1, 2, 3].includes(layer)) {
      return apiError(res, 400, 'Capa debe ser 1, 2 o 3');
    }

    const { content, company_id, actor = 'user' } = req.body;
    if (content === undefined || content === null) {
      return apiError(res, 400, 'Contenido es requerido');
    }

    // Only allow manual edits to Layer 2 (unless system/agent actor)
    const isSystem = actor === 'system' || actor === 'agent';
    if (!isSystem && MEMORY_LAYER_CONFIG[layer].autoOnly) {
      return apiError(res, 403, `Capa ${layer} solo puede ser actualizada por el sistema automáticamente`);
    }

    let targetCompanyId = company_id;
    if (!targetCompanyId) {
      const compResult = await pool.query(
        'SELECT id FROM companies WHERE owner_id = $1 ORDER BY created_at ASC LIMIT 1',
        [req.user.id]
      );
      if (compResult.rows.length === 0) {
        return apiError(res, 404, 'Sin empresas registradas');
      }
      targetCompanyId = compResult.rows[0].id;
    }

    await ensureMemoryLayers(targetCompanyId);

    // Check token budget
    const newTokenCount = estimateTokens(content);
    const maxTokens = MEMORY_LAYER_CONFIG[layer].maxTokens;
    if (newTokenCount > maxTokens) {
      return apiError(res, 400, `Contenido excede el límite de tokens (${newTokenCount}/${maxTokens}). Reduce el contenido.`);
    }

    // Get old state for audit
    const oldResult = await pool.query(
      'SELECT token_count FROM memory_layers WHERE company_id = $1 AND layer = $2',
      [targetCompanyId, layer]
    );
    const oldTokenCount = oldResult.rows[0]?.token_count || 0;

    // Update content
    const result = await pool.query(
      `UPDATE memory_layers SET content = $1, token_count = $2, updated_at = NOW()
       WHERE company_id = $3 AND layer = $4 RETURNING *`,
      [content, newTokenCount, targetCompanyId, layer]
    );

    // Audit log
    await pool.query(
      `INSERT INTO memory_audit_log (company_id, layer, action, actor, old_token_count, new_token_count, summary)
       VALUES ($1, $2, 'update', $3, $4, $5, $6)`,
      [targetCompanyId, layer, actor, oldTokenCount, newTokenCount,
        `Contenido actualizado (${oldTokenCount} → ${newTokenCount} tokens)`]
    );

    const row = result.rows[0];
    apiSuccess(res, {
      layer: row.layer,
      layer_name: MEMORY_LAYER_CONFIG[layer].name,
      token_count: row.token_count,
      max_tokens: row.max_tokens,
      usage_percent: row.max_tokens > 0 ? Math.round((row.token_count / row.max_tokens) * 100) : 0,
      updated_at: row.updated_at
    });
  } catch (err) {
    console.error('Memory update error:', err.message);
    apiError(res, 500, 'Error al actualizar capa de memoria');
  }
});

// Auto-curate: Extract learnings from task execution and update Layer 1 or 3
app.post('/api/memory/curate', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const { company_id, layer, learnings, task_id, agent_type } = req.body;

    if (!learnings || !layer) {
      return apiError(res, 400, 'learnings y layer son requeridos');
    }
    if (![1, 3].includes(layer)) {
      return apiError(res, 400, 'Auto-curación solo disponible para capas 1 y 3');
    }

    let targetCompanyId = company_id;
    if (!targetCompanyId) {
      const compResult = await pool.query(
        'SELECT id FROM companies WHERE owner_id = $1 ORDER BY created_at ASC LIMIT 1',
        [req.user.id]
      );
      if (compResult.rows.length === 0) {
        return apiError(res, 404, 'Sin empresas registradas');
      }
      targetCompanyId = compResult.rows[0].id;
    }

    await ensureMemoryLayers(targetCompanyId);

    // Get current content
    const current = await pool.query(
      'SELECT content, token_count, max_tokens FROM memory_layers WHERE company_id = $1 AND layer = $2',
      [targetCompanyId, layer]
    );

    const currentContent = current.rows[0]?.content || '';
    const maxTokens = MEMORY_LAYER_CONFIG[layer].maxTokens;

    // Append learnings (with dedup check - simple substring match)
    let newContent = currentContent;
    const learningLines = Array.isArray(learnings) ? learnings : [learnings];
    const addedLearnings = [];

    for (const learning of learningLines) {
      const trimmed = learning.trim();
      if (!trimmed) continue;
      // Skip if already present (simple dedup)
      if (currentContent.includes(trimmed)) continue;

      newContent = newContent ? newContent + '\n' + trimmed : trimmed;
      addedLearnings.push(trimmed);
    }

    // Enforce token budget — if over limit, trim oldest content (first lines)
    let newTokenCount = estimateTokens(newContent);
    if (newTokenCount > maxTokens) {
      const lines = newContent.split('\n');
      while (estimateTokens(lines.join('\n')) > maxTokens && lines.length > 1) {
        lines.shift(); // Remove oldest content first
      }
      newContent = lines.join('\n');
      newTokenCount = estimateTokens(newContent);
    }

    // Update
    await pool.query(
      `UPDATE memory_layers SET content = $1, token_count = $2, updated_at = NOW()
       WHERE company_id = $3 AND layer = $4`,
      [newContent, newTokenCount, targetCompanyId, layer]
    );

    // Audit
    await pool.query(
      `INSERT INTO memory_audit_log (company_id, layer, action, actor, old_token_count, new_token_count, summary)
       VALUES ($1, $2, 'curate', $3, $4, $5, $6)`,
      [targetCompanyId, layer, agent_type || 'system',
        current.rows[0]?.token_count || 0, newTokenCount,
        `Auto-curación: +${addedLearnings.length} aprendizajes${task_id ? ` (tarea #${task_id})` : ''}`]
    );

    // Save conversation summary if task_id provided
    if (task_id && addedLearnings.length > 0) {
      await pool.query(
        `INSERT INTO conversation_summaries (company_id, task_id, agent_type, message_count, summary, key_learnings)
         VALUES ($1, $2, $3, 0, $4, $5)`,
        [targetCompanyId, task_id, agent_type || 'system',
          addedLearnings.join('\n'),
          JSON.stringify(addedLearnings)]
      );
    }

    apiSuccess(res, {
      layer,
      added_learnings: addedLearnings.length,
      token_count: newTokenCount,
      max_tokens: maxTokens,
      usage_percent: Math.round((newTokenCount / maxTokens) * 100)
    });
  } catch (err) {
    console.error('Memory curate error:', err.message);
    apiError(res, 500, 'Error al curar memoria');
  }
});

// Get memory audit history
app.get('/api/memory/audit', requireAuth, async (req, res) => {
  try {
    const { company_id, layer, limit = 20 } = req.query;

    let targetCompanyId = company_id;
    if (!targetCompanyId) {
      const compResult = await pool.query(
        'SELECT id FROM companies WHERE owner_id = $1 ORDER BY created_at ASC LIMIT 1',
        [req.user.id]
      );
      if (compResult.rows.length === 0) {
        return apiSuccess(res, { audit: [] });
      }
      targetCompanyId = compResult.rows[0].id;
    }

    let query = `SELECT * FROM memory_audit_log WHERE company_id = $1`;
    const params = [targetCompanyId];
    let idx = 2;

    if (layer) {
      query += ` AND layer = $${idx}`;
      params.push(parseInt(layer));
      idx++;
    }

    query += ` ORDER BY created_at DESC LIMIT $${idx}`;
    params.push(parseInt(limit));

    const result = await pool.query(query, params);
    apiSuccess(res, { audit: result.rows });
  } catch (err) {
    console.error('Memory audit error:', err.message);
    apiError(res, 500, 'Error al cargar historial de memoria');
  }
});

// Save conversation summary (auto-save every ~20 messages)
app.post('/api/memory/conversation-summary', requireAuth, requireScope('write'), async (req, res) => {
  try {
    const { company_id, task_id, agent_type, message_count, summary, key_learnings } = req.body;

    if (!summary) {
      return apiError(res, 400, 'Resumen es requerido');
    }

    let targetCompanyId = company_id;
    if (!targetCompanyId) {
      const compResult = await pool.query(
        'SELECT id FROM companies WHERE owner_id = $1 ORDER BY created_at ASC LIMIT 1',
        [req.user.id]
      );
      if (compResult.rows.length === 0) {
        return apiError(res, 404, 'Sin empresas registradas');
      }
      targetCompanyId = compResult.rows[0].id;
    }

    const result = await pool.query(
      `INSERT INTO conversation_summaries (company_id, task_id, agent_type, message_count, summary, key_learnings)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [targetCompanyId, task_id || null, agent_type || 'system',
        message_count || 0, summary, JSON.stringify(key_learnings || [])]
    );

    apiSuccess(res, { summary: result.rows[0] }, 201);
  } catch (err) {
    console.error('Conversation summary error:', err.message);
    apiError(res, 500, 'Error al guardar resumen de conversación');
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

// ====== ADMIN MIDDLEWARE ======

function requireAdmin(req, res, next) {
  if (!req.user?.is_admin) {
    return apiError(res, 403, 'Acceso denegado - Solo administradores');
  }
  next();
}

// ====== ADMIN ENDPOINTS ======

// Admin stats
app.get('/api/admin/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const [usersRes, companiesRes, tasksRes, revenueRes] = await Promise.all([
      pool.query('SELECT COUNT(*)::int as total, COUNT(CASE WHEN created_at > NOW() - INTERVAL \'30 days\' THEN 1 END)::int as active FROM users'),
      pool.query('SELECT COUNT(*)::int as total FROM companies'),
      pool.query('SELECT COUNT(*)::int as total, COUNT(CASE WHEN status = \'completed\' THEN 1 END)::int as completed FROM tasks'),
      pool.query('SELECT COALESCE(SUM(balance_cents), 0)::int as total FROM users')
    ]);

    const stats = {
      users: {
        total: usersRes.rows[0].total,
        active: usersRes.rows[0].active
      },
      companies: {
        total: companiesRes.rows[0].total
      },
      tasks: {
        total: tasksRes.rows[0].total,
        completed: tasksRes.rows[0].completed
      },
      revenue: {
        total: revenueRes.rows[0].total,
        commission: Math.round(revenueRes.rows[0].total * 0.2) // 20% commission
      }
    };

    apiSuccess(res, stats);
  } catch (err) {
    logger.error('Admin stats error:', err);
    apiError(res, 500, 'Error al cargar estadísticas de administrador');
  }
});

// List users (admin only)
app.get('/api/admin/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const result = await pool.query(
      `SELECT u.id, u.name, u.email, u.balance_cents, u.created_at,
              s.plan_slug as plan
       FROM users u
       LEFT JOIN subscriptions s ON u.id = s.user_id AND s.status = 'active'
       ORDER BY u.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    apiSuccess(res, { users: result.rows });
  } catch (err) {
    logger.error('Admin users error:', err);
    apiError(res, 500, 'Error al cargar usuarios');
  }
});

// List companies (admin only)
app.get('/api/admin/companies', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { limit = 20, offset = 0 } = req.query;
    const result = await pool.query(
      `SELECT c.id, c.name, c.plan, c.created_at,
              u.email as owner_email,
              (SELECT COUNT(*) FROM tasks WHERE company_id = c.id) as task_count
       FROM companies c
       LEFT JOIN users u ON c.owner_id = u.id
       ORDER BY c.created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    apiSuccess(res, { companies: result.rows });
  } catch (err) {
    logger.error('Admin companies error:', err);
    apiError(res, 500, 'Error al cargar empresas');
  }
});

// ====== SETTINGS ENDPOINTS ======

// Update profile
app.post('/api/settings/profile', requireAuth, async (req, res) => {
  try {
    const { name, avatar_url } = req.body;

    await pool.query(
      'UPDATE users SET name = $1, avatar_url = $2, updated_at = NOW() WHERE id = $3',
      [name, avatar_url, req.user.id]
    );

    apiSuccess(res, { message: 'Perfil actualizado' });
  } catch (err) {
    logger.error('Profile update error:', err);
    apiError(res, 500, 'Error al actualizar perfil');
  }
});

// Change password
app.post('/api/settings/password', requireAuth, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;

    // Verify current password
    const result = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
    const user = result.rows[0];

    const validPassword = await bcrypt.compare(current_password, user.password_hash);
    if (!validPassword) {
      return apiError(res, 400, 'Contraseña actual incorrecta');
    }

    // Validate new password
    const validation = validatePassword(new_password);
    if (!validation.valid) {
      return apiError(res, 400, validation.errors.join(', '));
    }

    // Hash and update
    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query(
      'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
      [newHash, req.user.id]
    );

    apiSuccess(res, { message: 'Contraseña actualizada' });
  } catch (err) {
    logger.error('Password update error:', err);
    apiError(res, 500, 'Error al actualizar contraseña');
  }
});

// Request withdrawal
app.post('/api/settings/withdrawal', requireAuth, async (req, res) => {
  try {
    const { amount_cents, payment_method, payment_details } = req.body;

    if (amount_cents < 5000) { // $50 minimum
      return apiError(res, 400, 'El monto mínimo es $50 USD');
    }

    // Check balance
    const balanceRes = await pool.query('SELECT balance_cents FROM users WHERE id = $1', [req.user.id]);
    const balance = balanceRes.rows[0].balance_cents || 0;

    if (balance < amount_cents) {
      return apiError(res, 400, 'Saldo insuficiente');
    }

    // Check for pending withdrawals
    const pendingRes = await pool.query(
      'SELECT id FROM withdrawals WHERE user_id = $1 AND status = \'pending\'',
      [req.user.id]
    );

    if (pendingRes.rows.length > 0) {
      return apiError(res, 400, 'Ya tienes una solicitud de retiro pendiente');
    }

    // Create withdrawal request
    await pool.query(
      `INSERT INTO withdrawals (user_id, amount_cents, payment_method, payment_details, status)
       VALUES ($1, $2, $3, $4, 'pending')`,
      [req.user.id, amount_cents, payment_method, JSON.stringify(payment_details)]
    );

    apiSuccess(res, { message: 'Solicitud de retiro creada' }, 201);
  } catch (err) {
    logger.error('Withdrawal request error:', err);
    apiError(res, 500, 'Error al solicitar retiro');
  }
});

// Get quick links
app.get('/api/settings/quick-links', requireAuth, async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM quick_links WHERE user_id = $1 AND is_active = true ORDER BY sort_order',
      [req.user.id]
    );

    apiSuccess(res, { links: result.rows });
  } catch (err) {
    logger.error('Quick links error:', err);
    apiError(res, 500, 'Error al cargar enlaces rápidos');
  }
});

// Add quick link
app.post('/api/settings/quick-links', requireAuth, async (req, res) => {
  try {
    const { title, url, icon = 'link' } = req.body;

    if (!title || !url) {
      return apiError(res, 400, 'Título y URL son requeridos');
    }

    // Get max sort order
    const maxRes = await pool.query(
      'SELECT COALESCE(MAX(sort_order), 0) as max FROM quick_links WHERE user_id = $1',
      [req.user.id]
    );
    const sortOrder = maxRes.rows[0].max + 1;

    const result = await pool.query(
      `INSERT INTO quick_links (user_id, title, url, icon, sort_order)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [req.user.id, title, url, icon, sortOrder]
    );

    apiSuccess(res, { link: result.rows[0] }, 201);
  } catch (err) {
    logger.error('Add quick link error:', err);
    apiError(res, 500, 'Error al agregar enlace rápido');
  }
});

// Delete quick link
app.delete('/api/settings/quick-links/:id', requireAuth, async (req, res) => {
  try {
    await pool.query(
      'UPDATE quick_links SET is_active = false WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.id]
    );

    apiSuccess(res, { message: 'Enlace eliminado' });
  } catch (err) {
    logger.error('Delete quick link error:', err);
    apiError(res, 500, 'Error al eliminar enlace');
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

// Skills page (protected)
app.get('/skills', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'skills.html'));
});

// MCP servers page (protected)
app.get('/mcp', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'mcp.html'));
});

// API documentation page (public)
app.get('/api/docs', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'api-docs.html'));
});

// Memory system page (protected)
app.get('/memoria', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'memory.html'));
});

// API keys management page (protected)
app.get('/claves-api', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'api-keys.html'));
});

// Admin dashboard page (protected, admin only)
app.get('/admin', requireAuth, requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Settings page (protected)
app.get('/configuracion', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'configuracion.html'));
});

// Global error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error in request', {
    error: err,
    method: req.method,
    path: req.path,
    user_id: req.user?.id || null
  });

  // Don't leak error details in production
  const errorMessage = process.env.NODE_ENV === 'production'
    ? 'Error interno del servidor'
    : err.message;

  // Return JSON for API requests, HTML for browser requests
  if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
    return res.status(500).json({ error: errorMessage });
  }

  // Serve HTML error page for browsers
  res.status(500).sendFile(path.join(__dirname, 'public', '500.html'));
});

// Handle 404s
app.use((req, res) => {
  // Return JSON for API requests, HTML for browser requests
  if (req.path.startsWith('/api/') || req.headers.accept?.includes('application/json')) {
    return res.status(404).json({ error: 'Ruta no encontrada' });
  }

  // Serve HTML error page for browsers
  res.status(404).sendFile(path.join(__dirname, 'public', '404.html'));
});

// Process error handlers
process.on('uncaughtException', (err) => {
  logger.fatal('Uncaught exception', { error: err });
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.fatal('Unhandled promise rejection', {
    reason: reason instanceof Error ? { message: reason.message, stack: reason.stack } : reason,
    promise: promise.toString()
  });
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, shutting down gracefully');
  await pool.end();
  process.exit(0);
});

app.listen(port, () => {
  logger.info('Polsia ES started', {
    port,
    environment: process.env.NODE_ENV || 'development',
    node_version: process.version,
    health_endpoint: `http://localhost:${port}/health`
  });
});
