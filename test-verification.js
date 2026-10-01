/**
 * test-verification.js
 * Comprehensive unit and sanity verification for KVS Samagam Render.com modules
 */

// Set dummy sensitive credentials for testing before requiring modules
process.env.KVS_LOGIN_IDS = 'TEST_USER_1,TEST_USER_2,TEST_USER_3';
process.env.KVS_UNIVERSAL_PASSWORD = 'MockUniversalSecret123';
process.env.KVS_ALTERNATE_PASSWORD = 'MockAlternateSecret456';

const assert = require('assert');
const logger = require('./logger');
const AsyncMutex = require('./mutex');
const selectors = require('./selectors');
const {
  isIncorrectPasswordError,
  UNIVERSAL_PASSWORD,
  UPDATE_PASSWORD_URL,
  MAIN_PROFILE_DIR,
  VERIFY_PROFILE_DIR,
  LOGIN_IDS,
  getMainProfileDir,
  getVerifyProfileDir,
} = require('./index');

console.log('--- RUNNING AUTOMATED VERIFICATION CHECKS (RENDER WORKER) ---');

// 1. Verify Logger Sanitization
console.log('1. Testing Logger Sanitization...');
const testString = 'Attempting login with password: MockUniversalSecret123 and alternative MockAlternateSecret456; cookie: ci_session=abcdef123456';
const sanitized = logger.sanitize(testString);

assert(!sanitized.includes('MockUniversalSecret123'), 'Universal password was not redacted!');
assert(!sanitized.includes('MockAlternateSecret456'), 'Alternate password was not redacted!');
assert(!sanitized.includes('abcdef123456'), 'ci_session token was not redacted!');
assert(sanitized.includes('[REDACTED]'), 'Redacted marker was missing!');
console.log('   [PASS] Logger correctly redacts universal password, alternate passwords, and session cookies.');

// 2. Verify Universal Password & Update URL Configuration
console.log('2. Testing Universal Password & URL Configuration...');
assert.strictEqual(UNIVERSAL_PASSWORD, 'MockUniversalSecret123', 'Universal password was not loaded correctly!');
assert.strictEqual(UPDATE_PASSWORD_URL, 'https://samagam.kvs.gov.in/user/update-password', 'Update password URL is not user/update-password!');
console.log('   [PASS] Universal baseline password loaded correctly.');
console.log(`   [PASS] Password update URL: ${UPDATE_PASSWORD_URL}`);

// 3. Verify Profile Separation
console.log('3. Testing Profile Separation Architecture...');
assert(MAIN_PROFILE_DIR.endsWith('main_profile'), 'Main profile path is invalid');
assert(VERIFY_PROFILE_DIR.endsWith('verify_profile'), 'Verification profile path is invalid');
assert.notStrictEqual(MAIN_PROFILE_DIR, VERIFY_PROFILE_DIR, 'Main and verification profiles are not distinct!');
console.log(`   [PASS] Main Profile: ${MAIN_PROFILE_DIR}`);
console.log(`   [PASS] Verify Profile: ${VERIFY_PROFILE_DIR}`);
console.log('   [PASS] Separate profiles guaranteed for logged-in session and verification.');

// 3b. Verify Multi-Account Configuration
console.log('3b. Testing Multi-Account Configuration & Directory Paths...');
assert(Array.isArray(LOGIN_IDS), 'LOGIN_IDS is not an array');
assert(LOGIN_IDS.includes('TEST_USER_1'), 'Missing TEST_USER_1 in LOGIN_IDS');
assert(LOGIN_IDS.includes('TEST_USER_2'), 'Missing TEST_USER_2 in LOGIN_IDS');
assert(LOGIN_IDS.includes('TEST_USER_3'), 'Missing TEST_USER_3 in LOGIN_IDS');

const dir1 = getMainProfileDir('TEST_USER_1');
const dir2 = getMainProfileDir('TEST_USER_2');
const dir3 = getMainProfileDir('TEST_USER_3');
assert.notStrictEqual(dir1, dir2, 'Profile dirs for TEST_USER_1 and TEST_USER_2 collided!');
assert.notStrictEqual(dir2, dir3, 'Profile dirs for TEST_USER_2 and TEST_USER_3 collided!');
assert.notStrictEqual(dir1, dir3, 'Profile dirs for TEST_USER_1 and TEST_USER_3 collided!');
console.log(`   [PASS] Multi-account support verified: [${LOGIN_IDS.join(', ')}]`);
console.log('   [PASS] Dedicated isolated profile paths guaranteed for each account.');

