# KVS Samagam Continuous Multi-Account Automation Engine

A robust Node.js and Playwright automation background worker designed for 24/7 continuous operation on **GitHub Actions** and **Render.com**.

Monitors and maintains continuous authenticated sessions across multiple KVS portal accounts (`EP.45354`, `EP.50696`, `CS.136206`), performs credential integrity verification in isolated browser profiles every 5 minutes, executes periodic 15-minute logout/login maintenance cycles, and automatically restores credentials back to the universal baseline password (`samagam`) if changed.

---

## Key Features

1. **Multi-Account Concurrent & Isolated Architecture**:
   - Manages multiple accounts seamlessly (default: `EP.45354`, `EP.50696`, `CS.136206`).
   - Configurable via comma-separated `KVS_LOGIN_IDS`.
   - Each account has dedicated browser sandboxes (`main_profile/<safeId>` and `verify_profile/<safeId>`), ensuring zero cookie cross-contamination or session collisions.

2. **Universal Password Architecture (`samagam`)**:
   - Universal baseline password is `samagam` (`KVS_UNIVERSAL_PASSWORD`).
   - All verifications and relogins target this universal password across all configured accounts.
   - Supports fallback candidate `writukapanty` (`KVS_ALTERNATE_PASSWORD`) if ever needed during transition.

3. **Strict 5-Minute Verification & 15-Minute Relogin Schedules**:
   - **5-Minute Credential Verification**: Checks login validity using an isolated, ephemeral verification profile for each account without disrupting the active main session.
   - **15-Minute Relogin Maintenance**: Performs clean session renewal (logout and re-authentication) in the main profile.

4. **Automatic Password Self-Healing**:
   - If an account password is changed and 5-minute verification fails with an incorrect password error, the engine navigates to `https://samagam.kvs.gov.in/user/update-password` from the logged-in main profile, restores the password **BACK to `samagam`**, and validates in the verification profile.

5. **Government NIC SSL & Cloudflare Turnstile Handling**:
   - Configured with `ignoreHTTPSErrors: true` and `--ignore-certificate-errors` to handle the government NIC certificate chain on `samagam.kvs.gov.in`.
   - Runs headed Chromium with `xvfb-run` on virtual display `:99` in Docker/CI.
   - Actively polls `cf-turnstile-response` to ensure Cloudflare verification completes before form submission.
   - Directly triggers login modal rendering in the DOM if overlays are inactive.

