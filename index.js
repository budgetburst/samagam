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

const LOGIN_ID = process.env.KVS_LOGIN_ID || 'EP.45354';
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

// Distinct profiles for the main session and verification checks
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

// Global coordination lock between 5m verification and 15m relogin
const sessionMutex = new AsyncMutex();

let mainBrowserContext = null;
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
  return {
    uptimeSeconds: startTime ? Math.floor((Date.now() - startTime) / 1000) : 0,
    activePassword: getActivePasswordLabel(),
    universalPassword: 'samagam',
    updatePasswordUrl: UPDATE_PASSWORD_URL,
    isMutexLocked: sessionMutex.isLocked(),
    isBrowserActive: mainBrowserContext !== null && mainPage !== null && !mainPage.isClosed(),
    profiles: {
      mainProfile: MAIN_PROFILE_DIR,
      verifyProfile: VERIFY_PROFILE_DIR,
    },
    intervals: {
      verificationMinutes: CHECK_INTERVAL_MS / 60000,
      reloginMinutes: RELOGIN_INTERVAL_MS / 60000,
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
async function performLogin(page, passwordToUse) {
  try {
    await navigateWithRetry(page, LOGIN_URL);
    await ensureLoginOverlay(page);

    // Human-paced typing to prevent bot telemetry flags
    const userField = page.locator(selectors.login.usernameInput);
    await userField.waitFor({ state: 'visible', timeout: ACTION_TIMEOUT });
    await userField.click();
    await userField.fill('');
    await userField.pressSequentially(LOGIN_ID, { delay: 40 });

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

    if (!domValues.user || domValues.user !== LOGIN_ID) {
      logger.debug('Re-applying username before submission...');
      await userField.click();
      await userField.fill('');
      await userField.pressSequentially(LOGIN_ID, { delay: 30 });
    }

    if (!domValues.pass || domValues.pass !== passwordToUse) {
      logger.debug('Re-applying password before submission...');
      await passField.click();
      await passField.fill('');
      await passField.pressSequentially(passwordToUse, { delay: 30 });
    }

    // Brief stabilization pause before form submit
    await new Promise(r => setTimeout(r, 600));

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
 * @returns {Promise<boolean>}
 */
async function restorePasswordToUniversal(page, candidateOldPassword) {
  logger.warn(`Restoring portal password back to universal password (${UNIVERSAL_PASSWORD}) from logged-in profile...`);
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

    logger.info(`Entering current credential and restoring new password to universal password (${UNIVERSAL_PASSWORD})...`);
    await currentPassInput.fill('');
    await currentPassInput.fill(oldPasswordToTry);

    await newPassInput.fill('');
    await newPassInput.fill(UNIVERSAL_PASSWORD);

    await confPassInput.fill('');
    await confPassInput.fill(UNIVERSAL_PASSWORD);

    // 3. Submit change request
    logger.info('Submitting password update request to portal...');
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
      logger.error('Failed to confirm password restoration on the portal.');
      return false;
    }

    logger.info(`Portal reported successful password modification!`);

    // 5. Conduct mandatory independent verification in separate verification profile using UNIVERSAL_PASSWORD
    logger.info(`Conducting mandatory independent verification for universal password (${UNIVERSAL_PASSWORD}) using separate verification profile...`);
    const verification = await verifyInSeparateProfile(UNIVERSAL_PASSWORD);

    if (verification.success) {
      activePassword = UNIVERSAL_PASSWORD;
      logger.info(`Independent verification succeeded! Password is now confirmed as universal password (${UNIVERSAL_PASSWORD}).`);
      return true;
    } else {
      logger.error(`Independent verification for universal password failed: ${verification.reason}`);
      return false;
    }
  } catch (err) {
    logger.error(`Error during password restoration workflow: ${err.message}`);
    return false;
  }
}

// ==========================================
// PERIODIC VERIFICATION & RELOGIN CYCLES
// ==========================================

/**
 * Perform verification attempt using a completely separate browser profile.
 * Does not share cookies, storage, or session state with the main logged-in profile.
 * @returns {Promise<{ success: boolean, reason?: string }>}
 */
async function verifyInSeparateProfile(passwordToTest) {
  let verifyContext = null;
  try {
    logger.info(`Opening isolated verification browser profile (${VERIFY_PROFILE_DIR})...`);
    verifyContext = await launchContext(VERIFY_PROFILE_DIR, 'Verification Profile');

    const pages = verifyContext.pages();
    const verifyPage = pages.length > 0 ? pages[0] : await verifyContext.newPage();

    const result = await performLogin(verifyPage, passwordToTest);
    return result;
  } catch (err) {
    return { success: false, reason: `Verification profile error: ${err.message}` };
  } finally {
    if (verifyContext) {
      await verifyContext.close().catch(() => {});
      logger.debug('Verification browser profile closed cleanly.');
    }
  }
}

/**
 * 5-Minute verification cycle handler
 * Checks if portal still authenticates with universal password (samagam).
 * If password was changed and verification fails, restores password back to samagam from logged-in profile.
 */
async function runVerificationCycle() {
  if (isShuttingDown) return;

  logger.info(`[5-Min Cycle] Running independent verification in separate profile for universal password (${UNIVERSAL_PASSWORD})...`);
  const unlock = await sessionMutex.acquire();

  try {
    // 1. Ensure main logged-in page reference is valid
    if (!mainPage || mainPage.isClosed()) {
      logger.warn('Main logged-in session page closed or crashed. Re-establishing main session...');
      mainPage = await mainBrowserContext.newPage();
      const loginRes = await performLogin(mainPage, activePassword);
      if (!loginRes.success) {
        logger.error(`Failed to re-establish main session: ${loginRes.reason}`);
      }
      return;
    }

    // 2. Attempt verification with universal password in separate verification profile
    const verificationResult = await verifyInSeparateProfile(UNIVERSAL_PASSWORD);
    lastVerificationResult = {
      status: verificationResult.success ? 'success' : 'failed',
      reason: verificationResult.reason || null,
      timestamp: new Date().toISOString()
    };

    if (verificationResult.success) {
      logger.info(`[5-Min Cycle] Verification successful. Universal password (${UNIVERSAL_PASSWORD}) is valid on the portal.`);
      activePassword = UNIVERSAL_PASSWORD;
      return;
    }

    const isPasswordError = isIncorrectPasswordError(verificationResult.reason);
    logger.warn(`[5-Min Cycle] Verification failed for universal password (${UNIVERSAL_PASSWORD}): ${verificationResult.reason} (isIncorrectPassword: ${isPasswordError})`);

    // 3. If password was changed and verification fails, change it back to samagam from logged-in profile
    if (isPasswordError) {
      const mainStillAuthenticated = await isPageAuthenticated(mainPage);
      logger.info(`Checking logged-in profile status: ${mainStillAuthenticated ? 'STILL AUTHENTICATED' : 'UNAUTHENTICATED'}`);

      if (mainStillAuthenticated) {
        logger.warn(`Password was changed away from universal password! Initiating password restore to ${UNIVERSAL_PASSWORD} from logged-in profile...`);
        const restored = await restorePasswordToUniversal(mainPage, ALTERNATE_PASSWORD);
        if (restored) {
          logger.info(`Password successfully restored back to universal password (${UNIVERSAL_PASSWORD})!`);
        } else {
          logger.error(`Failed to restore password back to universal password.`);
        }
      } else {
        logger.error('Main session has expired or unauthenticated. Cannot restore password from logged-in profile without an active session.');
      }
    } else {
      logger.warn(`[5-Min Cycle] Failure reason was not an incorrect password error (likely transient/network). Skipping password restore.`);
    }
  } catch (err) {
    logger.error(`[5-Min Cycle] Unexpected error in verification cycle: ${err.message}`);
    lastVerificationResult = { status: 'error', reason: err.message, timestamp: new Date().toISOString() };
  } finally {
    unlock();
  }
}

/**
 * 15-Minute logout/login cycle handler (runs on main profile using universal password)
 */
async function runReloginCycle() {
  if (isShuttingDown) return;

  logger.info('[15-Min Cycle] Starting mandatory 15-minute logout/login cycle on main profile...');
  const unlock = await sessionMutex.acquire();

  try {
    // 1. Ensure main page reference is valid in main profile
    if (!mainPage || mainPage.isClosed()) {
      mainPage = await mainBrowserContext.newPage();
    }

    // 2. Perform actual Logout on main logged-in page
    await performLogout(mainPage);

    // 3. Attempt login with universal password
    logger.info(`[15-Min Cycle] Attempting relogin using universal password (${UNIVERSAL_PASSWORD})...`);
    const loginResult = await performLogin(mainPage, UNIVERSAL_PASSWORD);

    lastReloginResult = {
      status: loginResult.success ? 'success' : 'failed',
      reason: loginResult.reason || null,
      timestamp: new Date().toISOString()
    };

    if (loginResult.success) {
      activePassword = UNIVERSAL_PASSWORD;
      logger.info(`[15-Min Cycle] Relogin successful using universal password (${UNIVERSAL_PASSWORD}). Main profile session reference refreshed.`);
    } else {
      logger.error(`[15-Min Cycle] Relogin could not be completed with universal password: ${loginResult.reason}`);
    }
  } catch (err) {
    logger.error(`[15-Min Cycle] Unexpected error during relogin cycle: ${err.message}`);
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
  logger.info(`Universal Password: ${UNIVERSAL_PASSWORD}`);
  logger.info(`Password Update URL: ${UPDATE_PASSWORD_URL}`);
  logger.info(`Main Profile: ${MAIN_PROFILE_DIR}`);
  logger.info(`Verification Profile: ${VERIFY_PROFILE_DIR}`);
  logger.info(`Verification Interval: ${CHECK_INTERVAL_MS / 1000}s | Relogin Interval: ${RELOGIN_INTERVAL_MS / 1000}s (15m)`);
  logger.info('========================================================');

  // Launch main browser context for continuous logged-in session
  mainBrowserContext = await launchContext(MAIN_PROFILE_DIR, 'Main Logged-In Profile');

  // Create initial main page
  const pages = mainBrowserContext.pages();
  mainPage = pages.length > 0 ? pages[0] : await mainBrowserContext.newPage();

  // Acquire lock for initial login
  const unlock = await sessionMutex.acquire();
  try {
    logger.info(`Attempting initial login on main page with universal password (${UNIVERSAL_PASSWORD})...`);
    let initialLogin = await performLogin(mainPage, UNIVERSAL_PASSWORD);

    // If initial login encountered a transient error (e.g. Turnstile timing or network), retry once cleanly with universal password
    if (!initialLogin.success && !isIncorrectPasswordError(initialLogin.reason)) {
      logger.warn(`Initial attempt encountered transient issue: ${initialLogin.reason}. Retrying cleanly in 3s with universal password...`);
      await new Promise(r => setTimeout(r, 3000));
      initialLogin = await performLogin(mainPage, UNIVERSAL_PASSWORD);
    }

    // If initial login genuinely returned credential failure, check alternate password candidate to restore back to universal password
    if (!initialLogin.success && isIncorrectPasswordError(initialLogin.reason) && ALTERNATE_PASSWORD) {
      logger.warn(`Universal password failed with credential mismatch: ${initialLogin.reason}. Checking alternate candidate...`);
      const altLogin = await performLogin(mainPage, ALTERNATE_PASSWORD);
      if (altLogin.success) {
        logger.info(`Logged in with alternate password. Automatically restoring password to universal password (${UNIVERSAL_PASSWORD})...`);
        await restorePasswordToUniversal(mainPage, ALTERNATE_PASSWORD);
        initialLogin = altLogin;
      }
    }

    if (!initialLogin.success) {
      logger.warn(`Initial login failed: ${initialLogin.reason}`);
      logger.error('CRITICAL: Initial login could not be completed. Automation will maintain session loop and retry on scheduled intervals.');
    } else {
      logger.info('Initial authentication successful. Main logged-in session established and referenced.');
    }
  } finally {
    unlock();
  }

  // Setup periodic 5-minute verification interval (runs in separate verification profile)
  verificationTimer = setInterval(() => {
    runVerificationCycle().catch(err => logger.error(`Verification interval error: ${err.message}`));
  }, CHECK_INTERVAL_MS);

  // Setup periodic 15-minute logout/login interval (runs on main logged-in profile)
  reloginTimer = setInterval(() => {
    runReloginCycle().catch(err => logger.error(`Relogin interval error: ${err.message}`));
  }, RELOGIN_INTERVAL_MS);

  logger.info('All timers initialized (Verification: 5m | Relogin: 15m). Automation is active and monitoring continuously.');
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
    if (mainBrowserContext) {
      logger.info('Closing main browser context and preserving profile state...');
      await mainBrowserContext.close();
    }
  } catch (err) {
    logger.error(`Error while closing main browser context: ${err.message}`);
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
  sessionMutex,
  UNIVERSAL_PASSWORD,
  ALTERNATE_PASSWORD,
  UPDATE_PASSWORD_URL,
  MAIN_PROFILE_DIR,
  VERIFY_PROFILE_DIR,
};
