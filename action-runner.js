/**
 * action-runner.js
 * Standalone single-pass runner for GitHub Actions & scheduled CI/CD automation.
 *
 * Implements:
 * 1. Independent credential verification targeting universal password (`samagam`).
 * 2. Automatic password restoration:
 *    - If universal password fails due to credential mismatch, attempts restoration from
 *      active cached session or using alternate password candidate.
 *    - Restores password back to `samagam` via direct navigation to `https://samagam.kvs.gov.in/user/update-password`.
 *    - Confirms restoration in isolated verification profile.
 * 3. Fresh relogin / session refresh with universal password.
 * 4. Clean exit code for GitHub Actions.
 */

require('dotenv').config();
const logger = require('./logger');
const {
  isIncorrectPasswordError,
  UNIVERSAL_PASSWORD,
  ALTERNATE_PASSWORD,
  UPDATE_PASSWORD_URL,
  MAIN_PROFILE_DIR,
  launchContext,
  performLogin,
  performLogout,
  restorePasswordToUniversal,
  verifyInSeparateProfile,
  isPageAuthenticated,
} = require('./index');

async function runSinglePass() {
  logger.info('========================================================');
  logger.info('Starting KVS Samagam Single-Pass Action Runner');
  logger.info(`Universal Baseline Password: ${UNIVERSAL_PASSWORD}`);
  logger.info(`Password Update URL: ${UPDATE_PASSWORD_URL}`);
  logger.info('========================================================');

  // Step 1: Check credentials in verification profile using universal password (samagam)
  logger.info(`[Step 1] Verifying credentials with universal password (${UNIVERSAL_PASSWORD})...`);
  let verification = await verifyInSeparateProfile(UNIVERSAL_PASSWORD);

  // If transient error (e.g. Turnstile or network), retry once cleanly
  if (!verification.success && !isIncorrectPasswordError(verification.reason)) {
    logger.warn(`Verification encountered transient issue: ${verification.reason}. Retrying in 3 seconds...`);
    await new Promise((r) => setTimeout(r, 3000));
    verification = await verifyInSeparateProfile(UNIVERSAL_PASSWORD);
  }

  // CASE A: Universal password is valid!
  if (verification.success) {
    logger.info(`✅ [Step 1 SUCCESS] Portal authentication verified! Universal password (${UNIVERSAL_PASSWORD}) is active.`);

    // Step 2: Refresh session / perform relogin on main profile
    logger.info('[Step 2] Refreshing main profile session with universal password...');
    const mainContext = await launchContext(MAIN_PROFILE_DIR, 'Main Profile');
    try {
      const pages = mainContext.pages();
      const page = pages.length > 0 ? pages[0] : await mainContext.newPage();
      await performLogout(page);
      const reloginRes = await performLogin(page, UNIVERSAL_PASSWORD);
      if (reloginRes.success) {
        logger.info(`✅ [Step 2 SUCCESS] Main profile session refreshed successfully with universal password (${UNIVERSAL_PASSWORD}).`);
      } else {
        logger.warn(`[Step 2 WARNING] Main profile relogin reported: ${reloginRes.reason}`);
      }
    } catch (err) {
      logger.error(`Error during main profile relogin: ${err.message}`);
    } finally {
      await mainContext.close().catch(() => {});
    }

    logger.info('🎉 Action run completed successfully.');
    process.exit(0);
  }

  // CASE B: Verification failed. Check if it's an incorrect password error!
  const isPassError = isIncorrectPasswordError(verification.reason);
  logger.warn(`[Verification Notice] Verification failed: ${verification.reason} (isIncorrectPassword: ${isPassError})`);

  if (!isPassError) {
    logger.error('Verification failed due to portal or network issue, not password mismatch. Exiting without altering password.');
    // Exit 0 to prevent spurious GitHub Actions notification failures on transient network issues
    process.exit(0);
  }

  // CASE C: Password was changed! We must restore it back to universal password (samagam).
  logger.warn(`⚠️ [Password Mismatch] Password was changed! Restoring password back to universal password (${UNIVERSAL_PASSWORD})...`);

  const mainContext = await launchContext(MAIN_PROFILE_DIR, 'Main Profile');
  let restored = false;

  try {
    const pages = mainContext.pages();
    const page = pages.length > 0 ? pages[0] : await mainContext.newPage();
    const isAuthed = await isPageAuthenticated(page);
    logger.info(`Checking if cached main profile is still authenticated: ${isAuthed ? 'YES' : 'NO'}`);

    if (isAuthed) {
      logger.info('Cached session is active! Proceeding to restore password directly from logged-in profile...');
      restored = await restorePasswordToUniversal(page, ALTERNATE_PASSWORD);
    } else {
      logger.info(`Cached session expired. Attempting login with alternate candidate password...`);
      const altLogin = await performLogin(page, ALTERNATE_PASSWORD);
      if (altLogin.success) {
        logger.info('Logged in with alternate password. Updating password back to universal password...');
        restored = await restorePasswordToUniversal(page, ALTERNATE_PASSWORD);
      } else {
        logger.error(`Failed to log in with alternate password: ${altLogin.reason}`);
      }
    }
  } catch (err) {
    logger.error(`Error during password restoration workflow: ${err.message}`);
  } finally {
    await mainContext.close().catch(() => {});
  }

  if (restored) {
    logger.info(`🎉 [RESTORATION SUCCESS] Password successfully restored back to universal password (${UNIVERSAL_PASSWORD})!`);
    process.exit(0);
  } else {
    logger.error(`❌ [RESTORATION FAILED] Could not restore password to universal password (${UNIVERSAL_PASSWORD}).`);
    process.exit(1);
  }
}

// Execute immediately when run directly
if (require.main === module) {
  runSinglePass().catch((err) => {
    logger.error(`Fatal single-pass runner error: ${err.message}`, err.stack);
    process.exit(1);
  });
}

module.exports = { runSinglePass };