6. **24/7 Continuous Cloud Execution via GitHub Actions**:
   - Public repository hosted at [budgetburst/samagam](https://github.com/budgetburst/samagam.git) with **unlimited free GitHub Actions compute minutes**.
   - Automated cron schedule triggers every 28 minutes.
   - Auto-chaining dispatch keeps continuous-loop runners alive 24/7.

7. **Dual-Mode Web Service / Background Worker (Render.com)**:
   - Includes lightweight HTTP server (`server.js`) listening on port 10000 with `/healthz` and `/status` endpoints.
   - Real-time JSON health reporting per account.

8. **Zero Credential Leaks**:
   - Built-in redaction filter in `logger.js` prevents passwords, cookies, and tokens from appearing in console logs or CI artifacts.

---

## Project Structure

```
├── Dockerfile              # Container with Playwright v1.50.1 + Xvfb virtual display
├── render.yaml             # Render Blueprint configuration
├── server.js               # Healthcheck & status HTTP listener (port 10000)
├── index.js                # Multi-account automation engine & lifecycle scheduler
├── action-runner.js        # GitHub Actions runner for single-pass & continuous modes
├── selectors.js            # DOM selector registry for KVS Samagam portal
├── logger.js               # Structured logger with automatic credential redaction
├── mutex.js                # AsyncMutex coordinating verification & relogin cycles
├── package.json            # Scripts & dependencies
├── .env.example            # Environment variable template
└── test-verification.js    # Automated unit and integration test suite
```

---

## Configuration & Environment Variables

| Variable | Description | Default / Example |
| :--- | :--- | :--- |
| `KVS_LOGIN_IDS` | Comma-separated list of login IDs | `EP.45354,EP.50696,CS.136206` |
| `KVS_LOGIN_ID` | Single account fallback (if `KVS_LOGIN_IDS` omitted) | `EP.45354` |
| `KVS_UNIVERSAL_PASSWORD` | Primary baseline password | `samagam` |
| `KVS_ALTERNATE_PASSWORD` | Fallback candidate password | `writukapanty` |
| `KVS_BASE_URL` | Portal base URL | `https://samagam.kvs.gov.in` |
| `CHECK_INTERVAL_MS` | Verification interval (ms) | `300000` (5 minutes) |
| `RELOGIN_INTERVAL_MS` | Relogin maintenance interval (ms) | `900000` (15 minutes) |
| `HEADLESS` | Run browser in headless mode | `false` (recommended with Xvfb) |
| `DISPLAY` | Virtual X11 display for Xvfb | `:99` |

---

## Deployment: GitHub Actions (Recommended - 100% Free 24/7)

The repository at [https://github.com/budgetburst/samagam.git](https://github.com/budgetburst/samagam.git) is public, granting **unlimited free GitHub Actions runner minutes** with 7 GB of RAM and virtual display support.

### 1. Add Repository Secrets
In your GitHub repository:
Navigate to **Settings** > **Secrets and variables** > **Actions** > **New repository secret**:
- `KVS_LOGIN_IDS`: `EP.45354,EP.50696,CS.136206`
- `KVS_UNIVERSAL_PASSWORD`: `samagam`
- `KVS_ALTERNATE_PASSWORD`: `writukapanty` (optional)

### 2. Execution Modes
The workflow (`.github/workflows/kvs-automation.yml`) supports two operational modes:

1. **Continuous Loop (`continuous-loop`)**:
   - Runs the full automation engine continuously across all 3 accounts.
   - Executes 5-minute credential integrity checks and 15-minute relogins.
   - Runs up to 350 minutes per job, with automated cron triggers (every 28 minutes) and automatic dispatch chaining to achieve seamless 24/7 operation.
2. **Single Pass (`single-pass`)**:
   - Iterates sequentially through all configured accounts.
   - Verifies credentials, triggers password restoration to `samagam` if tampered with, logs into the main session, and exits cleanly.

### 3. Manual Workflow Dispatch
1. Go to the **Actions** tab on your GitHub repository.
2. Select **KVS Samagam Multi-Account Automation** on the left menu.
3. Click **Run workflow**, choose your mode (`continuous-loop` or `single-pass`), and confirm.

---

## Deployment: Render.com (Alternative)

### Option A: Deploy via Render Blueprint (`render.yaml`)

1. Go to your [Render Dashboard](https://dashboard.render.com).
2. Click **New** > **Blueprint**.
3. Connect your repository: `https://github.com/budgetburst/samagam.git`.
4. Render will automatically parse `render.yaml` and configure the Docker service.
5. In the Render Dashboard, fill in your secret environment variables:
   - `KVS_LOGIN_IDS`: `EP.45354,EP.50696,CS.136206`
   - `KVS_UNIVERSAL_PASSWORD`: `samagam`
   - `KVS_ALTERNATE_PASSWORD`: `writukapanty`
6. Click **Apply**.

### Option B: Deploy as a Web Service (Docker)

1. Click **New** > **Web Service**.
2. Select your repository `https://github.com/budgetburst/samagam.git`.
3. Configure the service:
   - **Runtime**: `Docker`
   - **Region**: Oregon or Frankfurt
   - **Plan**: Free or Starter
4. Under **Environment Variables**, set:
   - `PORT`: `10000`
   - `HEADLESS`: `false`
   - `DISPLAY`: `:99`
   - `KVS_BASE_URL`: `https://samagam.kvs.gov.in`
   - `KVS_LOGIN_IDS`: `EP.45354,EP.50696,CS.136206`
   - `KVS_UNIVERSAL_PASSWORD`: `samagam`
   - `CHECK_INTERVAL_MS`: `300000` (5 minutes)
   - `RELOGIN_INTERVAL_MS`: `900000` (15 minutes)
5. Click **Deploy Web Service**.

---

## Monitoring & Health Checks

When running `server.js` (on Render or local server), monitor service health via HTTP:

- **Health Check**: `GET /healthz` -> Returns `200 OK` (`{"status":"ok"}`)
- **Multi-Account Status**: `GET /status` -> Returns live JSON status:
  ```json
  {
    "status": "healthy",
    "automation": {
      "uptimeSeconds": 1820,
      "accounts": ["EP.45354", "EP.50696", "CS.136206"],
      "universalPassword": "samagam",
      "updatePasswordUrl": "https://samagam.kvs.gov.in/user/update-password",
      "intervals": {
        "verificationMinutes": 5,
        "reloginMinutes": 15
      },
      "accountStatuses": {
        "EP.45354": { "lastVerification": "success", "lastRelogin": "success" },
        "EP.50696": { "lastVerification": "success", "lastRelogin": "success" },
        "CS.136206": { "lastVerification": "success", "lastRelogin": "success" }
      }
    }
  }
  ```

---

## Local Verification & Testing

Run the automated multi-account verification test suite locally:

```bash
npm test
```

Expected output:
```text
--- RUNNING AUTOMATED VERIFICATION CHECKS (RENDER WORKER) ---
1. Testing Logger Sanitization...
   [PASS] Logger correctly redacts universal password, alternate passwords, and session cookies.
2. Testing Universal Password & URL Configuration...
   [PASS] Universal baseline password: samagam
   [PASS] Password update URL: https://samagam.kvs.gov.in/user/update-password
3. Testing Profile Separation Architecture...
   [PASS] Main Profile: .../.kvs_render_profile/main_profile
   [PASS] Verify Profile: .../.kvs_render_profile/verify_profile
   [PASS] Separate profiles guaranteed for logged-in session and verification.
3b. Testing Multi-Account Configuration & Directory Paths...
   [PASS] Multi-account support verified: [EP.45354, EP.50696, CS.136206]
   [PASS] Dedicated isolated profile paths guaranteed for each account.
4. Testing Incorrect Password Error Parser...
   [PASS] isIncorrectPasswordError accurately detects credential failures vs transient issues.
5. Testing AsyncMutex Concurrency Lock...
   [PASS] AsyncMutex maintains strict mutual exclusion.
6. Testing Selectors Registry...
   [PASS] All selector definitions validated.
7. Testing Universal Password Restoration Logic...
   [PASS] Password restored back to universal password (samagam) from logged-in profile.
8. Testing Action Runner Module Structure...
   [PASS] Action runner module loaded and verified successfully.
--- ALL VERIFICATION CHECKS PASSED SUCCESSFULLY ---
```