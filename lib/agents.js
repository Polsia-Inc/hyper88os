const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

/**
 * Agent routing logic - matches tasks to best agent based on:
 * - Task tag (exact match preferred)
 * - Agent capabilities (overlap scoring)
 * - Historical success rate
 * - Agent availability (is_active)
 */
async function findBestAgent(task) {
  const { tag, title, description, complexity } = task;

  // Get all active agents
  const agentsResult = await pool.query(
    'SELECT * FROM agents WHERE is_active = true ORDER BY name'
  );
  const agents = agentsResult.rows;

  if (agents.length === 0) {
    return null;
  }

  // Score each agent
  const scoredAgents = await Promise.all(agents.map(async (agent) => {
    let score = 0;

    // 1. Tag match (highest priority)
    if (tag && agent.type === tag) {
      score += 100;
    }

    // 2. Capability match (check if task keywords match agent capabilities)
    const taskText = `${title} ${description}`.toLowerCase();
    const capabilities = Array.isArray(agent.capabilities) ? agent.capabilities : [];

    for (const capability of capabilities) {
      if (taskText.includes(capability.toLowerCase().replace(/_/g, ' '))) {
        score += 10;
      }
    }

    // 3. Historical success rate
    const historyResult = await pool.query(`
      SELECT
        COUNT(*) as total_executions,
        COUNT(*) FILTER (WHERE success = true) as successful_executions,
        AVG(duration_ms) as avg_duration
      FROM agent_executions
      WHERE agent_id = $1 AND completed_at IS NOT NULL
    `, [agent.id]);

    const history = historyResult.rows[0];
    if (history.total_executions > 0) {
      const successRate = history.successful_executions / history.total_executions;
      score += successRate * 50; // Up to 50 points for perfect success rate

      // Penalize slow agents slightly
      if (history.avg_duration > 60000) { // Over 1 minute average
        score -= 5;
      }
    }

    // 4. Complexity match (engineering agents better for high complexity)
    if (complexity >= 7 && agent.type === 'engineering') {
      score += 20;
    }

    return { agent, score };
  }));

  // Sort by score (highest first) and return best agent
  scoredAgents.sort((a, b) => b.score - a.score);
  return scoredAgents[0].agent;
}

/**
 * Start an agent execution for a task
 */
async function startAgentExecution(agentId, taskId) {
  const result = await pool.query(`
    INSERT INTO agent_executions (agent_id, task_id, status, started_at)
    VALUES ($1, $2, 'running', NOW())
    RETURNING *
  `, [agentId, taskId]);

  return result.rows[0];
}

/**
 * Complete an agent execution
 */
async function completeAgentExecution(executionId, success, durationMs, errorMessage = null, metadata = {}) {
  const result = await pool.query(`
    UPDATE agent_executions
    SET status = 'completed',
        success = $1,
        duration_ms = $2,
        error_message = $3,
        metadata = $4,
        completed_at = NOW()
    WHERE id = $5
    RETURNING *
  `, [success, durationMs, errorMessage, JSON.stringify(metadata), executionId]);

  return result.rows[0];
}

/**
 * Get agent statistics
 */
async function getAgentStats(agentId) {
  const result = await pool.query(`
    SELECT
      COUNT(*) as total_executions,
      COUNT(*) FILTER (WHERE success = true) as successful_executions,
      COUNT(*) FILTER (WHERE success = false) as failed_executions,
      COUNT(*) FILTER (WHERE status = 'running') as running_executions,
      AVG(duration_ms) as avg_duration_ms,
      MAX(completed_at) as last_execution
    FROM agent_executions
    WHERE agent_id = $1
  `, [agentId]);

  return result.rows[0];
}

/**
 * Get all agents with their stats
 */
async function getAllAgentsWithStats() {
  const agentsResult = await pool.query('SELECT * FROM agents ORDER BY type, name');
  const agents = agentsResult.rows;

  const agentsWithStats = await Promise.all(agents.map(async (agent) => {
    const stats = await getAgentStats(agent.id);
    return {
      ...agent,
      stats
    };
  }));

  return agentsWithStats;
}

/**
 * Get agent execution history
 */
async function getAgentExecutionHistory(agentId, limit = 50) {
  const result = await pool.query(`
    SELECT
      ae.*,
      t.title as task_title,
      t.tag as task_tag,
      t.status as task_status
    FROM agent_executions ae
    LEFT JOIN tasks t ON ae.task_id = t.id
    WHERE ae.agent_id = $1
    ORDER BY ae.started_at DESC
    LIMIT $2
  `, [agentId, limit]);

  return result.rows;
}

/**
 * Record agent metric
 */
async function recordAgentMetric(agentId, metricType, metricValue, metadata = {}) {
  const result = await pool.query(`
    INSERT INTO agent_metrics (agent_id, metric_type, metric_value, metadata)
    VALUES ($1, $2, $3, $4)
    RETURNING *
  `, [agentId, metricType, metricValue, JSON.stringify(metadata)]);

  return result.rows[0];
}

module.exports = {
  findBestAgent,
  startAgentExecution,
  completeAgentExecution,
  getAgentStats,
  getAllAgentsWithStats,
  getAgentExecutionHistory,
  recordAgentMetric,
  pool
};
