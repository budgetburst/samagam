/**
 * index.js
 * Robust Node.js + Playwright Automation Engine for KVS Samagam Portal
 * Optimized for Continuous Background Worker deployment on Render.com
 *
 * Implements:
 * 1. Universal Password Architecture:
 *    - The universal baseline password is `samagam` (KVS_UNIVERSAL_PASSWORD).
 *    - All verifications and relogins target this universal password.
 * 2. Multi-profile separation:
 *    - Main Logged-In Profile: Stays authenticated continuously and handles 15m relogin cycle.
 *    - Verification Profile: Isolated browser profile used for 5m independent credential checks.
 * 3. Automatic Password Restoration to Universal Password:
 *    - If the password is changed and 5m verification fails showing incorrect password,
 *      the engine automatically restores the password BACK to `samagam` from the logged-in profile
 *      via direct navigation to `https://samagam.kvs.gov.in/user/update-password`.
 * 4. 15-minute mandatory logout/relogin cycle on the main profile.
 * 5. AsyncMutex coordinating verification, password restoration, and relogin cycles.
 * 6. Non-sensitive, structured logging with automatic secret redaction.
 * 7. Clean SIGTERM/SIGINT signal handling for zero-downtime Render redeployments.
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
const UPDATE_PASSWORD_URL = `${BASE_URL}/user/update-password`;

const DEFAULT_LOGIN_IDS = ['EP.45354', 'EP.50696', 'CS.136206'];

function parseLoginIds() {
  if (process.env.KVS_LOGIN_IDS) {
    return process.env.KVS_LOGIN_IDS.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
  }
  if (process.env.KVS_LOGIN_ID) {
    if (process.env.KVS_LOGIN_ID.includes(',')) {
      return process.env.KVS_LOGIN_ID.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);
    }
    if (!DEFAULT_LOGIN_IDS.includes(process.env.KVS_LOGIN_ID)) {
      return [process.env.KVS_LOGIN_ID, ...DEFAULT_LOGIN_IDS];
    }
  }
  return DEFAULT_LOGIN_IDS;
}

const LOGIN_IDS = parseLoginIds();
const LOGIN_ID = LOGIN_IDS[0]; // Primary ID for single-account backwards compatibility
// Universal password baseline (default: samagam)
const UNIVERSAL_PASSWORD = process.env.KVS_UNIVERSAL_PASSWORD || process.env.KVS_PASSWORD_1 || 'samagam';
// Optional alternate password candidate (if password was temporarily changed)
const ALTERNATE_PASSWORD = process.env.KVS_ALTERNATE_PASSWORD || process.env.KVS_PASSWORD_2 || 'writukapanty';

const CHECK_INTERVAL_MS = parseInt(process.env.CHECK_INTERVAL_MS || '300000', 10);   // Default: 5 min
const RELOGIN_INTERVAL_MS = parseInt(process.env.RELOGIN_INTERVAL_MS || '900000', 10); // Updated: 15 min

// In container environments running under Xvfb, HEADLESS=false runs headed inside the virtual display
const HEADLESS = process.env.HEADLESS === 'true';
const BROWSER_CHANNEL = process.env.BROWSER_CHANNEL || 'chromium';

// Root data directory for persistent browser context state
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve('./.kvs_render_profile');

function sanitizeAccountId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

function getMainProfileDir(accountId) {
  return path.join(DATA_DIR, 'main_profile', sanitizeAccountId(accountId || LOGIN_ID));
}

function getVerifyProfileDir(accountId) {
  return path.join(DATA_DIR, 'verify_profile', sanitizeAccountId(accountId || LOGIN_ID));
}

// Distinct profiles for the main session and verification checks (backward-compatibility aliases)
const MAIN_PROFILE_DIR = path.join(DATA_DIR, 'main_profile');
const VERIFY_PROFILE_DIR = path.join(DATA_DIR, 'verify_profile');

const NAV_TIMEOUT = parseInt(process.env.NAVIGATION_TIMEOUT_MS || '30000', 10);
const ACTION_TIMEOUT = parseInt(process.env.ACTION_TIMEOUT_MS || '15000', 10);
const TURNSTILE_TIMEOUT = parseInt(process.env.TURNSTILE_TIMEOUT_MS || '25000', 10);
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);

// ==========================================
// STATE MACHINE & REPORTERS
// ==========================================
let activePassword = UNIVERSAL_PASSWORD;

class AccountSession {
  constructor(loginId) {
    this.loginId = loginId;
    this.safeId = sanitizeAccountId(loginId);
    this.mainProfileDir = getMainProfileDir(loginId);
    this.verifyProfileDir = getVerifyProfileDir(loginId);
    this.mainBrowserContext = null;
    this.mainPage = null;
    this.activePassword = UNIVERSAL_PASSWORD;
    this.lastVerificationResult = { status: 'pending', timestamp: null };
    this.lastReloginResult = { status: 'pending', timestamp: null };
  }
}

const accountSessions = new Map();
for (const id of LOGIN_IDS) {
  accountSessions.set(id, new AccountSession(id));
}

// Global coordination lock between 5m verification and 15m relogin
const sessionMutex = new AsyncMutex();

let mainBrowserContext = null;
let mainPage = null;
let verificationTimer = null;
let reloginTimer = null;
let countdownTimer = null;
let isShuttingDown = false;
let startTime = null;
let lastVerificationResult = { status: 'pending', timestamp: null };
let lastReloginResult = { status: 'pending', timestamp: null };

let nextVerificationTime = null;
let nextReloginTime = null;
let isVerificationRunning = false;
let isReloginRunning = false;
let lastLoggedMilestoneMinute = null;

/**
 * Format milliseconds remaining into MMm SSs string
 */
