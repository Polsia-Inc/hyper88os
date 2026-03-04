module.exports = {
  name: 'memory_system',
  up: async (client) => {
    // Memory layers table — 3-layer shared memory for agent communication
    // Layer 1: Domain knowledge (15K tokens, auto-curated)
    // Layer 2: Mission/preferences (3K tokens, CEO manual)
    // Layer 3: Cross-company patterns (15K tokens, auto-curated)
    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_layers (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        layer INTEGER NOT NULL CHECK (layer BETWEEN 1 AND 3),
        title VARCHAR(255) NOT NULL DEFAULT '',
        content TEXT NOT NULL DEFAULT '',
        token_count INTEGER NOT NULL DEFAULT 0,
        max_tokens INTEGER NOT NULL DEFAULT 15000,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(company_id, layer)
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS memory_layers_company_idx ON memory_layers(company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS memory_layers_layer_idx ON memory_layers(layer)`);
    await client.query(`CREATE INDEX IF NOT EXISTS memory_layers_updated_idx ON memory_layers(updated_at DESC)`);

    // Full-text search index on content for keyword search
    await client.query(`
      ALTER TABLE memory_layers ADD COLUMN IF NOT EXISTS search_vector tsvector
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS memory_layers_search_idx ON memory_layers USING GIN(search_vector)
    `);

    // Trigger to auto-update search_vector on content change
    await client.query(`
      CREATE OR REPLACE FUNCTION memory_layers_search_update() RETURNS trigger AS $$
      BEGIN
        NEW.search_vector := to_tsvector('spanish', COALESCE(NEW.title, '') || ' ' || COALESCE(NEW.content, ''));
        RETURN NEW;
      END
      $$ LANGUAGE plpgsql
    `);

    await client.query(`
      DROP TRIGGER IF EXISTS memory_layers_search_trigger ON memory_layers
    `);

    await client.query(`
      CREATE TRIGGER memory_layers_search_trigger
        BEFORE INSERT OR UPDATE OF content, title ON memory_layers
        FOR EACH ROW EXECUTE FUNCTION memory_layers_search_update()
    `);

    // Memory audit log — tracks all memory changes
    await client.query(`
      CREATE TABLE IF NOT EXISTS memory_audit_log (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        layer INTEGER NOT NULL,
        action VARCHAR(50) NOT NULL,
        actor VARCHAR(255) NOT NULL DEFAULT 'system',
        old_token_count INTEGER,
        new_token_count INTEGER,
        summary TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS memory_audit_company_idx ON memory_audit_log(company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS memory_audit_created_idx ON memory_audit_log(created_at DESC)`);

    // Conversation summaries — auto-saved every ~20 messages
    await client.query(`
      CREATE TABLE IF NOT EXISTS conversation_summaries (
        id SERIAL PRIMARY KEY,
        company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
        agent_type VARCHAR(100),
        message_count INTEGER NOT NULL DEFAULT 0,
        summary TEXT NOT NULL,
        key_learnings JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS conv_summaries_company_idx ON conversation_summaries(company_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS conv_summaries_created_idx ON conversation_summaries(created_at DESC)`);
  }
};
