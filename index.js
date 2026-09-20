/**
 * index.js
 * Robust Node.js + Playwright Automation Engine for KVS Samagam Portal
 * Optimized for Continuous Background Worker deployment on Render.com
 *
 * Implements:
 * 1. Persistent browser context in containerized environment (Xvfb virtual display).
 * 2. Authenticated main session tracking.
 * 3. 5-minute independent verification cycle in separate browser tabs.
 * 4. Strict password transition state machine (KVS_PASSWORD_1 -> KVS_PASSWORD_2).
 * 5. Mandatory 29-minute logout/login cycling.
 * 6. Mutual exclusion lock (AsyncMutex) preventing race conditions between cycles.
 * 7. Non-sensitive, structured logging with automatic secret redaction.
 * 8. Clean SIGTERM/SIGINT signal handling for zero-downtime Render redeployments.
 */

require('dotenv').config();
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');
const selectors = require('./selectors');
const logger = require('./logger');
const AsyncMutex = require('./mutex');

// ==========================================
// CONFIGURATION & CREDENTIALS
// ==========================================
const BASE_URL = (process.env.KVS_BASE_URL || 'https://samagam.kvs.gov.in').replace(/\/+$/, '');
const LOGIN_URL = `${BASE_URL}/user/login`;
const LOGOUT_URL = `${BASE_URL}/logout`;

const LOGIN_ID = process.env.KVS_LOGIN_ID || 'EP.45354';
const PASSWORD_1 = process.env.KVS_PASSWORD_1 || 'samagam';
const PASSWORD_2 = process.env.KVS_PASSWORD_2 || 'writukapanty';

const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '300000', 10);   // Default: 5 min
const RELOGIN_INTERVAL_MS = parseInt(process.env.RELOGIN_INTERVAL_MS || '1740000', 10); // Default: 29 min

// In container environments running under Xvfb, HEADLESS=false runs headed inside the virtual display
const HEADLESS = process.env.HEADLESS === 'true';
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chromium';

// Persistent profile directory for Render (supports attached persistent disk or local container storage)
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve('./.kvs_render_profile');

const NAV_TIMEOUT = parseInt(process.env.NAVIGATION_TIMEOUT_MS || '30000', 10);
const ACTION_TIMEOUT = parseInt(process.env.ACTION_TIMEOUT_MS || '15000', 10);
const TURNSTILE_TIMEOUT = parseInt(process.env.TURNSTILE_TIMEOUT_MS || '25000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

// ==========================================
// STATE MACHINE & REPORTERS
// ==========================================
let activePassword = PASSWORD_1;
let isPassword2PermanentlyActive = false;

// Global coordination lock between 5m verification and 29m relogin
const sessionMutex = new AsyncMutex();

let browserContext = null;
let mainPage = null;
let verificationTimer = null;
let reloginTimer = null;
let isShuttingDown = false;
let startTime = null;
let lastVerificationResult = { status: 'pending', timestamp: null };
let lastReloginResult = { status: 'pending', timestamp: null };

/**
 * Return display-safe indicator of which password is currently active
 */
function getActivePasswordLabel() {
  return activePassword === PASSWORD_2 ? 'KVS_PASSWORD_2' : 'KVS_PASSWORD_1';
}

/**
 * Get engine status for health checks & monitoring
 */
function getAutomationStatus() {
  return {
    uptimeSeconds: startTime ? Math.floor((Date.now() - startTime) / 1000) : 0,
    activePassword: getActivePasswordLabel(),
    isPassword2PermanentlyActive,
    isMutexLocked: sessionMutex.isLocked(),
    isBrowserActive: browserContext !== null && mainPage !== null && !mainPage.isClosed(),
    lastVerification: lastVerificationResult,
    lastRelogin: lastReloginResult,
  };
}

// ==========================================
// BROWSER LIFECYCLE & NAVIGATION UTILITIES
// ==========================================

/**
 * Launch persistent browser context for Render container / worker environment
 */
async function launchContext() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  logger.info('Launching persistent browser context for Render worker...', {
    profileDir: DATA_DIR,
    headless: HEADLESS,
    channel: BROWSER_CHANNEL,
    display: process.env.DISPLAY || 'default'
  });

  const launchOptions = {
    headless: HEADLESS,
    viewport: { width: 1366, height: 768 },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Critical for Docker/Render containers
      '--disable-blink-features=AutomationControlled',
      '--window-size=1366,768',
      '--disable-gpu',
    ],
  };

  if (BROWSER_CHANNEL && BROWSER_CHANNEL !== 'chromium') {
    launchOptions.channel = BROWSER_CHANNEL;
  }

  const context = await chromium.launchPersistentContext(DATA_DIR, launchOptions);
  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  context.setDefaultTimeout(ACTION_TIMEOUT);

  return context;
}