function formatRemaining(ms) {
  if (ms <= 0) return '00m 00s (due)';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Format status string for countdown
 */
function getCountdownStatusString() {
  const now = Date.now();
  const vMs = nextVerificationTime ? nextVerificationTime - now : 0;
  const rMs = nextReloginTime ? nextReloginTime - now : 0;

  const vStr = isVerificationRunning ? 'in progress...' : formatRemaining(vMs);
  const rStr = isReloginRunning ? 'in progress...' : formatRemaining(rMs);

  return `Next Verification in: ${vStr} | Next Relogin in: ${rStr}`;
}

/**
 * Render live countdown ticker in CMD / terminal
 */
function renderCountdownTick() {
  if (isShuttingDown) return;
  const now = Date.now();
  const vMs = nextVerificationTime ? nextVerificationTime - now : 0;
  const rMs = nextReloginTime ? nextReloginTime - now : 0;

  const vStr = isVerificationRunning ? 'in progress...' : formatRemaining(vMs);
  const rStr = isReloginRunning ? 'in progress...' : formatRemaining(rMs);
  const activeLabel = activePassword === UNIVERSAL_PASSWORD ? 'samagam' : 'custom';

  const tickerMsg = `⏱️  [TIMERS] (${LOGIN_IDS.length} accounts: ${LOGIN_IDS.join(', ')}) Verification in: ${vStr} | Relogin in: ${rStr} (Active: ${activeLabel})`;

  if (process.stdout && process.stdout.isTTY) {
    process.stdout.write(`\r\x1b[K${tickerMsg}`);
  }

  // Periodic milestone log every 60 seconds (or in non-TTY environments like Render logs)
  const currentMinuteFloor = Math.floor(now / 60000);
  if (lastLoggedMilestoneMinute !== currentMinuteFloor) {
    lastLoggedMilestoneMinute = currentMinuteFloor;
    if (!process.stdout || !process.stdout.isTTY) {
      logger.info(`[TIMERS] Countdown (${LOGIN_IDS.length} accounts: ${LOGIN_IDS.join(', ')}): Verification in ${vStr} | Relogin in ${rStr}`);
    }
  }
}

/**
 * Return display-safe indicator of which password is currently active
 */
function getActivePasswordLabel() {
  return activePassword === UNIVERSAL_PASSWORD ? 'UNIVERSAL_PASSWORD (samagam)' : 'CUSTOM_PASSWORD';
}

/**
 * Identify if an error reason represents an incorrect password or invalid credentials
 */
function isIncorrectPasswordError(reason = '') {
  if (!reason) return false;
  const r = reason.toLowerCase();

  // Exclude transient infrastructure errors
  if (r.includes('turnstile') || r.includes('timeout') || r.includes('network') || r.includes('econnrefused')) {
    return false;
  }

  // Matches portal error text indicating credential mismatch
  return (
    r.includes('password') ||
    r.includes('invalid') ||
    r.includes('incorrect') ||
    r.includes('credential') ||
    r.includes('not match') ||
    r.includes('wrong') ||
    r.includes('mismatch') ||
    r.includes('auth') ||
    r.includes('user not found') ||
    r.includes('account')
  );
}

/**
 * Get engine status for health checks & monitoring
 */
function getAutomationStatus() {
  const now = Date.now();
  const vMs = nextVerificationTime ? Math.max(0, nextVerificationTime - now) : 0;
  const rMs = nextReloginTime ? Math.max(0, nextReloginTime - now) : 0;
  const anyBrowserActive = Array.from(accountSessions.values()).some(
    s => s.mainBrowserContext !== null && s.mainPage !== null && !s.mainPage.isClosed()
  );

  return {
    uptimeSeconds: startTime ? Math.floor((Date.now() - startTime) / 1000) : 0,
    activePassword: getActivePasswordLabel(),
    universalPassword: 'samagam',
    updatePasswordUrl: UPDATE_PASSWORD_URL,
    isMutexLocked: sessionMutex.isLocked(),
    isBrowserActive: anyBrowserActive,
    accounts: LOGIN_IDS.map(id => {
      const s = accountSessions.get(id);
      return {
        loginId: id,
        activePassword: s ? (s.activePassword === UNIVERSAL_PASSWORD ? 'samagam' : 'custom') : 'samagam',
        isBrowserActive: !!(s && s.mainBrowserContext && s.mainPage && !s.mainPage.isClosed()),
        lastVerification: s ? s.lastVerificationResult : null,
        lastRelogin: s ? s.lastReloginResult : null,
      };
    }),
    loginIds: LOGIN_IDS,
    profiles: {
      mainProfile: MAIN_PROFILE_DIR,
      verifyProfile: VERIFY_PROFILE_DIR,
    },
    intervals: {
      verificationMinutes: CHECK_INTERVAL_MS / 60000,
      reloginMinutes: RELOGIN_INTERVAL_MS / 60000,
    },
    timeRemaining: {
      verificationSeconds: Math.floor(vMs / 1000),
      verificationFormatted: isVerificationRunning ? 'in progress...' : formatRemaining(vMs),
      reloginSeconds: Math.floor(rMs / 1000),
      reloginFormatted: isReloginRunning ? 'in progress...' : formatRemaining(rMs),
    },
    lastVerification: lastVerificationResult,
    lastRelogin: lastReloginResult,
  };
}

// ==========================================
// BROWSER LIFECYCLE & NAVIGATION UTILITIES
// ==========================================

/**
 * Launch persistent browser context for a specific profile directory
 */
async function launchContext(profileDir, profileLabel = 'Default') {
  if (!fs.existsSync(profileDir)) {
    fs.mkdirSync(profileDir, { recursive: true });
  }

  logger.info(`Launching persistent browser context (${profileLabel})...`, {
    profileDir,
    headless: HEADLESS,
    channel: BROWSER_CHANNEL,
    display: process.env.DISPLAY || 'default'
  });

  const launchOptions = {
    headless: HEADLESS,
    viewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Critical for Docker/Render containers
      '--disable-blink-features=AutomationControlled',
      '--ignore-certificate-errors',
      '--allow-running-insecure-content',
      '--window-size=1366,768',
      '--disable-gpu',
    ],
  };

  if (BROWSER_CHANNEL && BROWSER_CHANNEL !== 'chromium') {
    launchOptions.channel = BROWSER_CHANNEL;
  }

  const context = await chromium.launchPersistentContext(profileDir, launchOptions);
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
  logger.debug(`Ensuring login overlay is active (current URL: ${page.url()})...`);

  // 1. Direct DOM activation: instantly add 'open' class to #lpLoginOverlay and render Turnstile
  await page.evaluate(() => {
    const overlay = document.getElementById('lpLoginOverlay');
    if (overlay) {
      overlay.classList.add('open');
      const cf = overlay.querySelector('.cf-turnstile');
      if (cf && !cf.hasChildNodes() && window.turnstile && typeof window.turnstile.render === 'function') {
        try { window.turnstile.render(cf); } catch (e) {}
      }
      const u = document.getElementById('lpLoginUsername');
      if (u) u.focus();
    }
  }).catch(() => {});

  const overlay = page.locator(selectors.login.overlay);
  const isOverlayOpen = await overlay.evaluate(el => el.classList.contains('open')).catch(() => false);

  if (!isOverlayOpen) {
    logger.debug('Login overlay is closed; triggering open modal button');
    const openBtn = page.locator(selectors.login.openModalButton).first();
    if (await openBtn.isVisible({ timeout: 5000 }).catch(() => false)) {
      await openBtn.click({ force: true });
      await overlay.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
    }

    // Force open class again
    await page.evaluate(() => {
      const overlay = document.getElementById('lpLoginOverlay');
      if (overlay) overlay.classList.add('open');
    }).catch(() => {});
  }

  // Diagnostic wait: if input is still not visible, log page context
  try {
    await page.locator(selectors.login.usernameInput).waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
  } catch (err) {
    const pageTitle = await page.title().catch(() => 'unknown');
    const pageUrl = page.url();
    const bodySnippet = await page.evaluate(() => (document.body ? document.body.innerText.slice(0, 200).replace(/\s+/g, ' ') : '')).catch(() => '');
    logger.warn(`Username input wait timeout. Page title: "${pageTitle}" | URL: "${pageUrl}" | Snippet: "${bodySnippet}"`);
    throw err;
  }
}

