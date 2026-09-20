/**
 * selectors.js
 * Centralized DOM selectors for the KVS Samagam portal.
 *
 * SELECTOR DISCOVERY NOTES:
 * - Selectors marked [LIVE DOM VERIFIED] were inspected directly from https://samagam.kvs.gov.in/user/login.
 * - Selectors marked [CODEBASE VERIFIED] were derived from portal assets (app.js, nav-enhance.js).
 * - Selectors marked [CONFIGURABLE FALLBACK] represent standard Bootstrap/CodeIgniter authenticated dashboard
 *   patterns and can be tuned if your specific user role layout differs.
 */

module.exports = {
  // --- LOGIN PAGE & DIALOG [LIVE DOM VERIFIED] ---
  login: {
    // Overlay modal container
    overlay: '#lpLoginOverlay',
    // Button on landing page that opens the modal if not already open
    openModalButton: 'a.login-link, a.lp-hero-btn',
    // Login form container
    form: '#lpLoginForm',
    // Login ID input field
    usernameInput: '#lpLoginUsername, input[name="username"]',
    // Password input field
    passwordInput: '#lpLoginPassword, input[name="password"]',
    // Form submit button
    submitButton: '#lpLoginForm button[type="submit"], button.lp-login-submit',
    // Password toggle (reveal/mask)
    passwordToggle: '#lpLoginToggle',
    // Client-side encryption key hidden input (triggers AES-CBC automatically on form submission)
    encKeyInput: '#lpEncKey',
    // Turnstile container & response token field
    turnstileContainer: '.cf-turnstile',
    turnstileResponseInput: 'input[name="cf-turnstile-response"]',
    // Error indicator displayed inside the card or popup
    errorContainer: '.lp-login-error, .swal2-popup.swal2-icon-error, .swal2-html-container',
  },

  // --- AUTHENTICATED SESSION INDICATORS [CODEBASE VERIFIED] ---
  session: {
    // Main navigation bar rendered upon successful authentication
    mainNav: '#main-nav, nav.navbar.main-nav',
    // User profile icon / avatar dropdown in navbar
    avatar: '.avatar-wrapper, .avatar-circle, a.login-link.logged-in',
    // Indicator that user is currently unauthenticated (e.g. login link text "Login")
    loginLinkText: 'span.login-text:has-text("Login")',
  },

  // --- LOGOUT OPERATION [CODEBASE & SCRIPT VERIFIED] ---
  logout: {
    // In app.js, logoutUser() directly navigates to `${base_url}logout`
    // UI elements that trigger or link to logout:
    button: 'a[href*="/logout"], a[href$="/logout"], a.logout-link, #btnLogout',
  },

  // --- PROFILE & CHANGE PASSWORD ---
  profile: {
    // Direct URL path on portal
    updatePasswordPath: '/user/update-password',
    // Account / Profile dropdown in navigation bar
    menuDropdown: '.nav-right .dropdown-toggle, .avatar-wrapper, a[href*="profile"]',
    // Link or menu item leading to Change Password dialog / page
    changePasswordLink: 'a[href*="update-password"], a[href*="change-password"], a:has-text("Change Password"), a:has-text("Update Password")',
  },

  changePasswordForm: {
    // Current / old password input
    currentPasswordInput: 'input[name="current_password"], input[name="old_password"], #current_password, #old_password, input[placeholder*="Current" i], input[placeholder*="Old" i]',
    // New password input
    newPasswordInput: 'input[name="new_password"], #new_password, input[placeholder*="New Password" i]',
    // Confirm new password input
    confirmPasswordInput: 'input[name="confirm_password"], input[name="confirm_new_password"], #confirm_password, input[placeholder*="Confirm" i]',
    // Update / Submit button
    submitButton: 'button[type="submit"]:has-text("Update"), button[type="submit"]:has-text("Change"), form#changePasswordForm button[type="submit"], button.btn-primary:has-text("Submit")',
    // Status indicators
    successMessage: '.swal2-icon-success, .alert-success, :text-matches("password.*(changed|updated|successful)", "i")',
    errorMessage: '.swal2-icon-error, .alert-danger, .error-message, :text-matches("current password.*incorrect|error", "i")',
  }
};
