/**
 * action-runner.js
 * Standalone single-pass runner for GitHub Actions & scheduled CI/CD automation.
 *
 * Implements:
 * 1. Independent credential verification targeting universal baseline password for all configured accounts.
 * 2. Automatic password restoration:
 *    - If universal password fails due to credential mismatch, attempts restoration from
 *      active cached session or using alternate password candidate.
 *    - Restores password back to universal baseline via direct navigation to `https://samagam.kvs.gov.in/user/update-password`.
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
  LOGIN_IDS,
  getMainProfileDir,
  launchContext,
  performLogin,
  performLogout,
  restorePasswordToUniversal,
  verifyInSeparateProfile,
  isPageAuthenticated,
} = require('./index');

async function runSinglePass() {
  logger.info('========================================================');
  logger.info(`Starting KVS Samagam Single-Pass Action Runner for ${LOGIN_IDS.length} accounts`);
  logger.info(`Target Accounts: ${LOGIN_IDS.map(id => id.slice(0, 3) + '***').join(', ')}`);
  logger.info(`Universal Baseline Password: ${UNIVERSAL_PASSWORD ? '[CONFIGURED]' : '[NOT_SET]'}`);
  logger.info(`Password Update URL: ${UPDATE_PASSWORD_URL}`);
  logger.info('========================================================');

  let anyRestorationFailed = false;

  for (const accountId of LOGIN_IDS) {
    logger.info('--------------------------------------------------------');
    logger.info(`Processing account: ${accountId}`);
    logger.info('--------------------------------------------------------');

    // Step 1: Check credentials in verification profile using universal baseline password
    logger.info(`[Step 1] Verifying credentials for ${accountId} with universal baseline password...`);
    let verification = await verifyInSeparateProfile(UNIVERSAL_PASSWORD, accountId);

    // If transient error (e.g. Turnstile or network), retry once cleanly
    if (!verification.success && !isIncorrectPasswordError(verification.reason)) {
      logger.warn(`Verification for ${accountId} encountered transient issue: ${verification.reason}. Retrying in 3 seconds...`);
      await new Promise((r) => setTimeout(r, 3000));
      verification = await verifyInSeparateProfile(UNIVERSAL_PASSWORD, accountId);
    }

    // CASE A: Universal password is valid!
    if (verification.success) {
      logger.info(`✅ [Step 1 SUCCESS] Portal authentication verified for ${accountId}! Universal password is active.`);

      // Step 2: Refresh session / perform relogin on main profile
      logger.info(`[Step 2] Refreshing main profile session for ${accountId} with universal password...`);
      const mainProfileDir = getMainProfileDir(accountId);
      const mainContext = await launchContext(mainProfileDir, `Main Profile (${accountId})`);
      try {
        const pages = mainContext.pages();
        const page = pages.length > 0 ? pages[0] : await mainContext.newPage();
        await performLogout(page);
        const reloginRes = await performLogin(page, UNIVERSAL_PASSWORD, accountId);
        if (reloginRes.success) {
          logger.info(`✅ [Step 2 SUCCESS] Main profile session for ${accountId} refreshed successfully.`);
        } else {
          logger.warn(`[Step 2 WARNING] Main profile relogin for ${accountId} reported: ${reloginRes.reason}`);
        }
      } catch (err) {
        logger.error(`Error during main profile relogin for ${accountId}: ${err.message}`);
      } finally {
        await mainContext.close().catch(() => {});
      }
      continue;
    }

    // CASE B: Verification failed. Check if it's an incorrect password error!
    const isPassError = isIncorrectPasswordError(verification.reason);
    logger.warn(`[Verification Notice] Verification failed for ${accountId}: ${verification.reason} (isIncorrectPassword: ${isPassError})`);

    if (!isPassError) {
      logger.error(`Verification failed for ${accountId} due to portal or network issue, not password mismatch. Skipping password restore.`);
      continue;
    }

    // CASE C: Password was changed! We must restore it back to universal baseline password.
    logger.warn(`⚠️ [Password Mismatch] Password was changed for ${accountId}! Restoring password back to universal baseline...`);

    const mainProfileDir = getMainProfileDir(accountId);
    const mainContext = await launchContext(mainProfileDir, `Main Profile (${accountId})`);
    let restored = false;

    try {
      const pages = mainContext.pages();
      const page = pages.length > 0 ? pages[0] : await mainContext.newPage();
      const isAuthed = await isPageAuthenticated(page);
      logger.info(`Checking if cached main profile for ${accountId} is still authenticated: ${isAuthed ? 'YES' : 'NO'}`);

      if (isAuthed) {
        logger.info(`Cached session for ${accountId} is active! Proceeding to restore password directly from logged-in profile...`);
        restored = await restorePasswordToUniversal(page, ALTERNATE_PASSWORD, accountId);
      } else {
        logger.info(`Cached session for ${accountId} expired. Attempting login with alternate candidate password...`);
        const altLogin = await performLogin(page, ALTERNATE_PASSWORD, accountId);
        if (altLogin.success) {
          logger.info(`Logged in ${accountId} with alternate password. Updating password back to universal password...`);
          restored = await restorePasswordToUniversal(page, ALTERNATE_PASSWORD, accountId);
        } else {
          logger.error(`Failed to log in ${accountId} with alternate password: ${altLogin.reason}`);
        }
      }
    } catch (err) {
      logger.error(`Error during password restoration workflow for ${accountId}: ${err.message}`);
    } finally {
      await mainContext.close().catch(() => {});
    }

    if (restored) {
      logger.info(`🎉 [RESTORATION SUCCESS] Password for ${accountId} successfully restored back to universal baseline!`);
    } else {
      logger.error(`❌ [RESTORATION FAILED] Could not restore password for ${accountId} to universal baseline.`);
      anyRestorationFailed = true;
    }
  }

  logger.info('========================================================');
  logger.info(`🎉 Single-pass run concluded for all accounts: [${LOGIN_IDS.map(id => id.slice(0, 3) + '***').join(', ')}]`);
  process.exit(anyRestorationFailed ? 1 : 0);
}

// Execute immediately when run directly
if (require.main === module) {
  runSinglePass().catch((err) => {
    logger.error(`Fatal single-pass runner error: ${err.message}`, err.stack);
    process.exit(1);
  });
}

module.exports = { runSinglePass };
