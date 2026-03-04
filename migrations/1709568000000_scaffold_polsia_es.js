module.exports = {
  name: 'scaffold_polsia_es',
  up: async (client) => {
    // Companies table
    await client.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        slug VARCHAR(255) UNIQUE NOT NULL,
        owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        plan VARCHAR(50) DEFAULT 'free',
        locale VARCHAR(10) DEFAULT 'es',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS companies_slug_idx ON companies(slug)`);
    await client.query(`CREATE INDEX IF NOT EXISTS companies_owner_idx ON companies(owner_id)`);

    // Sessions table for connect-pg-simple
    await client.query(`
      CREATE TABLE IF NOT EXISTS session (
        sid VARCHAR NOT NULL COLLATE "default",
        sess JSON NOT NULL,
        expire TIMESTAMP(6) NOT NULL,
        PRIMARY KEY (sid)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS IDX_session_expire ON session(expire)`);

    // Settings table (key-value per user or company)
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        key VARCHAR(255) NOT NULL,
        value JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(user_id, key),
        UNIQUE(company_id, key)
      )
    `);

    // Add locale column to users if not exists
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS locale VARCHAR(10) DEFAULT 'es'
    `);
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL
    `);
    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user'
    `);
  }
};