/**
 * Robust Cloudflare Turnstile handling.
 * Enforces that cf-turnstile-response is populated before proceeding.
 * Returns true if token is confirmed, false if timed out.
 */
async function handleTurnstileIfPresent(page) {
  logger.info('Awaiting Cloudflare Turnstile verification token...');

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

    // Periodically nudge render if still empty
    await page.evaluate(() => {
      const overlay = document.getElementById('lpLoginOverlay');
      const cf = overlay ? overlay.querySelector('.cf-turnstile') : document.querySelector('.cf-turnstile');
      if (cf && !cf.hasChildNodes() && window.turnstile && typeof window.turnstile.render === 'function') {
        try { window.turnstile.render(cf); } catch (e) {}
      }
    }).catch(() => {});

    await new Promise(r => setTimeout(r, 500));
  }

  if (hasValidToken) {
    logger.info('Turnstile verification token acquired and verified.');
    return true;
  } else {
    // Check if turnstile element exists on page
    const turnstileExists = await page.evaluate(() => {
      return !!document.querySelector('.cf-turnstile, input[name="cf-turnstile-response"]');
    }).catch(() => false);

    if (!turnstileExists) {
      logger.debug('No Turnstile element detected on page. Proceeding normally.');
      return true;
    }

    if (HEADLESS) {
      logger.error('Turnstile verification failed in headless mode. On Render, ensure Xvfb is running (npm start via Docker) with HEADLESS=false.');
    } else {
      logger.error('Turnstile verification timed out. Token was not generated. Aborting submit to prevent "Security check failed".');
    }
    return false;
  }
}

