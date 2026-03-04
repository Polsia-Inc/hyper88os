module.exports = {
  name: 'api_skills_mcp',
  up: async (client) => {
    // ====== API KEYS TABLE ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash VARCHAR(255) NOT NULL,
        key_prefix VARCHAR(20) NOT NULL,
        name VARCHAR(255) NOT NULL DEFAULT 'default',
        scopes JSONB DEFAULT '["read", "write"]',
        rate_limit_per_minute INTEGER DEFAULT 60,
        last_used_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        is_active BOOLEAN DEFAULT true,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS api_keys_hash_idx ON api_keys(key_hash)`);
    await client.query(`CREATE INDEX IF NOT EXISTS api_keys_prefix_idx ON api_keys(key_prefix)`);
    await client.query(`CREATE INDEX IF NOT EXISTS api_keys_active_idx ON api_keys(is_active)`);

    // Rate limit tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS api_rate_limits (
        id SERIAL PRIMARY KEY,
        api_key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
        window_start TIMESTAMPTZ NOT NULL,
        request_count INTEGER DEFAULT 1,
        UNIQUE(api_key_id, window_start)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS api_rate_limits_key_idx ON api_rate_limits(api_key_id, window_start)`);

    // ====== SKILLS TABLE ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS skills (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        summary TEXT,
        content TEXT NOT NULL,
        keywords JSONB DEFAULT '[]',
        agent_types JSONB DEFAULT '[]',
        version INTEGER DEFAULT 1,
        is_active BOOLEAN DEFAULT true,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS skills_name_idx ON skills(name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS skills_active_idx ON skills(is_active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS skills_keywords_idx ON skills USING GIN(keywords)`);
    await client.query(`CREATE INDEX IF NOT EXISTS skills_agent_types_idx ON skills USING GIN(agent_types)`);

    // Seed some default skills
    await client.query(`
      INSERT INTO skills (name, summary, content, keywords, agent_types) VALUES
      ('deploy-express', 'Desplegar aplicaciones Express.js en Render',
        E'## Procedimiento de despliegue\\n1. Ejecutar pruebas localmente\\n2. Commit y push a main\\n3. Render detecta push automáticamente\\n4. Verificar salud en /health\\n5. Confirmar logs sin errores',
        '["deploy", "render", "express", "produccion"]',
        '["engineering", "ops"]'
      ),
      ('database-migration', 'Crear y ejecutar migraciones PostgreSQL',
        E'## Crear migración\\n1. Crear archivo en migrations/ con timestamp\\n2. Exportar módulo con name y up(client)\\n3. Usar CREATE IF NOT EXISTS\\n4. Ejecutar npm run migrate\\n5. Verificar con SELECT de la nueva tabla',
        '["database", "postgresql", "migracion", "schema"]',
        '["engineering", "data"]'
      ),
      ('api-authentication', 'Implementar autenticación de API con claves',
        E'## Autenticación API\\n1. Generar clave con crypto.randomBytes\\n2. Almacenar hash (SHA-256)\\n3. Validar en middleware\\n4. Rate limiting por clave\\n5. Scopes para permisos granulares',
        '["auth", "api-key", "seguridad", "middleware"]',
        '["engineering"]'
      ),
      ('task-management', 'Gestión del ciclo de vida de tareas',
        E'## Ciclo de vida\\n- todo → in_progress → completed/failed\\n- Cada cambio de estado se registra en historial\\n- Logs de ejecución para auditoría\\n- Asignación automática a agentes por tag',
        '["tareas", "workflow", "gestion", "agentes"]',
        '["engineering", "ops", "support"]'
      )
      ON CONFLICT (name) DO NOTHING
    `);

    // ====== MCP SERVERS TABLE ======
    await client.query(`
      CREATE TABLE IF NOT EXISTS mcp_servers (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        description TEXT,
        server_url VARCHAR(500),
        transport_type VARCHAR(50) DEFAULT 'stdio',
        config JSONB DEFAULT '{}',
        tools JSONB DEFAULT '[]',
        oauth_required BOOLEAN DEFAULT false,
        oauth_config JSONB DEFAULT '{}',
        is_active BOOLEAN DEFAULT true,
        health_status VARCHAR(50) DEFAULT 'unknown',
        last_health_check TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS mcp_servers_name_idx ON mcp_servers(name)`);
    await client.query(`CREATE INDEX IF NOT EXISTS mcp_servers_active_idx ON mcp_servers(is_active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS mcp_servers_transport_idx ON mcp_servers(transport_type)`);

    // Agent-MCP mapping table (which agents have access to which MCP servers)
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_mcp_servers (
        id SERIAL PRIMARY KEY,
        agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        mcp_server_id INTEGER NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
        is_required BOOLEAN DEFAULT false,
        config_overrides JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(agent_id, mcp_server_id)
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS agent_mcp_agent_idx ON agent_mcp_servers(agent_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agent_mcp_server_idx ON agent_mcp_servers(mcp_server_id)`);

    // Seed MCP servers matching agent mcp_requirements
    await client.query(`
      INSERT INTO mcp_servers (name, description, transport_type, tools, oauth_required) VALUES
      ('polsia_infra', 'Infraestructura Polsia - crear instancias, desplegar, logs, base de datos',
        'stdio',
        '["create_instance", "push_to_remote", "get_logs", "query_db", "get_status", "list_instances", "get_preview", "delete_instance"]',
        false
      ),
      ('brave_search', 'Búsqueda web con Brave Search API',
        'stdio',
        '["brave_web_search", "brave_local_search", "brave_news_search", "brave_image_search"]',
        false
      ),
      ('stripe', 'Pagos y suscripciones con Stripe',
        'stdio',
        '["create_payment_link", "get_balance", "get_transactions", "create_subscription_link"]',
        false
      ),
      ('postmark', 'Envío de correos electrónicos',
        'stdio',
        '["send_email", "send_batch_emails", "get_subscribers", "get_email_history"]',
        false
      ),
      ('twitter', 'Publicación en Twitter/X',
        'stdio',
        '["post_tweet", "get_timeline"]',
        true
      ),
      ('browserbase', 'Automatización de navegador con Browserbase',
        'stdio',
        '["navigate", "click", "type", "screenshot", "extract_content"]',
        false
      ),
      ('github', 'Operaciones Git y GitHub',
        'stdio',
        '["create_pr", "merge_pr", "get_issues", "create_branch"]',
        true
      ),
      ('openai_proxy', 'Proxy de OpenAI para tareas de IA',
        'stdio',
        '["chat_completion", "embeddings", "image_generation", "ocr"]',
        false
      ),
      ('r2_storage', 'Almacenamiento Cloudflare R2',
        'stdio',
        '["upload_file", "get_file", "list_files", "delete_file"]',
        false
      ),
      ('company_email', 'Correo electrónico de empresa',
        'stdio',
        '["send_email", "receive_email", "list_inbox"]',
        false
      )
      ON CONFLICT (name) DO NOTHING
    `);

    // Map agents to their MCP servers
    await client.query(`
      INSERT INTO agent_mcp_servers (agent_id, mcp_server_id, is_required)
      SELECT a.id, m.id, true
      FROM agents a, mcp_servers m
      WHERE (a.name = 'engineering' AND m.name IN ('polsia_infra', 'github'))
         OR (a.name = 'browser' AND m.name IN ('browserbase'))
         OR (a.name = 'research' AND m.name IN ('brave_search'))
         OR (a.name = 'growth' AND m.name IN ('twitter', 'postmark', 'stripe'))
         OR (a.name = 'data' AND m.name IN ('polsia_infra'))
         OR (a.name = 'support' AND m.name IN ('company_email'))
         OR (a.name = 'content' AND m.name IN ('openai_proxy', 'r2_storage'))
         OR (a.name = 'ops' AND m.name IN ('polsia_infra'))
      ON CONFLICT (agent_id, mcp_server_id) DO NOTHING
    `);
  }
};