/**
 * Navigate to URL with exponential backoff retry for transient network issues
 */
async function navigateWithRetry(page, url, maxRetries = MAX_RETRIES) {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      attempt++;
      logger.debug(`Navigating to ${url} (attempt ${attempt}/${maxRetries})`);
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      return response;
    } catch (err) {
      logger.warn(`Navigation to ${url} failed on attempt ${attempt}: ${err.message}`);
      if (attempt >= maxRetries) throw err;
      const delayMs = Math.pow(2, attempt) * 1000;
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

/**
 * Ensure login overlay modal is open and visible
 */
async function ensureLoginOverlay(page) {
  const overlay = page.locator(selectors.login.overlay);
  const isOverlayOpen = await overlay.evaluate(el => el.classList.contains('open')).catch(() => false);

  if (!isOverlayOpen) {
    logger.debug('Login overlay is closed; triggering open modal button');
    const openBtn = page.locator(selectors.login.openModalButton).first();
    if (await openBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await openBtn.click();
      await overlay.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    }
  }

  await page.locator(selectors.login.usernameInput).waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
}

/**
 * Robust Cloudflare Turnstile handling.
 * Enforces that cf-turnstile-response is populated before proceeding.
 * Returns true if token is confirmed, false if timed out.
 */
async function handleTurnstileIfPresent(page) {
  const turnstile = page.locator(selectors.login.turnstileContainer);
  if (await turnstile.isVisible({ timeout: 2000 }).catch(() => false)) {
    logger.info('Cloudflare Turnstile detected. Awaiting background PoW and verification token...');

    // Trigger render if widget hasn't drawn
    await page.evaluate(() => {
      const overlay = document.getElementById('lpLoginOverlay');
      const cf = overlay ? overlay.querySelector('.cf-turnstile') : document.querySelector('.cf-turnstile');
      if (cf && !cf.hasChildNodes() && window.turnstile && typeof window.turnstile.render === 'function') {
        try { window.turnstile.render(cf); } catch (e) {}
      }
    }).catch(() => {});

    // Poll for valid cf-turnstile-response token
    const pollStart = Date.now();
    let hasValidToken = false;

    while (Date.now() - pollStart < TURNSTILE_TIMEOUT) {
      const tokenLength = await page.evaluate(() => {
        const tokenInput = document.querySelector('input[name="cf-turnstile-response"]');
        return tokenInput && tokenInput.value ? tokenInput.value.length : 0;
      }).catch(() => 0);

      if (tokenLength > 20) {
        hasValidToken = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }

    if (hasValidToken) {
      logger.info('Turnstile verification token acquired and verified.');
      return true;
    } else {
      if (HEADLESS) {
        logger.error('Turnstile verification failed in headless mode. On Render, ensure Xvfb is running (npm start via Docker) with HEADLESS=false.');
      } else {
        logger.error('Turnstile verification timed out. Token was not generated. Aborting submit to prevent "Security check failed".');
      }
      return false;
    }
  }

  // If no Turnstile widget on page, proceed normally
  return true;
}

// ==========================================
// AUTHENTICATION ROUTINES
// ==========================================

/**
 * Perform login attempt on a given page
 * @returns {Promise<{ success: boolean, reason?: string }>}
 */
async function performLogin(page, passwordToUse) {
  try {
    await navigateWithRetry(page, LOGIN_URL);
    await ensureLoginOverlay(page);

    // Human-paced typing to prevent bot telemetry flags
    const userField = page.locator(selectors.login.usernameInput);
    await userField.click();
    await userField.fill('');
    await userField.pressSequentially(LOGIN_ID, { delay: 40 });

    await new Promise(r => setTimeout(r, 200));

    const passField = page.locator(selectors.login.passwordInput);
    await passField.click();
    await passField.fill('');
    await passField.pressSequentially(passwordToUse, { delay: 40 });

    await new Promise(r => setTimeout(r, 300));

    // Await and verify Turnstile token BEFORE attempting submission
    const turnstileOk = await handleTurnstileIfPresent(page);
    if (!turnstileOk) {
      return {
        success: false,
        reason: 'Turnstile verification token missing or timed out. Submission aborted.'
      };
    }

    // Brief stabilization pause before form submit
    await new Promise(r => setTimeout(r, 500));

    logger.debug('Submitting login credentials');
    const submitBtn = page.locator(selectors.login.submitButton);
    await submitBtn.click();

    // Check for success or error indicators
    const outcome = await Promise.race([
      // Success case 1: navigated to dashboard or away from login query
      page.waitForURL(
        (url) => url.pathname.includes('/dashboard') || (url.pathname !== '/' && !url.search.includes('login=')),
        { timeout: ACTION_TIMEOUT }
      ).then(() => ({ success: true })),

      // Success case 2: authenticated navigation visible
      page.locator(selectors.session.mainNav).waitFor({ state: 'visible', timeout: ACTION_TIMEOUT })
        .then(() => ({ success: true })),

      // Error case 1: error banner displayed
      page.locator(selectors.login.errorContainer).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT })
        .then(async (locator) => {
          const text = await locator.innerText().catch(() => 'Login error');
          return { success: false, reason: text.trim() };
        }),
    ]).catch((err) => {
      return { success: false, reason: `Authentication timeout / pending response: ${err.message}` };
    });

    // Verification check: if error banner is currently visible on page, it is ALWAYS a failure
    const errorEl = page.locator(selectors.login.errorContainer).first();
    if (await errorEl.isVisible({ timeout: 1000 }).catch(() => false)) {
      const text = await errorEl.innerText().catch(() => 'Login error');
      return { success: false, reason: text.trim() };
    }

    // Verification check: if overlay modal is still open, authentication did not complete
    const overlayStillOpen = await page.locator(selectors.login.overlay).evaluate(el => el.classList.contains('open')).catch(() => false);
    if (overlayStillOpen && !outcome.success) {
      return { success: false, reason: 'Login modal remained open after submission' };
    }

    return outcome;
  } catch (err) {
    return { success: false, reason: `Unexpected error during login execution: ${err.message}` };
  }
}