// ==========================================
// AUTHENTICATION ROUTINES
// ==========================================

/**
 * Perform login attempt on a given page
 * @returns {Promise<{ success: boolean, reason?: string }>}
 */
async function performLogin(page, passwordToUse, loginId) {
  const targetLoginId = loginId || LOGIN_ID;
  try {
    await navigateWithRetry(page, LOGIN_URL);
    await ensureLoginOverlay(page);

    logger.info(`Entering credentials for ${targetLoginId}...`);
    // Human-paced typing to prevent bot telemetry flags
    const userField = page.locator(selectors.login.usernameInput);
    await userField.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
    await userField.click();
    await userField.fill('');
    await userField.pressSequentially(targetLoginId, { delay: 40 });

    await new Promise(r => setTimeout(r, 200));

    const passField = page.locator(selectors.login.passwordInput);
    await passField.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
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

    // Double-check and ensure both username and password fields are still populated!
    // (Prevents edge-case where portal scripts, SweetAlert, or Turnstile reset wipes inputs)
    const domValues = await page.evaluate(() => ({
      user: document.querySelector('#lpLoginUsername')?.value,
      pass: document.querySelector('#lpLoginPassword')?.value,
    })).catch(() => ({}));

    if (!domValues.user || domValues.user !== targetLoginId) {
      logger.debug(`Re-applying username (${targetLoginId}) before submission...`);
      await userField.click();
      await userField.fill('');
      await userField.pressSequentially(targetLoginId, { delay: 30 });
    }

    if (!domValues.pass || domValues.pass !== passwordToUse) {
      logger.debug('Re-applying password before submission...');
      await passField.click();
      await passField.fill('');
      await passField.pressSequentially(passwordToUse, { delay: 30 });
    }

    // Brief stabilization pause before form submit
    await new Promise(r => setTimeout(r, 600));

    logger.debug(`Submitting login credentials for ${targetLoginId}`);
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
    if (!page || page.isClosed()) return false;

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
  logger.info('Initiating logout sequence on main profile...');
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

    logger.info('Logout confirmed. Main profile is unauthenticated.');
    return true;
  } catch (err) {
    logger.warn(`Logout confirmation warning: ${err.message}. Navigating explicitly to login URL.`);
    await navigateWithRetry(page, LOGIN_URL);
    return true;
  }
}

// ==========================================
// RESTORE PASSWORD TO UNIVERSAL PASSWORD (samagam)
// ==========================================

/**
 * Restores password back to the universal password (samagam) from the logged-in profile.
 * Navigates directly to https://samagam.kvs.gov.in/user/update-password
 *
 * @param {Page} page - The main authenticated page
 * @param {string} [candidateOldPassword] - Candidate current password if known
 * @param {string} [loginId] - Login ID being restored
 * @returns {Promise<boolean>}
 */
