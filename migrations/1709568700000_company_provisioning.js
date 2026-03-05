module.exports = {
  name: 'company_provisioning',
  up: async (client) => {
    // Company resources table - tracks all provisioned infrastructure
    await client.query(`
      CREATE TABLE IF NOT EXISTS company_resources (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        resource_type VARCHAR(50) NOT NULL, -- 'github_repo', 'database', 'web_service', 'storage_bucket'
        provider VARCHAR(50) NOT NULL, -- 'github', 'neon', 'render', 'r2'
        name VARCHAR(255) NOT NULL,
        url TEXT,
        status VARCHAR(50) DEFAULT 'provisioning', -- 'provisioning', 'active', 'error', 'deleted'
        config JSONB DEFAULT '{}', -- provider-specific config (repo_name, db_connection_string, service_id, etc.)
        error_message TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS company_resources_company_idx ON company_resources(company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS company_resources_type_idx ON company_resources(resource_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS company_resources_status_idx ON company_resources(status)`);

    // Provisioning logs table - tracks provisioning progress step-by-step
    await client.query(`
      CREATE TABLE IF NOT EXISTS provisioning_logs (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        step VARCHAR(100) NOT NULL, -- 'create_github_repo', 'create_database', 'create_web_service', 'create_storage'
        status VARCHAR(50) NOT NULL, -- 'started', 'success', 'error'
        message TEXT,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS provisioning_logs_company_idx ON provisioning_logs(company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS provisioning_logs_created_idx ON provisioning_logs(created_at DESC)`);

    // Add provisioning_status to companies table
    await client.query(`
      ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS provisioning_status VARCHAR(50) DEFAULT 'not_started'
    `);
    await client.query(`
      ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS provisioned_at TIMESTAMPTZ
    `);

    // Add description field for companies
    await client.query(`
      ALTER TABLE companies
      ADD COLUMN IF NOT EXISTS description TEXT
    `);
  }
};
