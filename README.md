# KVS Samagam Continuous Multi-Account Automation Engine

A robust Node.js and Playwright automation background worker designed for 24/7 continuous operation on **GitHub Actions** and **Render.com**.

Monitors and maintains continuous authenticated sessions across multiple configured KVS portal accounts, performs credential integrity verification in isolated browser profiles every 5 minutes, executes periodic 15-minute logout/login maintenance cycles, and automatically restores credentials back to the universal baseline password if changed.

---

## Key Features

1. **Multi-Account Concurrent & Isolated Architecture**:
   - Manages multiple accounts simultaneously via comma-separated `KVS_LOGIN_IDS`.
   - Each account operates inside dedicated browser sandboxes (`main_profile/<safeId>` and `verify_profile/<safeId>`), ensuring zero cookie cross-contamination or session collisions.

2. **Universal Baseline Password Architecture**:
   - Primary baseline password configured via `KVS_UNIVERSAL_PASSWORD`.
   - All verifications and relogins target this universal baseline password across all configured accounts.
   - Supports an optional fallback candidate (`KVS_ALTERNATE_PASSWORD`) to recover access if credentials were changed.

3. **Strict 5-Minute Verification & 15-Minute Relogin Schedules**:
   - **5-Minute Credential Verification**: Checks login validity using an isolated, ephemeral verification profile for each account without disrupting active sessions.
   - **15-Minute Relogin Maintenance**: Performs clean session renewal (logout and re-authentication) in the main profile.

4. **Automatic Password Self-Healing**:
   - If an account password fails 5-minute verification due to credential mismatch, the engine navigates to the portal password update page from the logged-in main profile, restores the password **BACK to the universal baseline password**, and verifies restoration in the isolated profile.

5. **Government NIC SSL & Cloudflare Turnstile Handling**:
   - Configured with `ignoreHTTPSErrors: true` and `--ignore-certificate-errors` to handle the government NIC certificate chain on `samagam.kvs.gov.in`.
   - Runs headed Chromium with `xvfb-run` on virtual display `:99` in Docker/CI.
   - Actively polls `cf-turnstile-response` to ensure Cloudflare verification completes before form submission.
   - Directly triggers login modal rendering in the DOM if overlays are inactive.