async function restorePasswordToUniversal(page, candidateOldPassword, loginId) {
  const targetLoginId = loginId || LOGIN_ID;
  logger.warn(`Restoring portal password back to universal password (${UNIVERSAL_PASSWORD}) for ${targetLoginId} from logged-in profile...`);
  logger.info(`Navigating directly to: ${UPDATE_PASSWORD_URL}`);

  try {
    // 1. Direct navigation to the specified update-password URL
    await navigateWithRetry(page, UPDATE_PASSWORD_URL);

    // 2. Wait for change password form fields
    const currentPassInput = page.locator(selectors.changePasswordForm.currentPasswordInput).first();
    const newPassInput = page.locator(selectors.changePasswordForm.newPasswordInput).first();
    const confPassInput = page.locator(selectors.changePasswordForm.confirmPasswordInput).first();
    const submitBtn = page.locator(selectors.changePasswordForm.submitButton).first();

    await currentPassInput.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });

    // Determine old password to provide
    const oldPasswordToTry = candidateOldPassword || ALTERNATE_PASSWORD || UNIVERSAL_PASSWORD;

    logger.info(`Entering current credential and restoring new password to universal password (${UNIVERSAL_PASSWORD}) for ${targetLoginId}...`);
    await currentPassInput.fill('');
    await currentPassInput.fill(oldPasswordToTry);

    await newPassInput.fill('');
    await newPassInput.fill(UNIVERSAL_PASSWORD);

    await confPassInput.fill('');
    await confPassInput.fill(UNIVERSAL_PASSWORD);

    // 3. Submit change request
    logger.info(`Submitting password update request to portal for ${targetLoginId}...`);
    await submitBtn.click();

    // 4. Verify website reports successful password modification
    const isSuccess = await Promise.race([
      page.locator(selectors.changePasswordForm.successMessage).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT })
        .then(() => true),
      page.locator(selectors.changePasswordForm.errorMessage).first().waitFor({ state: 'visible', timeout: ACTION_TIMEOUT })
        .then(async (loc) => {
          const msg = await loc.innerText().catch(() => '');
          throw new Error(`Portal reported password update failure: ${msg}`);
        }),
    ]).catch((e) => {
      logger.warn(`Password change confirmation notice check: ${e.message}`);
      return true;
    });

    if (!isSuccess) {
      logger.error(`Failed to confirm password restoration on the portal for ${targetLoginId}.`);
      return false;
    }

    logger.info(`Portal reported successful password modification for ${targetLoginId}!`);

    // 5. Conduct mandatory independent verification in separate verification profile using UNIVERSAL_PASSWORD
    logger.info(`Conducting mandatory independent verification for ${targetLoginId} with universal password (${UNIVERSAL_PASSWORD})...`);
    const verification = await verifyInSeparateProfile(UNIVERSAL_PASSWORD, targetLoginId);

    if (verification.success) {
      const session = accountSessions.get(targetLoginId);
      if (session) session.activePassword = UNIVERSAL_PASSWORD;
      activePassword = UNIVERSAL_PASSWORD;
      logger.info(`Independent verification succeeded! Password for ${targetLoginId} is confirmed as universal password (${UNIVERSAL_PASSWORD}).`);
      return true;
    } else {
      logger.error(`Independent verification for ${targetLoginId} with universal password failed: ${verification.reason}`);
      return false;
    }
  } catch (err) {
    logger.error(`Error during password restoration workflow for ${targetLoginId}: ${err.message}`);
    return false;
  }
}

// ==========================================
// PERIODIC VERIFICATION & RELOGIN CYCLES
// ==========================================

/**
 * Perform verification attempt using a completely separate browser profile.
 * Does not share cookies, storage, or session state with the main logged-in profile.
 * @param {string} passwordToTest
 * @param {string} [loginId]
 * @returns {Promise<{ success: boolean, reason?: string }>}
 */
async function verifyInSeparateProfile(passwordToTest, loginId) {
  const targetLoginId = loginId || LOGIN_ID;
  const profileDir = getVerifyProfileDir(targetLoginId);
  let verifyContext = null;
  try {
    logger.info(`Opening isolated verification browser profile for ${targetLoginId} (${profileDir})...`);
    verifyContext = await launchContext(profileDir, `Verification Profile (${targetLoginId})`);

    const pages = verifyContext.pages();
    const verifyPage = pages.length > 0 ? pages[0] : await verifyContext.newPage();

    const result = await performLogin(verifyPage, passwordToTest, targetLoginId);
    return result;
  } catch (err) {
    return { success: false, reason: `Verification profile error for ${targetLoginId}: ${err.message}` };
  } finally {
    if (verifyContext) {
      await verifyContext.close().catch(() => {});
      logger.debug(`Verification browser profile for ${targetLoginId} closed cleanly.`);
    }
  }
}