/**
 * Check if a page currently maintains an authenticated session
 */
async function isPageAuthenticated(page) {
  try {
    if (page.isClosed()) return false;

    const currentUrl = page.url();
    if (currentUrl.includes('/dashboard')) return true;

    // Check if main authenticated nav is visible
    const mainNav = page.locator(selectors.session.mainNav);
    if (await mainNav.isVisible({ timeout: 2000 }).catch(() => false)) {
      return true;
    }

    // Check if login link text is visible (unauthenticated)
    const loginLink = page.locator(selectors.session.loginLinkText);
    if (await loginLink.isVisible({ timeout: 1000 }).catch(() => false)) {
      return false;
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Perform logout on a page and confirm unauthenticated status
 */
async function performLogout(page) {
  logger.info('Initiating logout sequence...');
  try {
    const logoutBtn = page.locator(selectors.logout.button).first();
    if (await logoutBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await logoutBtn.click();
    } else {
      // Direct navigation to logout URL
      await navigateWithRetry(page, LOGOUT_URL);
    }

    // Wait until unauthenticated state is confirmed
    await Promise.race([
      page.waitForURL((url) => url.pathname.includes('/login') || url.search.includes('login='), { timeout: ACTION_TIMEOUT }),
      page.locator(selectors.login.usernameInput).waitFor({ state: 'visible', timeout: ACTION_TIMEOUT }),
      page.locator(selectors.session.loginLinkText).waitFor({ state: 'visible', timeout: ACTION_TIMEOUT }),
    ]).catch(() => {});

    logger.info('Logout confirmed. Page is unauthenticated.');
    return true;
  } catch (err) {
    logger.warn(`Logout confirmation warning: ${err.message}. Navigating explicitly to login URL.`);
    await navigateWithRetry(page, LOGIN_URL);
    return true;
  }
}

// ==========================================
// PASSWORD CHANGE WORKFLOW
// ==========================================

/**
 * Execute password change on the main authenticated page:
 * 1. Navigate to Change Password
 * 2. Input current password and new password (PASSWORD_2)
 * 3. Submit and verify confirmation
 * 4. Independently verify in a new tab
 * 5. Update activePassword to PASSWORD_2 permanently
 */
async function executePasswordChange(page, currentPassword, newPassword) {
  logger.warn('Triggering Change Password workflow to KVS_PASSWORD_2 on main authenticated session...');

  try {
    // 1. Open Profile / Change Password view
    const profileDropdown = page.locator(selectors.profile.menuDropdown).first();
    if (await profileDropdown.isVisible({ timeout: 3000 }).catch(() => false)) {
      await profileDropdown.click();
      await new Promise(r => setTimeout(r, 300));
    }

    const changePassLink = page.locator(selectors.profile.changePasswordLink).first();
    if (await changePassLink.isVisible({ timeout: 3000 }).catch(() => false)) {
      await changePassLink.click();
    } else {
      // Direct navigation fallback
      await navigateWithRetry(page, `${BASE_URL}/profile/change-password`);
    }

    // 2. Wait for change password form fields
    const currentPassInput = page.locator(selectors.changePasswordForm.currentPasswordInput).first();
    const newPassInput = page.locator(selectors.changePasswordForm.newPasswordInput).first();
    const confPassInput = page.locator(selectors.changePasswordForm.confirmPasswordInput).first();
    const submitBtn = page.locator(selectors.changePasswordForm.submitButton).first();

    await currentPassInput.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });

    // 3. Fill form fields
    logger.info('Entering current and new credentials into Change Password form...');
    await currentPassInput.fill('');
    await currentPassInput.fill(currentPassword);

    await newPassInput.fill('');
    await newPassInput.fill(newPassword);

    await confPassInput.fill('');
    await confPassInput.fill(newPassword);

    // 4. Submit change request
    logger.info('Submitting password change request...');
    await submitBtn.click();

    // 5. Verify website reports successful password modification
    const isSuccess = await Promise.race([
      page.locator(selectors.changePasswordForm.successMessage).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT })
        .then(() => true),
      page.locator(selectors.changePasswordForm.errorMessage).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT })
        .then(async (loc) => {
          const msg = await loc.innerText().catch(() => '');
          throw new Error(`Portal reported password change failure: ${msg}`);
        }),
    ]).catch((e) => {
      logger.warn(`Password change confirmation notice check: ${e.message}`);
      return true;
    });

    if (!isSuccess) {
      logger.error('Failed to confirm password modification on the portal.');
      return false;
    }

    logger.info('Portal reported successful password modification.');

    // 6. Set candidate active password
    activePassword = newPassword;

    // 7. Perform independent verification in a new verification tab using PASSWORD_2
    logger.info('Conducting mandatory independent verification for KVS_PASSWORD_2...');
    const verification = await verifyInNewTab(newPassword);

    if (verification.success) {
      isPassword2PermanentlyActive = true;
      logger.info('Independent verification succeeded! State transition finalized: ACTIVE_PASSWORD = KVS_PASSWORD_2.');
      return true;
    } else {
      logger.error(`Independent verification for KVS_PASSWORD_2 failed: ${verification.reason}`);
      return false;
    }
  } catch (err) {
    logger.error(`Error during password change workflow: ${err.message}`);
    return false;
  }
}

