# Polsia ES - Cloud Deployment Pipeline

## Infrastructure Overview

**Production URL:** https://hyper88os.polsia.app
**Repository:** https://github.com/Polsia-Inc/hyper88os
**Hosting:** Render Web Service
**Database:** Neon PostgreSQL (Serverless)
**Storage:** Cloudflare R2 (via Polsia proxy)

---

## Deployment Pipeline

### Automatic Deployments

Every push to the `main` branch triggers an automatic deployment on Render.

**Deployment Process:**
1. Code pushed to GitHub (`git push origin main`)
2. Render detects the change and starts build
3. Runs `npm install` to install dependencies
4. Runs `npm run migrate` to apply database migrations
5. Starts the app with `npm start`
6. Health check endpoint (`/health`) verifies service is ready
7. Traffic switches to new instance (rolling deploy)

**Deployment Time:** ~2-5 minutes

---

## Environment Variables

The following environment variables are automatically configured:

| Variable | Purpose | Status |
|----------|---------|--------|
| `NODE_ENV` | Set to `production` | ✅ Configured |
| `PORT` | Server port (10000) | ✅ Configured |
| `DATABASE_URL` | Neon PostgreSQL connection string | ✅ Configured |
| `POLSIA_API_KEY` | Polsia platform authentication | ✅ Configured |
| `POLSIA_API_TOKEN` | Polsia platform authentication | ✅ Configured |
| `POLSIA_ANALYTICS_SLUG` | Analytics tracking identifier | ✅ Configured |
| `POLSIA_R2_BASE_URL` | R2 file storage proxy URL | ✅ Configured |
| `OPENAI_API_KEY` | OpenAI API via Polsia proxy | ✅ Configured |
| `OPENAI_BASE_URL` | OpenAI proxy base URL | ✅ Configured |
| `ANTHROPIC_API_KEY` | Anthropic Claude API key | ✅ Configured |

### Optional Variables

- `SESSION_SECRET` - Custom session secret (auto-generated if not set)
- `APP_URL` - Application URL for OAuth/redirects (defaults to current host)

---

## Database Management

### Migration System

Database migrations run automatically on every deploy via `npm run migrate`.

**Migration Process:**
1. Creates `_migrations` tracking table if not exists
2. Runs core migrations (users, sessions, etc.) - idempotent
3. Scans `migrations/` folder for numbered migration files
4. Runs pending migrations in order (tracked in `_migrations` table)

### Creating New Migrations

```bash
# Create a new migration file
touch migrations/$(date +%s)000_your_migration_name.js
```

Migration file format:
```javascript
module.exports = {
  name: 'your_migration_name',
  up: async (client) => {
    await client.query(`
      CREATE TABLE your_table (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL
      )
    `);
  }
};
```

### Database Backup

Neon provides automatic point-in-time recovery. Access via:
- Neon Console: https://console.neon.tech
- Database snapshots are retained for 7 days (free tier) / 30 days (paid)

---

## Custom Domain Setup

### Current Domain
- **Production:** https://hyper88os.polsia.app (Polsia subdomain)
- **SSL/TLS:** Automatic via Render + Let's Encrypt

### Setting Up a Custom Domain (e.g., polsia.es)

#### 1. Add Domain to Render Service

1. Go to Render Dashboard: https://dashboard.render.com
2. Select the `hyper88os` service
3. Navigate to **Settings → Custom Domains**
4. Click **Add Custom Domain**
5. Enter your domain:
   - `polsia.es` (apex domain)
   - `www.polsia.es` (www subdomain)

#### 2. Configure DNS Records

Add the following DNS records at your domain registrar:

**For Apex Domain (polsia.es):**
```
Type: A
Name: @
Value: 216.24.57.1
TTL: 300
```

**For WWW Subdomain:**
```
Type: CNAME
Name: www
Value: hyper88os.onrender.com
TTL: 300
```

#### 3. SSL Certificate Provisioning

- Render automatically provisions Let's Encrypt SSL certificates
- **DNS propagation:** 5-10 minutes
- **SSL provisioning:** 10-30 minutes after DNS propagation

#### 4. Update Environment Variables

After domain is active, update `APP_URL` environment variable:

```bash
APP_URL=https://polsia.es
```

This ensures:
- OAuth redirects work correctly
- Email links point to the right domain
- OG meta tags reference the correct URL

#### 5. Verify Domain

```bash
# Check DNS propagation
dig polsia.es
dig www.polsia.es

# Verify SSL certificate
curl -I https://polsia.es

# Test health endpoint
curl https://polsia.es/health
```

