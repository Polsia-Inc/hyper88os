module.exports = {
  name: 'admin_settings',
  up: async (client) => {
    // Withdrawal requests table
    await client.query(`
      CREATE TABLE IF NOT EXISTS withdrawals (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        amount_cents INTEGER NOT NULL,
        currency VARCHAR(10) DEFAULT 'USD',
        status VARCHAR(30) DEFAULT 'pending',
        payment_method VARCHAR(50),
        payment_details JSONB DEFAULT '{}',
        processed_at TIMESTAMPTZ,
        processed_by INTEGER REFERENCES users(id),
        notes TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS withdrawals_user_idx ON withdrawals(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS withdrawals_status_idx ON withdrawals(status)`);

    // Quick links table
    await client.query(`
      CREATE TABLE IF NOT EXISTS quick_links (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        url VARCHAR(500) NOT NULL,
        icon VARCHAR(50) DEFAULT 'link',
        sort_order INTEGER DEFAULT 0,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS quick_links_user_idx ON quick_links(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS quick_links_company_idx ON quick_links(company_id)`);

    // Add balance column to users if not exists
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS balance_cents INTEGER DEFAULT 0
    `);

    // Add admin role check
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT false
    `);

    // Add profile fields
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT
    `);

    // Add company profile fields
    await client.query(`
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS description TEXT
    `);
    await client.query(`
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS timezone VARCHAR(50) DEFAULT 'America/New_York'
    `);
    await client.query(`
      ALTER TABLE companies ADD COLUMN IF NOT EXISTS logo_url TEXT
    `);
  }
};