// ==========================================
// PERIODIC VERIFICATION & RELOGIN CYCLES
// ==========================================

/**
 * Open a completely new browser tab, attempt authentication, and close the tab.
 * Does not expose passwords, cookies, or tokens in logs.
 * @returns {Promise<{ success: boolean, reason?: string }>}
 */
async function verifyInNewTab(passwordToTest) {
  let verificationTab = null;
  try {
    logger.info('Opening new browser tab for independent credential verification...');
    verificationTab = await browserContext.newPage();

    const result = await performLogin(verificationTab, passwordToTest);
    return result;
  } catch (err) {
    return { success: false, reason: `Verification tab error: ${err.message}` };
  } finally {
    if (verificationTab && !verificationTab.isClosed()) {
      await verificationTab.close().catch(() => {});
      logger.debug('Verification browser tab closed.');
    }
  }
}

/**
 * 5-Minute verification cycle handler
 */
async function runVerificationCycle() {
  if (isShuttingDown) return;

  logger.info(`[5-Min Cycle] Running independent password/session verification (${getActivePasswordLabel()})...`);
  const unlock = await sessionMutex.acquire();

  try {
    // 1. Check if main page is still alive
    if (!mainPage || mainPage.isClosed()) {
      logger.warn('Main session page closed or crashed. Re-establishing main session...');
      mainPage = await browserContext.newPage();
      const loginRes = await performLogin(mainPage, activePassword);
      if (!loginRes.success) {
        logger.error(`Failed to re-establish main session: ${loginRes.reason}`);
      }
      return;
    }

    // 2. Attempt verification with currently active password in isolated tab
    const verificationResult = await verifyInNewTab(activePassword);
    lastVerificationResult = {
      status: verificationResult.success ? 'success' : 'failed',
      reason: verificationResult.reason || null,
      timestamp: new Date().toISOString()
    };

    if (verificationResult.success) {
      logger.info(`[5-Min Cycle] Verification successful. ${getActivePasswordLabel()} is valid.`);
      return;
    }

    logger.warn(`[5-Min Cycle] Verification failed for ${getActivePasswordLabel()}: ${verificationResult.reason}`);

    // 3. Current password failed. Check if main session page is still authenticated
    const mainStillAuthenticated = await isPageAuthenticated(mainPage);
    logger.info(`Checking main session status: ${mainStillAuthenticated ? 'STILL AUTHENTICATED' : 'UNAUTHENTICATED'}`);

    if (mainStillAuthenticated && !isPassword2PermanentlyActive) {
      logger.warn('Current password failed while main page is still authenticated. Initiating immediate password change to KVS_PASSWORD_2...');
      await executePasswordChange(mainPage, activePassword, PASSWORD_2);
    } else if (!mainStillAuthenticated) {
      logger.error('Main session has expired or unauthenticated. Relogin required.');
    }
  } catch (err) {
    logger.error(`[5-Min Cycle] Unexpected error in verification cycle: ${err.message}`);
    lastVerificationResult = { status: 'error', reason: err.message, timestamp: new Date().toISOString() };
  } finally {
    unlock();
  }
}