6. **24/7 Continuous Execution (GitHub Actions)**:
   - Hosted on public repository [budgetburst/samagam](https://github.com/budgetburst/samagam.git) with **unlimited free GitHub Actions compute minutes**.
   - **Multi-Stage Worker Pipeline**: Executes sequential 340-minute stages (`Stage 1` -> `Stage 2` -> `Stage 3` -> `Stage 4`) within a single workflow run (~23 hours of continuous runtime per run), where each stage runs on a fresh VM with clean memory and restored session cache.
   - **Self-Chaining Auto-Dispatch**: Automatically dispatches a fresh workflow run upon stage completion using GitHub Actions tokens, keeping the engine running 24/7 without manual restarts.
   - **Automated Cron Queue**: Periodic schedule keeps queued runs ready to execute immediately when previous runs conclude.

7. **Zero Credential Leaks**:
   - Built-in redaction filter in `logger.js` automatically redacts all configured passwords, tokens, cookies, and login IDs from stdout and CI logs.

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

| Variable | Description | Example / Format |
| :--- | :--- | :--- |
| `KVS_LOGIN_IDS` | Comma-separated list of login IDs | `YOUR_ID_1,YOUR_ID_2,YOUR_ID_3` |
| `KVS_LOGIN_ID` | Single account fallback (if `KVS_LOGIN_IDS` omitted) | `YOUR_ID_1` |
| `KVS_UNIVERSAL_PASSWORD` | Universal baseline password | `YOUR_UNIVERSAL_PASSWORD` |
| `KVS_ALTERNATE_PASSWORD` | Optional fallback candidate password | `YOUR_ALTERNATE_PASSWORD` |
| `KVS_BASE_URL` | Portal base URL | `https://samagam.kvs.gov.in` |
| `CHECK_INTERVAL_MS` | Verification interval (ms) | `300000` (5 minutes) |
| `RELOGIN_INTERVAL_MS` | Relogin maintenance interval (ms) | `900000` (15 minutes) |
| `HEADLESS` | Run browser in headless mode | `false` (recommended with Xvfb) |
| `DISPLAY` | Virtual X11 display for Xvfb | `:99` |

---

## Deployment: GitHub Actions (Recommended - 100% Free 24/7)

The public repository at [budgetburst/samagam](https://github.com/budgetburst/samagam.git) has **unlimited free GitHub Actions runner minutes** with 7 GB of RAM and virtual display support.

### 1. Add Repository Secrets
In your GitHub repository:
Navigate to **Settings** > **Secrets and variables** > **Actions** > **New repository secret**:
- `KVS_LOGIN_IDS`: Your comma-separated login IDs (e.g. `YOUR_ID_1,YOUR_ID_2,YOUR_ID_3`)
- `KVS_UNIVERSAL_PASSWORD`: Your universal baseline password
- `KVS_ALTERNATE_PASSWORD`: Your fallback candidate password (optional)
- `ACTIONS_PAT`: *(Recommended for seamless 24/7 auto-restart)* A GitHub Personal Access Token (classic) with `repo` and `workflow` permissions. This allows each workflow run to automatically dispatch the next fresh run without human intervention.

### 2. How the 24/7 Fresh Restarts Work
GitHub Actions has a 360-minute (6-hour) maximum execution limit per job. The automation engine handles this automatically through a 3-tier architecture:
1. **Multi-Stage Sequential Jobs**: Each workflow run executes 4 sequential stages (`Stage 1` -> `Stage 2` -> `Stage 3` -> `Stage 4`), each running for ~340 minutes on a fresh runner VM. When Stage 1 reaches 340 minutes, Stage 2 launches immediately on a fresh runner with clean RAM and restored session cookies.
2. **Auto-Dispatch Chaining**: As each stage completes, the workflow dispatches a fresh new workflow run via GitHub API / `gh` CLI.
3. **Continuous Cron Fallback**: The scheduled trigger keeps pending runs queued in GitHub Actions, ensuring that if a runner terminates, the next run starts immediately.

### 3. Execution Modes
- **Continuous Loop (`continuous-loop`)**: Runs multi-stage continuous workers with 5-minute verification and 15-minute relogins 24/7.
- **Single Pass (`single-pass`)**: Iterates through all accounts once, verifies credentials, restores baseline password if needed, refreshes sessions, and exits cleanly (~1 min).

---

## Deployment: Render.com (Alternative)

### Option A: Deploy via Render Blueprint (`render.yaml`)

1. Go to your [Render Dashboard](https://dashboard.render.com).
2. Click **New** > **Blueprint**.
3. Connect your repository: `https://github.com/budgetburst/samagam.git`.
4. Render will parse `render.yaml` and configure the Docker service.
5. In the Render Dashboard, fill in your secret environment variables:
   - `KVS_LOGIN_IDS`: `YOUR_ID_1,YOUR_ID_2,YOUR_ID_3`
   - `KVS_UNIVERSAL_PASSWORD`: `YOUR_UNIVERSAL_PASSWORD`
   - `KVS_ALTERNATE_PASSWORD`: `YOUR_ALTERNATE_PASSWORD`
6. Click **Apply**.

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
      "activePassword": "UNIVERSAL_PASSWORD",
      "universalPassword": "[CONFIGURED]",
      "updatePasswordUrl": "https://samagam.kvs.gov.in/user/update-password",
      "intervals": {
        "verificationMinutes": 5,
        "reloginMinutes": 15
      },
      "accountStatuses": {
        "ACCOUNT_1": { "lastVerification": "success", "lastRelogin": "success" },
        "ACCOUNT_2": { "lastVerification": "success", "lastRelogin": "success" },
        "ACCOUNT_3": { "lastVerification": "success", "lastRelogin": "success" }
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
   [PASS] Universal baseline password loaded correctly.
   [PASS] Password update URL: https://samagam.kvs.gov.in/user/update-password
3. Testing Profile Separation Architecture...
   [PASS] Main Profile: .../.kvs_render_profile/main_profile
   [PASS] Verify Profile: .../.kvs_render_profile/verify_profile
   [PASS] Separate profiles guaranteed for logged-in session and verification.
3b. Testing Multi-Account Configuration & Directory Paths...
   [PASS] Multi-account support verified: [TEST_USER_1, TEST_USER_2, TEST_USER_3]
   [PASS] Dedicated isolated profile paths guaranteed for each account.
4. Testing Incorrect Password Error Parser...
   [PASS] isIncorrectPasswordError accurately detects credential failures vs transient issues.
5. Testing AsyncMutex Concurrency Lock...
   [PASS] AsyncMutex maintains strict mutual exclusion.
6. Testing Selectors Registry...
   [PASS] All selector definitions validated.
7. Testing Universal Password Restoration Logic...
   [PASS] Password restored back to universal password from logged-in profile.
8. Testing Action Runner Module Structure...
   [PASS] Action runner module loaded and verified successfully.
--- ALL VERIFICATION CHECKS PASSED SUCCESSFULLY ---
```