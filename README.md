# Polsia ES (Hyper88OS)

Plataforma de agentes autónomos de IA con gestión de suscripciones, facturación y sistema de referidos.

## 🚀 Production

**URL:** https://hyper88os.polsia.app

## 📋 Stack

- **Backend:** Node.js + Express.js
- **Database:** PostgreSQL (Neon Serverless)
- **Hosting:** Render (auto-deploy on push to main)
- **Storage:** Cloudflare R2 (via Polsia proxy)
- **Auth:** bcrypt + PostgreSQL sessions
- **Payments:** Stripe (via Polsia integration)

## 🏗️ Infrastructure

### Automatic Deployment Pipeline

Every push to `main` triggers:
1. Build (`npm install`)
2. Database migrations (`npm run migrate`)
3. Service start (`npm start`)
4. Health check verification (`/health`)
5. Rolling deploy (zero downtime)

**Deployment time:** ~2-5 minutes

### Database Migrations

Migrations run automatically on deploy. Create new migrations:

```bash
touch migrations/$(date +%s)000_your_migration_name.js
```

See `migrate.js` for migration format.

### Health Checks

- **Primary:** `GET /health` - Full health check with DB connectivity
- **API:** `GET /api/health` - Alias for primary health check

Returns:
```json
{
  "status": "healthy",
  "database": { "status": "connected", "latency_ms": 15 },
  "environment_vars": { "status": "complete" }
}
```

## 🔧 Local Development

### Prerequisites

- Node.js 20+
- PostgreSQL (or use Neon)

### Setup

```bash
# Install dependencies
npm install

# Set environment variables
cp .env.example .env
# Edit .env with your local database URL

# Run migrations
npm run migrate

# Start dev server
npm run dev
```

### Environment Variables

See `.env.example` for all required and optional variables.

**Required:**
- `DATABASE_URL` - PostgreSQL connection string
- `POLSIA_API_KEY` - Polsia platform authentication
- `OPENAI_API_KEY` - AI API access
- `ANTHROPIC_API_KEY` - Claude API access

## 📚 Documentation

- **Deployment Guide:** See `DEPLOYMENT.md` for full deployment pipeline documentation
- **Custom Domain Setup:** See `DEPLOYMENT.md` → Custom Domain Setup
- **Database Management:** See `DEPLOYMENT.md` → Database Management
- **Troubleshooting:** See `DEPLOYMENT.md` → Troubleshooting

## 🔐 Security

- Secure cookies in production (HTTPS only)
- bcrypt password hashing (12 rounds)
- PostgreSQL-backed sessions (no data loss on restart)
- CORS configured for production domain
- SQL injection protection via parameterized queries

## 📊 Monitoring

- Request logging (method, path, status, duration)
- Error logging with stack traces
- Process error handlers (uncaught exceptions, unhandled rejections)
- Graceful shutdown on SIGTERM

**View logs:**
```bash
# Via Polsia CLI
polsia logs --instance-id=4574

# Via Render Dashboard
https://dashboard.render.com/web/srv-d6k1uvvkijhs73dj9vv0/logs
```

## 🌐 API Endpoints

### Authentication
- `POST /api/auth/signup` - Create account
- `POST /api/auth/login` - Login
- `POST /api/auth/logout` - Logout
- `GET /api/auth/me` - Get current user

### Billing & Subscriptions
- `GET /api/billing` - Get subscription & usage
- `GET /api/plans` - List pricing plans
- `POST /api/billing/subscribe` - Start subscription
- `POST /api/billing/verify` - Verify payment
- `GET /api/billing/invoices` - List invoices
- `GET /api/billing/usage` - Usage history

### Dashboard
- `GET /api/dashboard/stats` - Dashboard statistics

### Settings
- `GET /api/settings` - Get user settings
- `POST /api/settings` - Update settings
- `POST /api/theme` - Change theme (light/dark)

### Referrals
- `GET /api/referral` - Get referral code & stats

## 🎨 Features

- ✅ Spanish UI (i18n support)
- ✅ Dark/Light theme with persistence
- ✅ Email/password authentication
- ✅ Stripe payment integration
- ✅ Referral system with bonus credits
- ✅ Usage tracking & limits
- ✅ Fraud detection on payments
- ✅ Dashboard with real-time stats
- ✅ Mobile-responsive design

## 🚢 Deployment

See `DEPLOYMENT.md` for comprehensive deployment documentation including:
- Custom domain setup (polsia.es)
- SSL/TLS configuration
- Environment variables
- Rollback procedures
- Troubleshooting guide

## 📞 Support

**Platform Issues:** support@polsia.com

**Infrastructure:**
- Render Dashboard: https://dashboard.render.com
- Neon Console: https://console.neon.tech
- GitHub: https://github.com/Polsia-Inc/hyper88os

---

**Version:** 1.0.0
**Last Updated:** 2026-03-04