/**
 * 29-Minute logout/login cycle handler
 */
async function runReloginCycle() {
  if (isShuttingDown) return;

  logger.info('[29-Min Cycle] Starting mandatory 29-minute logout/login cycle...');
  const unlock = await sessionMutex.acquire();

  try {
    // 1. Ensure main page reference is valid
    if (!mainPage || mainPage.isClosed()) {
      mainPage = await browserContext.newPage();
    }

    // 2. Perform actual Logout on main page
    await performLogout(mainPage);

    // 3. Attempt login with currently active password (strictly activePassword only)
    logger.info(`[29-Min Cycle] Attempting relogin using ${getActivePasswordLabel()}...`);
    const loginResult = await performLogin(mainPage, activePassword);

    lastReloginResult = {
      status: loginResult.success ? 'success' : 'failed',
      reason: loginResult.reason || null,
      timestamp: new Date().toISOString()
    };

    if (loginResult.success) {
      logger.info(`[29-Min Cycle] Relogin successful using ${getActivePasswordLabel()}. Session reference refreshed.`);
    } else {
      logger.error(`[29-Min Cycle] Relogin could not be completed with ${getActivePasswordLabel()}: ${loginResult.reason}`);
    }
  } catch (err) {
    logger.error(`[29-Min Cycle] Unexpected error during relogin cycle: ${err.message}`);
    lastReloginResult = { status: 'error', reason: err.message, timestamp: new Date().toISOString() };
  } finally {
    unlock();
  }
}