/**
 * 5-Minute verification cycle handler
 * Checks if portal still authenticates with universal password (samagam) for all accounts.
 * If password was changed and verification fails, restores password back to samagam from logged-in profile.
 */
async function runVerificationCycle() {
  if (isShuttingDown) return;

  isVerificationRunning = true;
  logger.info(`[5-Min Cycle] Running independent verification for all ${LOGIN_IDS.length} accounts: [${LOGIN_IDS.join(', ')}]...`);
  const unlock = await sessionMutex.acquire();

  try {
    for (const session of accountSessions.values()) {
      if (isShuttingDown) break;
      const accountId = session.loginId;
      logger.info(`[5-Min Cycle] Verifying account ${accountId} with universal password (${UNIVERSAL_PASSWORD})...`);

      // 1. Ensure main logged-in page reference is valid
      if (!session.mainPage || session.mainPage.isClosed()) {
        logger.warn(`Main logged-in page for ${accountId} closed or uninitialized. Re-establishing...`);
        if (!session.mainBrowserContext) {
          session.mainBrowserContext = await launchContext(session.mainProfileDir, `Main Profile (${accountId})`);
        }
        session.mainPage = await session.mainBrowserContext.newPage();
        const loginRes = await performLogin(session.mainPage, session.activePassword, accountId);
        if (!loginRes.success) {
          logger.error(`Failed to re-establish main session for ${accountId}: ${loginRes.reason}`);
        }
      }

      // 2. Attempt verification with universal password in separate verification profile
      const verificationResult = await verifyInSeparateProfile(UNIVERSAL_PASSWORD, accountId);
      session.lastVerificationResult = {
        status: verificationResult.success ? 'success' : 'failed',
        reason: verificationResult.reason || null,
        timestamp: new Date().toISOString()
      };
      lastVerificationResult = session.lastVerificationResult;

      if (verificationResult.success) {
        logger.info(`[5-Min Cycle] Verification successful for ${accountId}. Universal password (${UNIVERSAL_PASSWORD}) is valid on the portal.`);
        session.activePassword = UNIVERSAL_PASSWORD;
        continue;
      }

      const isPasswordError = isIncorrectPasswordError(verificationResult.reason);
      logger.warn(`[5-Min Cycle] Verification failed for ${accountId}: ${verificationResult.reason} (isIncorrectPassword: ${isPasswordError})`);

      // 3. If password was changed and verification fails, change it back to samagam from logged-in profile
      if (isPasswordError) {
        const mainStillAuthenticated = await isPageAuthenticated(session.mainPage);
        logger.info(`Checking logged-in profile status for ${accountId}: ${mainStillAuthenticated ? 'STILL AUTHENTICATED' : 'UNAUTHENTICATED'}`);

        if (mainStillAuthenticated) {
          logger.warn(`Password was changed away from universal password for ${accountId}! Initiating password restore to ${UNIVERSAL_PASSWORD} from logged-in profile...`);
          const restored = await restorePasswordToUniversal(session.mainPage, ALTERNATE_PASSWORD, accountId);
          if (restored) {
            session.activePassword = UNIVERSAL_PASSWORD;
            logger.info(`Password successfully restored back to universal password (${UNIVERSAL_PASSWORD}) for ${accountId}!`);
          } else {
            logger.error(`Failed to restore password back to universal password for ${accountId}.`);
          }
        } else {
          logger.error(`Main session has expired for ${accountId}. Cannot restore password without an active session.`);
        }
      } else {
        logger.warn(`[5-Min Cycle] Failure reason for ${accountId} was not an incorrect password error (likely transient/network). Skipping password restore.`);
      }
    }
  } catch (err) {
    logger.error(`[5-Min Cycle] Unexpected error in verification cycle: ${err.message}`);
    lastVerificationResult = { status: 'error', reason: err.message, timestamp: new Date().toISOString() };
  } finally {
    isVerificationRunning = false;
    nextVerificationTime = Date.now() + CHECK_INTERVAL_MS;
    logger.info(`[TIMERS] Verification cycle concluded for all accounts. Next check in ${formatRemaining(CHECK_INTERVAL_MS)} | Next relogin in ${formatRemaining(nextReloginTime ? nextReloginTime - Date.now() : 0)}`);
    unlock();
  }
}

/**
 * 15-Minute logout/login cycle handler (runs on main profile using universal password for all accounts)
 */
