module.exports = {
  name: 'billing_system',
  up: async (client) => {
    // Subscription plans reference
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_plans (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(50) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        price_cents INTEGER NOT NULL DEFAULT 0,
        api_calls_daily INTEGER NOT NULL DEFAULT 100,
        llm_calls_daily INTEGER NOT NULL DEFAULT 10,
        max_companies INTEGER NOT NULL DEFAULT 1,
        task_credits INTEGER NOT NULL DEFAULT 3,
        overage_api_cents INTEGER NOT NULL DEFAULT 1,
        overage_llm_cents INTEGER NOT NULL DEFAULT 5,
        stripe_payment_link TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        sort_order INTEGER DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Insert default plans
    await client.query(`
      INSERT INTO subscription_plans (slug, name, price_cents, api_calls_daily, llm_calls_daily, max_companies, task_credits, overage_api_cents, overage_llm_cents, sort_order)
      VALUES
        ('free', 'Gratis', 0, 100, 10, 1, 3, 1, 5, 0),
        ('starter', 'Starter', 2900, 5000, 500, 3, 25, 1, 5, 1),
        ('pro', 'Pro', 7900, 25000, 2500, 10, 100, 1, 5, 2),
        ('enterprise', 'Enterprise', 19900, 100000, 10000, -1, 500, 1, 5, 3)
      ON CONFLICT (slug) DO NOTHING
    `);

    // Subscriptions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        plan_slug VARCHAR(50) NOT NULL DEFAULT 'free' REFERENCES subscription_plans(slug),
        status VARCHAR(30) NOT NULL DEFAULT 'active',
        stripe_payment_link TEXT,
        stripe_session_id TEXT,
        verification_method VARCHAR(50),
        verification_attempts INTEGER DEFAULT 0,
        last_verification_attempt TIMESTAMPTZ,
        verified_by_polsia BOOLEAN DEFAULT FALSE,
        fraud_score INTEGER DEFAULT 0,
        client_ip TEXT,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        cancelled_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS subscriptions_user_idx ON subscriptions(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS subscriptions_status_idx ON subscriptions(status)`);

    // Invoices table
    await client.query(`
      CREATE TABLE IF NOT EXISTS invoices (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
        amount_cents INTEGER NOT NULL,
        currency VARCHAR(10) DEFAULT 'USD',
        status VARCHAR(30) DEFAULT 'pending',
        description TEXT,
        stripe_payment_link TEXT,
        paid_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS invoices_user_idx ON invoices(user_id)`);

    // Task credits tracking per company
    await client.query(`
      CREATE TABLE IF NOT EXISTS credits (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        credits_total INTEGER NOT NULL DEFAULT 0,
        credits_used INTEGER NOT NULL DEFAULT 0,
        period_start TIMESTAMPTZ DEFAULT NOW(),
        period_end TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS credits_user_idx ON credits(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS credits_company_idx ON credits(company_id)`);

    // Usage tracking (API + LLM calls per company per day)
    await client.query(`
      CREATE TABLE IF NOT EXISTS usage_tracking (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL,
        usage_date DATE NOT NULL DEFAULT CURRENT_DATE,
        api_calls INTEGER NOT NULL DEFAULT 0,
        llm_calls INTEGER NOT NULL DEFAULT 0,
        overage_api_calls INTEGER NOT NULL DEFAULT 0,
        overage_llm_calls INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, company_id, usage_date)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS usage_tracking_user_date_idx ON usage_tracking(user_id, usage_date)`);

    // Referral system
    await client.query(`
      CREATE TABLE IF NOT EXISTS referrals (
        id SERIAL PRIMARY KEY,
        referrer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        referred_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        referral_code VARCHAR(20) UNIQUE NOT NULL,
        status VARCHAR(30) DEFAULT 'pending',
        bonus_credits INTEGER DEFAULT 5,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        redeemed_at TIMESTAMPTZ
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS referrals_referrer_idx ON referrals(referrer_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS referrals_code_idx ON referrals(referral_code)`);

    // Subscription audit log
    await client.query(`
      CREATE TABLE IF NOT EXISTS subscription_audit_log (
        id SERIAL PRIMARY KEY,
        subscription_id INTEGER REFERENCES subscriptions(id),
        user_id INTEGER REFERENCES users(id),
        action VARCHAR(50),
        verification_method VARCHAR(50),
        verified_by_polsia BOOLEAN,
        client_ip TEXT,
        user_agent TEXT,
        fraud_indicators JSONB,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Add referral_code column to users
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20)`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER REFERENCES users(id) ON DELETE SET NULL`);
    await client.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS theme VARCHAR(10) DEFAULT 'dark'`);
  }
};
