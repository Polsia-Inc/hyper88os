/**
 * Structured JSON Logger for Production
 * Outputs JSON logs for easy parsing by log aggregation tools
 */

const LOG_LEVELS = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4
};

const currentLevel = process.env.LOG_LEVEL || 'info';
const currentLevelValue = LOG_LEVELS[currentLevel] || LOG_LEVELS.info;

function log(level, message, metadata = {}) {
  if (LOG_LEVELS[level] < currentLevelValue) {
    return; // Skip logs below current level
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    level: level.toUpperCase(),
    message,
    ...metadata,
    environment: process.env.NODE_ENV || 'development',
    service: 'polsia-es'
  };

  // Add stack trace for errors
  if (level === 'error' || level === 'fatal') {
    if (metadata.error instanceof Error) {
      logEntry.error = {
        message: metadata.error.message,
        stack: metadata.error.stack,
        name: metadata.error.name
      };
      delete logEntry.error; // Remove from top-level to avoid duplicate
      logEntry.error_message = metadata.error.message;
      logEntry.error_stack = metadata.error.stack;
    }
  }

  const output = JSON.stringify(logEntry);

  // Write to stderr for errors, stdout for everything else
  if (level === 'error' || level === 'fatal') {
    console.error(output);
  } else {
    console.log(output);
  }
}

module.exports = {
  debug: (message, meta) => log('debug', message, meta),
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
  fatal: (message, meta) => log('fatal', message, meta),

  // Helper for HTTP requests
  http: (req, res, duration) => {
    log('info', 'HTTP request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration_ms: duration,
      ip: req.ip,
      user_agent: req.headers['user-agent'],
      user_id: req.user?.id || null
    });
  },

  // Helper for database queries
  db: (query, duration, error = null) => {
    if (error) {
      log('error', 'Database query failed', {
        query: query.substring(0, 200), // Truncate long queries
        duration_ms: duration,
        error
      });
    } else {
      log('debug', 'Database query', {
        query: query.substring(0, 200),
        duration_ms: duration
      });
    }
  }
};
