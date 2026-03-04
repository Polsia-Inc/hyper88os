module.exports = {
  name: 'task_queue',
  up: async (client) => {
    // Tasks table - core task queue for Polsia ES
    await client.query(`
      CREATE TABLE tasks (
        id SERIAL PRIMARY KEY,
        title VARCHAR(500) NOT NULL,
        description TEXT DEFAULT '',
        status VARCHAR(50) NOT NULL DEFAULT 'todo',
        tag VARCHAR(100) DEFAULT 'general',
        priority VARCHAR(20) NOT NULL DEFAULT 'medium',
        complexity INTEGER DEFAULT 3 CHECK (complexity >= 1 AND complexity <= 10),
        estimated_hours DECIMAL(5,2) DEFAULT 1.0,
        assigned_agent VARCHAR(255),
        company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
        created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        sort_order INTEGER DEFAULT 0,
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes for common queries
    await client.query(`CREATE INDEX tasks_status_idx ON tasks(status)`);
    await client.query(`CREATE INDEX tasks_priority_idx ON tasks(priority)`);
    await client.query(`CREATE INDEX tasks_tag_idx ON tasks(tag)`);
    await client.query(`CREATE INDEX tasks_company_idx ON tasks(company_id)`);
    await client.query(`CREATE INDEX tasks_created_by_idx ON tasks(created_by)`);
    await client.query(`CREATE INDEX tasks_sort_order_idx ON tasks(sort_order)`);

    // Task status history - tracks every status change
    await client.query(`
      CREATE TABLE task_status_history (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        old_status VARCHAR(50),
        new_status VARCHAR(50) NOT NULL,
        changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        note TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX task_status_history_task_idx ON task_status_history(task_id)`);

    // Task execution logs - detailed logs per task
    await client.query(`
      CREATE TABLE task_logs (
        id SERIAL PRIMARY KEY,
        task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        level VARCHAR(20) DEFAULT 'info',
        message TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX task_logs_task_idx ON task_logs(task_id)`);
    await client.query(`CREATE INDEX task_logs_level_idx ON task_logs(level)`);
  }
};