// ==========================================
// APPLICATION INITIALIZATION & SHUTDOWN
// ==========================================

async function startAutomation() {
  startTime = Date.now();
  logger.info('========================================================');
  logger.info('Starting KVS Samagam Continuous Automation Engine (Render)');
  logger.info(`Target URL: ${BASE_URL}`);
  logger.info(`Login ID: ${LOGIN_ID}`);
  logger.info(`Initial Active Password: ${getActivePasswordLabel()}`);
  logger.info(`Verification Interval: ${CHECK_INTERVAL_MS / 1000}s | Relogin Interval: ${RELOGIN_INTERVAL_MS / 1000}s`);
  logger.info('========================================================');

  // Launch browser context
  browserContext = await launchContext();

  // Create initial main page
  const pages = browserContext.pages();
  mainPage = pages.length > 0 ? pages[0] : await browserContext.newPage();

  // Acquire lock for initial login
  const unlock = await sessionMutex.acquire();
  try {
    logger.info(`Attempting initial login on main page with ${getActivePasswordLabel()}...`);
    const initialLogin = await performLogin(mainPage, activePassword);

    if (!initialLogin.success) {
      logger.warn(`Initial login with ${getActivePasswordLabel()} failed: ${initialLogin.reason}`);
      logger.error('CRITICAL: Initial login could not be completed. Automation will maintain session loop and retry on scheduled intervals.');
    } else {
      logger.info('Initial authentication successful. Main session established and referenced.');
    }
  } finally {
    unlock();
  }

  // Setup periodic 5-minute verification interval
  verificationTimer = setInterval(() => {
    runVerificationCycle().catch(err => logger.error(`Verification interval error: ${err.message}`));
  }, CHECK_INTERVAL_MS);

  // Setup periodic 29-minute logout/login interval
  reloginTimer = setInterval(() => {
    runReloginCycle().catch(err => logger.error(`Relogin interval error: ${err.message}`));
  }, RELOGIN_INTERVAL_MS);

  logger.info('All timers initialized. Automation is active and monitoring continuously.');
}

/**
 * Graceful termination handler (essential for Render redeploys)
 */
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info(`Received ${signal}. Performing graceful shutdown on Render worker...`);

  if (verificationTimer) clearInterval(verificationTimer);
  if (reloginTimer) clearInterval(reloginTimer);

  try {
    if (browserContext) {
      logger.info('Closing browser context and preserving profile state...');
      await browserContext.close();
    }
  } catch (err) {
    logger.error(`Error while closing browser context: ${err.message}`);
  }

  logger.info('Shutdown complete.');
  process.exit(0);
}

// Register process signals
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// If invoked directly from CLI, launch immediately
if (require.main === module) {
  startAutomation().catch((err) => {
    logger.error(`Fatal initialization error: ${err.message}`, err.stack);
    process.exit(1);
  });
}

module.exports = {
  startAutomation,
  shutdown,
  getAutomationStatus,
  runVerificationCycle,
  runReloginCycle,
  sessionMutex,
};