---

## Health Checks & Monitoring

### Health Endpoints

**Primary Health Check:** `/health`
```json
{
  "status": "healthy",
  "timestamp": "2026-03-04T13:00:00.000Z",
  "uptime": 3600,
  "environment": "production",
  "version": "1.0.0",
  "database": {
    "status": "connected",
    "latency_ms": 15
  },
  "environment_vars": {
    "status": "complete"
  }
}
```

**API Health Check:** `/api/health` (alias for `/health`)

### Health Status Codes

- `200` - Service healthy, all systems operational
- `503` - Service unhealthy (database disconnected or critical error)

### Monitoring

**Render Built-in Monitoring:**
- CPU usage, memory, request count
- Access via Render Dashboard → Metrics

**Application Logs:**
```bash
# View logs via Polsia CLI
polsia logs --instance-id=4574

# View logs in Render Dashboard
https://dashboard.render.com/web/srv-d6k1uvvkijhs73dj9vv0/logs
```

**Log Format:**
```
GET /api/billing 200 45ms
POST /api/auth/login 200 123ms
Error: Database connection failed
```

---

## CI/CD Pipeline Details

### Build Configuration (`render.yaml`)

```yaml
services:
  - type: web
    runtime: node
    name: app
    buildCommand: npm install
    startCommand: npm run migrate && npm start
    healthCheckPath: /health
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: 10000
```

### Deployment Checklist

Before pushing to production:

- [ ] All tests pass locally
- [ ] Database migrations are idempotent (use `IF NOT EXISTS`)
- [ ] New environment variables documented
- [ ] API endpoints tested
- [ ] Error handling in place
- [ ] Logs are informative (no sensitive data)

### Rollback Procedure

If a deployment fails:

1. **Via Render Dashboard:**
   - Go to service → Deploys
   - Click "Rollback" on previous successful deploy

2. **Via Git:**
   ```bash
   git revert HEAD
   git push origin main
   ```

3. **Emergency Rollback:**
   - Contact Polsia support: support@polsia.com
   - Render dashboard has 1-click rollback

---

## R2 File Storage

### Configuration

R2 storage is available via Polsia proxy:
- **Base URL:** `https://polsia.com` (via `POLSIA_R2_BASE_URL`)
- **Authentication:** Automatic via `POLSIA_API_KEY`

### Usage Example

```javascript
// Upload file to R2
const formData = new FormData();
formData.append('file', fileBuffer, 'filename.jpg');

const response = await fetch(`${process.env.POLSIA_R2_BASE_URL}/api/r2/upload`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.POLSIA_API_KEY}`
  },
  body: formData
});

const { url } = await response.json();
// url: https://r2.polsia.com/hyper88os/filename.jpg
```

---

## SSL/TLS Configuration

### Automatic SSL

- **Provided by:** Render + Let's Encrypt
- **Renewal:** Automatic (90-day certificates, auto-renewed at 60 days)
- **Protocols:** TLS 1.2, TLS 1.3
- **Grade:** A+ (SSL Labs)

### HTTPS Redirect

All HTTP traffic automatically redirects to HTTPS (handled by Render).

### Session Security

Secure cookies are enforced in production:
```javascript
cookie: {
  secure: process.env.NODE_ENV === 'production',
  httpOnly: true,
  sameSite: 'lax'
}
```

---

## Troubleshooting

### Deployment Fails

**Check deployment logs:**
```bash
polsia logs --instance-id=4574 --type=build
```

**Common issues:**
- Migration syntax error → Check `migrations/` files
- Missing dependency → Run `npm install` locally first
- Database connection failed → Verify `DATABASE_URL` is set

### Health Check Failing

**Check health endpoint:**
```bash
curl https://hyper88os.polsia.app/health
```

**Possible causes:**
- Database not accessible (check Neon status)
- Missing environment variables
- Application crash (check logs)

### Database Connection Issues

**Verify connection string:**
```bash
# Test database connection
psql $DATABASE_URL -c "SELECT NOW();"
```

**Check Neon status:**
- Neon Console: https://console.neon.tech
- Status page: https://neonstatus.com

---

## Support

**Platform Issues:**
- Email: support@polsia.com
- Report bugs via Polsia support MCP

**Infrastructure Access:**
- Render Dashboard: https://dashboard.render.com
- Neon Console: https://console.neon.tech
- GitHub Repository: https://github.com/Polsia-Inc/hyper88os

---

**Last Updated:** 2026-03-04
**Deployment Version:** 1.0.0
