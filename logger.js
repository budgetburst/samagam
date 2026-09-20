/**
 * logger.js
 * Non-sensitive, structured logging utility for Render.com.
 * Guarantees that passwords, session cookies, and security tokens are redacted from stdout/logs.
 */

function getSensitiveValues() {
  const sensitive = [];
  const vars = [
    process.env.KVS_UNIVERSAL_PASSWORD,
    process.env.KVS_PASSWORD_1,
    process.env.KVS_PASSWORD_2,
    process.env.KVS_ALTERNATE_PASSWORD,
    'samagam', // explicitly safeguard universal password value
  ];
  for (const v of vars) {
    if (v && typeof v === 'string' && v.length > 2 && !sensitive.includes(v)) {
      sensitive.push(v);
    }
  }
  return sensitive;
}

function sanitize(value) {
  if (value === null || value === undefined) return value;

  if (typeof value === 'object') {
    if (value instanceof Error) {
      return sanitize(value.stack || value.message);
    }
    const cloned = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value)) {
      const lowerKey = key.toLowerCase();
      if (
        lowerKey.includes('password') ||
        lowerKey.includes('cookie') ||
        lowerKey.includes('token') ||
        lowerKey.includes('secret') ||
        lowerKey.includes('auth') ||
        lowerKey.includes('session')
      ) {
        cloned[key] = '[REDACTED]';
      } else {
        cloned[key] = sanitize(value[key]);
      }
    }
    return cloned;
  }

  let text = String(value);
  const sensitiveList = getSensitiveValues();
  for (const s of sensitiveList) {
    text = text.split(s).join('[REDACTED]');
  }

  // Redact potential cookie / token patterns
  text = text.replace(/ci_session=[a-zA-Z0-9%_-]+/gi, 'ci_session=[REDACTED]');
  text = text.replace(/csrf_test_name=[a-f0-9]{32,64}/gi, 'csrf_test_name=[REDACTED]');
  text = text.replace(/cf-turnstile-response=[a-zA-Z0-9._-]+/gi, 'cf-turnstile-response=[REDACTED]');

  return text;
}

function formatLog(level, message, meta) {
  const timestamp = new Date().toISOString();
  const safeMessage = sanitize(message);
  let output = `[${timestamp}] [${level}] ${safeMessage}`;
  if (meta !== undefined) {
    output += ` | data: ${JSON.stringify(sanitize(meta))}`;
  }
  return output;
}

const logger = {
  info: (message, meta) => {
    console.log(formatLog('INFO', message, meta));
  },
  warn: (message, meta) => {
    console.warn(formatLog('WARN', message, meta));
  },
  error: (message, meta) => {
    console.error(formatLog('ERROR', message, meta));
  },
  debug: (message, meta) => {
    if (process.env.DEBUG === 'true') {
      console.log(formatLog('DEBUG', message, meta));
    }
  },
  sanitize
};

module.exports = logger;