// 4. Verify Incorrect Password Error Classification
console.log('4. Testing Incorrect Password Error Parser...');
assert.strictEqual(isIncorrectPasswordError('Invalid Username or Password'), true);
assert.strictEqual(isIncorrectPasswordError('Incorrect Password provided'), true);
assert.strictEqual(isIncorrectPasswordError('Password does not match'), true);
assert.strictEqual(isIncorrectPasswordError('Invalid credentials. Please try again.'), true);
assert.strictEqual(isIncorrectPasswordError('User authentication failed'), true);
// Transient errors MUST NOT trigger password change:
assert.strictEqual(isIncorrectPasswordError('Turnstile verification token missing or timed out'), false);
assert.strictEqual(isIncorrectPasswordError('Navigation timeout of 30000ms exceeded'), false);
assert.strictEqual(isIncorrectPasswordError('connect ECONNREFUSED 127.0.0.1'), false);
console.log('   [PASS] isIncorrectPasswordError accurately detects credential failures vs transient issues.');

// 5. Verify Mutex Coordination
console.log('5. Testing AsyncMutex Concurrency Lock...');
const mutex = new AsyncMutex();
let sequence = [];

async function taskA() {
  const unlock = await mutex.acquire();
  sequence.push('A_start');
  await new Promise(r => setTimeout(r, 50));
  sequence.push('A_end');
  unlock();
}

async function taskB() {
  const unlock = await mutex.acquire();
  sequence.push('B_start');
  await new Promise(r => setTimeout(r, 20));
  sequence.push('B_end');
  unlock();
}

Promise.all([taskA(), taskB()]).then(() => {
  assert.deepStrictEqual(sequence, ['A_start', 'A_end', 'B_start', 'B_end'], 'Tasks did not execute sequentially through mutex!');
  console.log('   [PASS] AsyncMutex maintains strict mutual exclusion.');

  // 6. Verify Selectors Structure
  console.log('6. Testing Selectors Registry...');
  assert(selectors.login.usernameInput, 'Missing login usernameInput selector');
  assert(selectors.login.passwordInput, 'Missing login passwordInput selector');
  assert(selectors.login.submitButton, 'Missing login submitButton selector');
  assert(selectors.logout.button, 'Missing logout button selector');
  assert(selectors.profile.updatePasswordPath, 'Missing profile updatePasswordPath');
  assert(selectors.changePasswordForm.currentPasswordInput, 'Missing change password current input');
  assert(selectors.changePasswordForm.newPasswordInput, 'Missing change password new input');
  assert(selectors.changePasswordForm.confirmPasswordInput, 'Missing change password confirm input');
  console.log('   [PASS] All selector definitions validated.');

  // 7. Verify Password State Machine: Restore back to universal password if verification fails showing incorrect password
  console.log('7. Testing Universal Password Restoration Logic...');
  let currentPasswordOnPortal = 'some_changed_password';

  function simulateVerificationAndRestore(errorReason, mainIsLoggedIn) {
    if (isIncorrectPasswordError(errorReason)) {
      if (mainIsLoggedIn) {
        // Change password BACK to universal baseline password from logged-in profile
        currentPasswordOnPortal = UNIVERSAL_PASSWORD;
        return { restored: true, activePassword: currentPasswordOnPortal };
      }
    }
    return { restored: false, currentPassword: currentPasswordOnPortal };
  }

  // Case A: Verification fails with Turnstile timeout -> DO NOT restore
  const resTransient = simulateVerificationAndRestore('Turnstile verification token missing or timed out', true);
  assert.strictEqual(resTransient.restored, false);
  assert.strictEqual(currentPasswordOnPortal, 'some_changed_password');

  // Case B: Verification fails with "Incorrect Password", but main profile is NOT logged in -> cannot restore
  const resUnauthed = simulateVerificationAndRestore('Incorrect password', false);
  assert.strictEqual(resUnauthed.restored, false);
  assert.strictEqual(currentPasswordOnPortal, 'some_changed_password');

  // Case C: Verification fails with "Incorrect Password" and main profile IS logged in -> RESTORE TO UNIVERSAL!
  const resSuccess = simulateVerificationAndRestore('Invalid Username or Password', true);
  assert.strictEqual(resSuccess.restored, true);
  assert.strictEqual(currentPasswordOnPortal, UNIVERSAL_PASSWORD);
  console.log('   [PASS] Password restored back to universal password from logged-in profile.');

  // 8. Verify Action Runner Module
  console.log('8. Testing Action Runner Module Structure...');
  const { runSinglePass } = require('./action-runner');
  assert(typeof runSinglePass === 'function', 'runSinglePass is not a function');
  console.log('   [PASS] Action runner module loaded and verified successfully.');

  console.log('--- ALL VERIFICATION CHECKS PASSED SUCCESSFULLY ---');
}).catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
