module.exports = {
  name: 'agent_framework',
  up: async (client) => {
    // Agents table - registry of all available agents
    await client.query(`
      CREATE TABLE IF NOT EXISTS agents (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        type VARCHAR(100) NOT NULL,
        description TEXT,
        capabilities JSONB DEFAULT '[]',
        mcp_requirements JSONB DEFAULT '[]',
        is_active BOOLEAN DEFAULT true,
        config JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS agents_type_idx ON agents(type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agents_is_active_idx ON agents(is_active)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agents_name_idx ON agents(name)`);

    // Agent execution history - tracks agent task execution
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_executions (
        id SERIAL PRIMARY KEY,
        agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
        status VARCHAR(50) NOT NULL DEFAULT 'running',
        success BOOLEAN,
        duration_ms INTEGER,
        error_message TEXT,
        metadata JSONB DEFAULT '{}',
        started_at TIMESTAMPTZ DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS agent_executions_agent_idx ON agent_executions(agent_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agent_executions_task_idx ON agent_executions(task_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agent_executions_status_idx ON agent_executions(status)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agent_executions_success_idx ON agent_executions(success)`);

    // Agent performance metrics - aggregated stats per agent
    await client.query(`
      CREATE TABLE IF NOT EXISTS agent_metrics (
        id SERIAL PRIMARY KEY,
        agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        metric_type VARCHAR(100) NOT NULL,
        metric_value DECIMAL(10,2) NOT NULL,
        recorded_at TIMESTAMPTZ DEFAULT NOW(),
        metadata JSONB DEFAULT '{}'
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS agent_metrics_agent_idx ON agent_metrics(agent_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agent_metrics_type_idx ON agent_metrics(metric_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS agent_metrics_recorded_idx ON agent_metrics(recorded_at)`);

    // Seed the 8 agent types
    await client.query(`
      INSERT INTO agents (name, type, description, capabilities, mcp_requirements, config) VALUES
      ('engineering', 'engineering', 'Agente de ingeniería - escribe código, arregla bugs y despliega a producción',
        '["code_writing", "debugging", "deployment", "git_operations", "testing", "migrations", "api_development"]',
        '["polsia_infra", "github", "bash"]',
        '{"primary_language": "javascript", "frameworks": ["express", "react"], "database": "postgresql"}'
      ),
      ('browser', 'browser', 'Agente de navegación - automatiza tareas de navegador y extrae datos de la web',
        '["web_scraping", "browser_automation", "form_filling", "screenshot", "pdf_generation"]',
        '["browserbase", "stagehand"]',
        '{"headless": true, "timeout": 30000}'
      ),
      ('research', 'research', 'Agente de investigación - busca información, analiza competidores y genera informes',
        '["web_search", "competitive_analysis", "report_generation", "data_analysis", "trend_analysis"]',
        '["brave_search", "web_fetch"]',
        '{"sources": ["web", "news", "academic"], "depth": "thorough"}'
      ),
      ('growth', 'growth', 'Agente de crecimiento - gestiona marketing, SEO, redes sociales y adquisición de usuarios',
        '["seo_optimization", "social_media", "email_campaigns", "analytics", "conversion_optimization"]',
        '["twitter", "postmark", "stripe"]',
        '{"channels": ["twitter", "email", "seo"], "automation_level": "high"}'
      ),
      ('data', 'data', 'Agente de datos - analiza métricas, genera reportes y optimiza bases de datos',
        '["data_analysis", "metrics_calculation", "database_optimization", "reporting", "visualization"]',
        '["postgres"]',
        '{"database_type": "postgresql", "analytics_tools": ["sql", "aggregations"]}'
      ),
      ('support', 'support', 'Agente de soporte - maneja tickets de usuarios, responde preguntas y gestiona incidencias',
        '["ticket_handling", "user_communication", "issue_triage", "knowledge_base", "escalation"]',
        '["company_email", "database"]',
        '{"response_time": "fast", "escalation_threshold": "high_priority"}'
      ),
      ('content', 'content', 'Agente de contenido - crea textos, diseña UI y optimiza experiencia de usuario',
        '["copywriting", "ui_design", "content_optimization", "localization", "brand_consistency"]',
        '["openai_proxy", "r2_storage"]',
        '{"tone": "professional", "languages": ["es", "en"]}'
      ),
      ('ops', 'ops', 'Agente de operaciones - gestiona infraestructura, monitoreo y mantenimiento del sistema',
        '["infrastructure_monitoring", "backup_management", "security_audits", "performance_optimization", "incident_response"]',
        '["polsia_infra", "database", "monitoring"]',
        '{"monitoring_interval": "5m", "alert_threshold": "critical"}'
      )
      ON CONFLICT (name) DO NOTHING
    `);
  }
};
