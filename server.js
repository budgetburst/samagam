/**
 * server.js
 * Universal entrypoint for Render.com.
 *
 * Provides:
 * 1. Lightweight HTTP healthcheck server on PORT (default: 10000) for Render Web Services / uptime pings.
 * 2. Background worker automation engine execution (startAutomation).
 * 3. Works seamlessly on both Render Web Services (Free Tier) and Render Background Workers.
 */

require('dotenv').config();
const http = require('http');
const logger = require('./logger');
const { startAutomation, shutdown, getAutomationStatus } = require('./index');

const PORT = parseInt(process.env.PORT || '10000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Lightweight HTTP server using standard Node.js http module (no heavy frameworks needed)
const server = http.createServer((req, res) => {
  const url = req.url || '/';

  if (url === '/' || url === '/healthz' || url === '/status') {
    const status = getAutomationStatus();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'OK',
      service: 'kvs-samagam-render-automation',
      timestamp: new Date().toISOString(),
      automation: status,
    }, null, 2));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not Found');
});

server.listen(PORT, HOST, () => {
  logger.info(`Health check HTTP listener ready on ${HOST}:${PORT} (endpoints: /healthz, /status)`);
  
  // Launch the background automation engine
  startAutomation().catch((err) => {
    logger.error(`Failed to initialize background automation: ${err.message}`, err.stack);
  });
});

// Handle graceful termination
function handleServerShutdown(signal) {
  logger.info(`Shutting down HTTP server on ${signal}...`);
  server.close(() => {
    logger.info('HTTP server closed.');
    shutdown(signal);
  });
}

process.on('SIGTERM', () => handleServerShutdown('SIGTERM'));
process.on('SIGINT', () => handleServerShutdown('SIGINT'));
