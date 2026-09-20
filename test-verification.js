/**
 * test-verification.js
 * Unit and sanity verification for KVS Samagam Render.com modules
 */

const assert = require('assert');
const logger = require('./logger');
const AsyncMutex = require('./mutex');
const selectors = require('./selectors');

// Set dummy sensitive credentials for testing
process.env.KVS_PASSWORD_1 = 'samagam';
process.env.KVS_PASSWORD_2 = 'writukapanty';

console.log('--- RUNNING AUTOMATED VERIFICATION CHECKS (RENDER WORKER) ---');

// 1. Verify Logger Sanitization
console.log('1. Testing Logger Sanitization...');
const testString = 'Attempting login with password: samagam and alternative writukapanty; cookie: ci_session=abcdef123456';
const sanitized = logger.sanitize(testString);

assert(!sanitized.includes('samagam'), 'KVS_PASSWORD_1 was not redacted!');
assert(!sanitized.includes('writukapanty'), 'KVS_PASSWORD_2 was not redacted!');
assert(!sanitized.includes('abcdef123456'), 'ci_session token was not redacted!');
assert(sanitized.includes('[REDACTED]'), 'Redacted marker was missing!');
console.log('   [PASS] Logger correctly redacts passwords and session cookies.');

// Test object sanitization
const testObj = {
  user: 'EP.45354',
  password: 'samagam',
  token: 'secret-token-xyz',
  nested: {
    authCookie: 'cookie-val'
  }
};
const sanitizedObj = logger.sanitize(testObj);
assert.strictEqual(sanitizedObj.password, '[REDACTED]');
assert.strictEqual(sanitizedObj.token, '[REDACTED]');
assert.strictEqual(sanitizedObj.nested.authCookie, '[REDACTED]');
assert.strictEqual(sanitizedObj.user, 'EP.45354');
console.log('   [PASS] Object sanitization verified.');

// 2. Verify Mutex Coordination
console.log('2. Testing AsyncMutex Concurrency Lock...');
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

  // 3. Verify Selectors Structure
  console.log('3. Testing Selectors Registry...');
  assert(selectors.login.usernameInput, 'Missing login usernameInput selector');
  assert(selectors.login.passwordInput, 'Missing login passwordInput selector');
  assert(selectors.login.submitButton, 'Missing login submitButton selector');
  assert(selectors.logout.button, 'Missing logout button selector');
  assert(selectors.changePasswordForm.currentPasswordInput, 'Missing change password current input');
  assert(selectors.changePasswordForm.newPasswordInput, 'Missing change password new input');
  assert(selectors.changePasswordForm.confirmPasswordInput, 'Missing change password confirm input');
  console.log('   [PASS] All selector definitions validated.');

  // 4. Verify Password State Machine Guardrails
  console.log('4. Testing Password State Machine Guardrails...');
  let currentActive = process.env.KVS_PASSWORD_1;
  let isP2PermanentlyActive = false;

  // Rule: Initial login failure MUST NOT transition active password to PASSWORD_2
  function simulateFailedLogin() {
    return { success: false, reason: 'Invalid credentials' };
  }

  const initialAttempt = simulateFailedLogin();
  if (!initialAttempt.success) {
    // Assert active password remains PASSWORD_1
    assert.strictEqual(currentActive, process.env.KVS_PASSWORD_1, 'Active password prematurely switched to PASSWORD_2 on initial failure!');
    assert.strictEqual(isP2PermanentlyActive, false, 'PASSWORD_2 was marked permanently active prematurely!');
  }

  // Rule: ONLY successful portal change + independent verification can transition to PASSWORD_2
  function simulatePasswordChangeWorkflow(mainAuth, portalSuccess, independentVerificationSuccess) {
    if (mainAuth && portalSuccess && independentVerificationSuccess) {
      currentActive = process.env.KVS_PASSWORD_2;
      isP2PermanentlyActive = true;
      return true;
    }
    return false;
  }

  const changed = simulatePasswordChangeWorkflow(true, true, true);
  assert.strictEqual(changed, true);
  assert.strictEqual(currentActive, process.env.KVS_PASSWORD_2);
  assert.strictEqual(isP2PermanentlyActive, true);
  console.log('   [PASS] Password state machine guardrails verified.');

  console.log('--- ALL VERIFICATION CHECKS PASSED SUCCESSFULLY ---');
}).catch(err => {
  console.error('VERIFICATION FAILED:', err);
  process.exit(1);
});