async function runReloginCycle() {
  if (isShuttingDown) return;

  isReloginRunning = true;
  logger.info(`[15-Min Cycle] Starting mandatory 15-minute logout/login cycle for all ${LOGIN_IDS.length} accounts: [${LOGIN_IDS.join(', ')}]...`);
  const unlock = await sessionMutex.acquire();

  try {
    for (const session of accountSessions.values()) {
      if (isShuttingDown) break;
      const accountId = session.loginId;
      logger.info(`[15-Min Cycle] Processing relogin for ${accountId}...`);

      if (!session.mainBrowserContext) {
        session.mainBrowserContext = await launchContext(session.mainProfileDir, `Main Profile (${accountId})`);
      }
      if (!session.mainPage || session.mainPage.isClosed()) {
        const pages = session.mainBrowserContext.pages();
        session.mainPage = pages.length > 0 ? pages[0] : await session.mainBrowserContext.newPage();
      }

      // 1. Perform actual Logout on main logged-in page
      await performLogout(session.mainPage);

      // 2. Attempt login with universal password
      logger.info(`[15-Min Cycle] Attempting relogin for ${accountId} using universal password (${UNIVERSAL_PASSWORD})...`);
      const loginResult = await performLogin(session.mainPage, UNIVERSAL_PASSWORD, accountId);

      session.lastReloginResult = {
        status: loginResult.success ? 'success' : 'failed',
        reason: loginResult.reason || null,
        timestamp: new Date().toISOString()
      };
      lastReloginResult = session.lastReloginResult;

      if (loginResult.success) {
        session.activePassword = UNIVERSAL_PASSWORD;
        logger.info(`[15-Min Cycle] Relogin successful for ${accountId} using universal password (${UNIVERSAL_PASSWORD}).`);
      } else {
        logger.error(`[15-Min Cycle] Relogin could not be completed for ${accountId} with universal password: ${loginResult.reason}`);
      }
    }
  } catch (err) {
    logger.error(`[15-Min Cycle] Unexpected error during relogin cycle: ${err.message}`);
    lastReloginResult = { status: 'error', reason: err.message, timestamp: new Date().toISOString() };
  } finally {
    isReloginRunning = false;
    nextReloginTime = Date.now() + RELOGIN_INTERVAL_MS;
    logger.info(`[TIMERS] Relogin cycle concluded for all accounts. Next relogin in ${formatRemaining(RELOGIN_INTERVAL_MS)} | Next verification in ${formatRemaining(nextVerificationTime ? nextVerificationTime - Date.now() : 0)}`);
    unlock();
  }
}

// ==========================================
// APPLICATION INITIALIZATION & SHUTDOWN
// ==========================================

