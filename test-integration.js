#!/usr/bin/env node
/**
 * Integration Test Script for Polsia ES
 * Tests all system integrations before production launch
 */

const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL not set');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const tests = [];
let passed = 0;
let failed = 0;

function test(name, fn) {
  tests.push({ name, fn });
}

async function runTests() {
  console.log('🧪 Running Integration Tests\n');

  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log(`✅ ${name}`);
      passed++;
    } catch (err) {
      console.log(`❌ ${name}`);
      console.error(`   Error: ${err.message}`);
      failed++;
    }
  }

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

// ===== DATABASE CONNECTIVITY =====
test('Database connection', async () => {
  const result = await pool.query('SELECT NOW()');
  if (!result.rows[0]) throw new Error('No result');
});

test('All required tables exist', async () => {
  const tables = [
    'users', 'companies', 'session',
    'subscription_plans', 'subscriptions', 'invoices', 'credits', 'usage_tracking',
    'tasks', 'task_status_history', 'task_logs',
    'agents', 'agent_executions', 'agent_metrics',
    'api_keys', 'api_rate_limits',
    'skills', 'mcp_servers', 'agent_mcp_servers',
    'memory_layers', 'memory_audit_log', 'conversation_summaries'
  ];

  for (const table of tables) {
    const result = await pool.query(
      `SELECT EXISTS (SELECT FROM information_schema.tables WHERE table_name = $1)`,
      [table]
    );
    if (!result.rows[0].exists) {
      throw new Error(`Table ${table} does not exist`);
    }
  }
});

// ===== AGENTS SYSTEM =====
test('8 agent types are seeded', async () => {
  const result = await pool.query('SELECT COUNT(*) as count FROM agents');
  const count = parseInt(result.rows[0].count);
  if (count < 8) throw new Error(`Only ${count} agents found, expected 8`);
});

test('Agent capabilities are valid JSON', async () => {
  const result = await pool.query('SELECT id, capabilities FROM agents');
  for (const row of result.rows) {
    if (!Array.isArray(row.capabilities)) {
      throw new Error(`Agent ${row.id} capabilities not array`);
    }
  }
});

// ===== TASKS ↔ AGENTS INTEGRATION =====
test('Tasks can reference agents', async () => {
  const taskResult = await pool.query('SELECT id FROM tasks LIMIT 1');
  const agentResult = await pool.query('SELECT id FROM agents LIMIT 1');

  if (taskResult.rows.length === 0) {
    // Create test task if none exist
    await pool.query(
      `INSERT INTO tasks (title, description, status, tag, priority)
       VALUES ($1, $2, $3, $4, $5)`,
      ['Test task', 'Integration test', 'todo', 'engineering', 'low']
    );
  }

  // Verify foreign key relationship works
  const agent = agentResult.rows[0];
  if (agent) {
    await pool.query(
      `INSERT INTO agent_executions (agent_id, status) VALUES ($1, 'running')`,
      [agent.id]
    );
  }
});

// ===== MEMORY SYSTEM =====
test('Memory layers structure is valid', async () => {
  const result = await pool.query(`
    SELECT layer, max_tokens FROM memory_layers
    WHERE company_id = (SELECT id FROM companies LIMIT 1)
  `);

  // Memory layers should be auto-created when accessed
  if (result.rows.length > 0) {
    for (const row of result.rows) {
      if (row.layer < 1 || row.layer > 3) {
        throw new Error(`Invalid layer ${row.layer}`);
      }
      if (row.max_tokens <= 0) {
        throw new Error(`Invalid max_tokens ${row.max_tokens}`);
      }
    }
  }
});

test('Memory search vector is configured', async () => {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'memory_layers' AND column_name = 'search_vector'
  `);
  if (result.rows.length === 0) {
    throw new Error('search_vector column not found');
  }
});

// ===== BILLING SYSTEM =====
test('Subscription plans are seeded', async () => {
  const result = await pool.query('SELECT COUNT(*) as count FROM subscription_plans');
  const count = parseInt(result.rows[0].count);
  if (count < 4) throw new Error(`Only ${count} plans found, expected 4`);
});

test('Plan pricing is consistent', async () => {
  const result = await pool.query(`
    SELECT slug, price_cents, task_credits FROM subscription_plans ORDER BY price_cents
  `);

  const plans = result.rows;
  if (plans[0].slug !== 'free' || plans[0].price_cents !== 0) {
    throw new Error('Free plan not configured correctly');
  }

  // Verify each paid plan has credits
  for (const plan of plans.slice(1)) {
    if (plan.task_credits <= 0) {
      throw new Error(`Plan ${plan.slug} has no credits`);
    }
  }
});

test('Credits tracking is functional', async () => {
  const result = await pool.query(`
    SELECT user_id, credits_total, credits_used
    FROM credits
    WHERE user_id = (SELECT id FROM users LIMIT 1)
    LIMIT 1
  `);

  // Verify credits logic
  if (result.rows.length > 0) {
    const { credits_total, credits_used } = result.rows[0];
    if (credits_used > credits_total) {
      throw new Error('Credits used exceeds total');
    }
  }
});

// ===== API KEYS & RATE LIMITING =====
test('API key rate limiting schema exists', async () => {
  const result = await pool.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'api_rate_limits'
  `);
  const columns = result.rows.map(r => r.column_name);
  if (!columns.includes('request_count')) {
    throw new Error('rate_limits missing request_count column');
  }
});

// ===== SKILLS & MCP SERVERS =====
test('Skills table is functional', async () => {
  const result = await pool.query('SELECT id, name, content FROM skills LIMIT 1');
  // Skills may be empty initially, just verify table is queryable
});

test('MCP servers table is functional', async () => {
  const result = await pool.query('SELECT id, name, transport_type FROM mcp_servers LIMIT 1');
  // MCP servers may be empty initially, just verify table is queryable
});

// ===== DATA INTEGRITY =====
test('All foreign keys are valid', async () => {
  // Check for orphaned records
  const checks = [
    { table: 'tasks', fk: 'company_id', ref: 'companies' },
    { table: 'agent_executions', fk: 'agent_id', ref: 'agents' },
    { table: 'subscriptions', fk: 'user_id', ref: 'users' },
    { table: 'memory_layers', fk: 'company_id', ref: 'companies' }
  ];

  for (const { table, fk, ref } of checks) {
    const result = await pool.query(`
      SELECT COUNT(*) as count FROM ${table} t
      WHERE t.${fk} IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${ref} r WHERE r.id = t.${fk})
    `);
    const orphans = parseInt(result.rows[0].count);
    if (orphans > 0) {
      throw new Error(`${orphans} orphaned records in ${table}.${fk}`);
    }
  }
});

test('Indexes are created', async () => {
  const result = await pool.query(`
    SELECT COUNT(*) as count FROM pg_indexes
    WHERE schemaname = 'public'
  `);
  const count = parseInt(result.rows[0].count);
  if (count < 20) {
    throw new Error(`Only ${count} indexes found, expected at least 20`);
  }
});

// Run all tests
runTests().finally(() => pool.end());