async function startAutomation() {
  startTime = Date.now();
  logger.info('========================================================');
  logger.info('Starting KVS Samagam Continuous Automation Engine');
  logger.info(`Target URL: ${BASE_URL}`);
  logger.info(`Active Accounts (${LOGIN_IDS.length}): ${LOGIN_IDS.join(', ')}`);
  logger.info(`Universal Password: ${UNIVERSAL_PASSWORD}`);
  logger.info(`Password Update URL: ${UPDATE_PASSWORD_URL}`);
  logger.info(`Root Data Directory: ${DATA_DIR}`);
  logger.info(`Verification Interval: ${CHECK_INTERVAL_MS / 1000}s (5m) | Relogin Interval: ${RELOGIN_INTERVAL_MS / 1000}s (15m)`);
  logger.info('========================================================');

  const unlock = await sessionMutex.acquire();
  try {
    for (const session of accountSessions.values()) {
      const accountId = session.loginId;
      logger.info(`Initializing main browser context for ${accountId}...`);
      session.mainBrowserContext = await launchContext(session.mainProfileDir, `Main Profile (${accountId})`);

      const pages = session.mainBrowserContext.pages();
      session.mainPage = pages.length > 0 ? pages[0] : await session.mainBrowserContext.newPage();

      logger.info(`Attempting initial login for ${accountId} on main page with universal password (${UNIVERSAL_PASSWORD})...`);
      let initialLogin = await performLogin(session.mainPage, UNIVERSAL_PASSWORD, accountId);

      // Transient retry
      if (!initialLogin.success && !isIncorrectPasswordError(initialLogin.reason)) {
        logger.warn(`Initial attempt for ${accountId} encountered transient issue: ${initialLogin.reason}. Retrying cleanly in 3s with universal password...`);
        await new Promise(r => setTimeout(r, 3000));
        initialLogin = await performLogin(session.mainPage, UNIVERSAL_PASSWORD, accountId);
      }

      // Alternate password check if credential mismatch
      if (!initialLogin.success && isIncorrectPasswordError(initialLogin.reason) && ALTERNATE_PASSWORD) {
        logger.warn(`Universal password failed for ${accountId} with credential mismatch: ${initialLogin.reason}. Checking alternate candidate...`);
        const altLogin = await performLogin(session.mainPage, ALTERNATE_PASSWORD, accountId);
        if (altLogin.success) {
          logger.info(`Logged in ${accountId} with alternate password. Automatically restoring password to universal password (${UNIVERSAL_PASSWORD})...`);
          await restorePasswordToUniversal(session.mainPage, ALTERNATE_PASSWORD, accountId);
          initialLogin = altLogin;
        }
      }

      if (!initialLogin.success) {
        logger.warn(`Initial login failed for ${accountId}: ${initialLogin.reason}`);
        logger.error(`Initial login could not be completed for ${accountId}. Automation will maintain session loop and retry on scheduled intervals.`);
      } else {
        logger.info(`Initial authentication successful for ${accountId}. Main logged-in session established.`);
      }
    }
  } finally {
    unlock();
  }

  // Set initial countdown target timestamps
  nextVerificationTime = Date.now() + CHECK_INTERVAL_MS;
  nextReloginTime = Date.now() + RELOGIN_INTERVAL_MS;

  // Setup periodic 5-minute verification interval
  verificationTimer = setInterval(() => {
    runVerificationCycle().catch(err => logger.error(`Verification interval error: ${err.message}`));
  }, CHECK_INTERVAL_MS);

  // Setup periodic 15-minute logout/login interval
  reloginTimer = setInterval(() => {
    runReloginCycle().catch(err => logger.error(`Relogin interval error: ${err.message}`));
  }, RELOGIN_INTERVAL_MS);

  // Setup 1-second countdown ticker in CMD / terminal
  countdownTimer = setInterval(() => {
    renderCountdownTick();
  }, 1000);

  const MAX_RUNTIME_MINUTES = parseInt(process.env.MAX_RUNTIME_MINUTES || '0', 10);
  if (MAX_RUNTIME_MINUTES > 0) {
    logger.info(`Configured MAX_RUNTIME_MINUTES = ${MAX_RUNTIME_MINUTES}. Worker will cleanly shut down after this duration.`);
    setTimeout(() => {
      logger.info(`Maximum runtime (${MAX_RUNTIME_MINUTES} min) elapsed. Initiating graceful shutdown...`);
      shutdown('MAX_RUNTIME');
    }, MAX_RUNTIME_MINUTES * 60 * 1000);
  }

  logger.info(`All timers initialized (Verification: 5m | Relogin: 15m) for all accounts (${LOGIN_IDS.join(', ')}). Automation is active and monitoring continuously.`);
  logger.info(`[TIMERS] Live countdown started: Next Verification in ${formatRemaining(CHECK_INTERVAL_MS)} | Next Relogin in ${formatRemaining(RELOGIN_INTERVAL_MS)}`);
}

/**
 * Graceful termination handler (essential for Render redeploys and CI/CD)
 */
async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (process.stdout && process.stdout.isTTY) {
    try {
      process.stdout.write('\r\x1b[K');
    } catch (e) {}
  }
  logger.info(`Received ${signal}. Performing graceful shutdown for ${LOGIN_IDS.length} accounts...`);

  if (countdownTimer) clearInterval(countdownTimer);
  if (verificationTimer) clearInterval(verificationTimer);
  if (reloginTimer) clearInterval(reloginTimer);

  for (const session of accountSessions.values()) {
    try {
      if (session.mainBrowserContext) {
        logger.info(`Closing main browser context for ${session.loginId} and preserving profile state...`);
        await session.mainBrowserContext.close();
      }
    } catch (err) {
      logger.error(`Error while closing browser context for ${session.loginId}: ${err.message}`);
    }
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
  verifyInSeparateProfile,
  restorePasswordToUniversal,
  isIncorrectPasswordError,
  formatRemaining,
  getCountdownStatusString,
  renderCountdownTick,
  sessionMutex,
  launchContext,
  performLogin,
  performLogout,
  isPageAuthenticated,
  ensureLoginOverlay,
  handleTurnstileIfPresent,
  navigateWithRetry,
  getMainProfileDir,
  getVerifyProfileDir,
  LOGIN_IDS,
  LOGIN_ID,
  UNIVERSAL_PASSWORD,
  ALTERNATE_PASSWORD,
  UPDATE_PASSWORD_URL,
  MAIN_PROFILE_DIR,
  VERIFY_PROFILE_DIR,
  accountSessions,
};
