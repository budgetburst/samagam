# KVS Samagam Continuous Automation Engine (Render.com)

A robust Node.js and Playwright automation background worker designed for 24/7 continuous operation on [Render.com](https://render.com).

Maintains continuous authenticated sessions, performs periodic credential integrity verifications in separate browser profiles, executes 15-minute logout/login maintenance cycles, and automatically restores credentials back to the universal baseline password (`samagam`) if modified.

---

## Key Features

1. **Universal Password Architecture (`samagam`)**:
   - Universal baseline password is `samagam` (`KVS_UNIVERSAL_PASSWORD`).
   - All verifications and relogins target this universal password.
2. **Dual Browser Profile Isolation**:
   - **Main Profile (`main_profile`)**: Continuous authenticated session that handles the 15-minute relogin cycle.
   - **Verification Profile (`verify_profile`)**: Ephemeral, isolated browser context for 5-minute credential checks with zero cookie cross-contamination.
3. **Automatic Password Restoration**:
   - If the password is changed and 5-minute verification fails with an incorrect password error, the engine navigates to `https://samagam.kvs.gov.in/user/update-password` from the logged-in profile, restores the password **BACK to `samagam`**, and validates in the verification profile.
4. **Cloudflare Turnstile Bypass in Containers**:
   - Utilizes `xvfb-run` inside Docker to run headed Chromium on virtual display `:99`.
   - Actively polls `cf-turnstile-response` to ensure the Turnstile token is generated before form submission.
   - Re-verifies DOM fields right before submitting to prevent input wipes.
5. **Dual-Mode Web Service / Background Worker**:
   - Includes lightweight HTTP server (`server.js`) listening on port 10000 with `/healthz` and `/status` endpoints.
   - Deployable as a Free Web Service or Background Worker on Render.
6. **Zero Credential Leaks**:
   - Built-in redaction filter in `logger.js` prevents passwords, cookies, and tokens from appearing in Render console logs.

---

## Project Structure

```
├── Dockerfile              # Container with Playwright v1.50.1 + Xvfb virtual display
├── render.yaml             # Render Blueprint configuration
├── server.js               # Healthcheck & status HTTP listener (port 10000)
├── index.js                # Main automation engine & lifecycle scheduler
├── selectors.js            # DOM selector registry for KVS Samagam portal
├── logger.js               # Structured logger with automatic credential redaction
├── mutex.js                # AsyncMutex coordinating verification & relogin cycles
├── package.json            # Scripts & dependencies
├── .env.example            # Environment variable template
└── test-verification.js    # Automated unit and integration test suite
```

---

## Deployment on Render.com

### Option A: Deploy via Render Blueprint (`render.yaml`)

1. Go to your [Render Dashboard](https://dashboard.render.com).
2. Click **New** > **Blueprint**.
3. Connect your repository: `https://github.com/theojassahu/samagam.git`.
4. Render will automatically parse `render.yaml` and set up the Docker service.
5. In the Render Dashboard, fill in your secret environment variables:
   - `KVS_LOGIN_ID`: Your portal login ID (e.g., `EP.45354`)
   - `KVS_UNIVERSAL_PASSWORD`: `samagam`
   - `KVS_ALTERNATE_PASSWORD`: `writukapanty` (optional fallback candidate)
6. Click **Apply**.

### Option B: Deploy as a Web Service (Docker)

1. Click **New** > **Web Service**.
2. Select your repository `https://github.com/theojassahu/samagam.git`.
3. Configure the service:
   - **Runtime**: `Docker`
   - **Region**: Oregon or Frankfurt
   - **Plan**: Free or Starter
4. Under **Environment Variables**, configure:
   - `PORT`: `10000`
   - `HEADLESS`: `false`
   - `DISPLAY`: `:99`
   - `KVS_BASE_URL`: `https://samagam.kvs.gov.in`
   - `KVS_LOGIN_ID`: `EP.45354`
   - `KVS_UNIVERSAL_PASSWORD`: `samagam`
   - `CHECK_INTERVAL_MS`: `300000` (5 minutes)
   - `RELOGIN_INTERVAL_MS`: `900000` (15 minutes)
5. Click **Deploy Web Service**.

---

## Monitoring & Health Checks

Once deployed, you can monitor the service using the built-in HTTP endpoints:

- **Health Check**: `GET /healthz` -> Returns `200 OK` (`{"status":"ok"}`)
- **Detailed Status**: `GET /status` -> Returns live JSON status:
  ```json
  {
    "status": "healthy",
    "automation": {
      "uptimeSeconds": 1820,
      "activePassword": "UNIVERSAL_PASSWORD (samagam)",
      "universalPassword": "samagam",
      "updatePasswordUrl": "https://samagam.kvs.gov.in/user/update-password",
      "isMutexLocked": false,
      "isBrowserActive": true,
      "intervals": {
        "verificationMinutes": 5,
        "reloginMinutes": 15
      },
      "lastVerification": { "status": "success" },
      "lastRelogin": { "status": "success" }
    }
  }
  ```

---

## Local Verification

To run the automated verification test suite locally:

```bash
npm test
```

Expected output:
```text
--- RUNNING AUTOMATED VERIFICATION CHECKS (RENDER WORKER) ---
1. Testing Logger Sanitization... [PASS]
2. Testing Universal Password & URL Configuration... [PASS]
3. Testing Profile Separation Architecture... [PASS]
4. Testing Incorrect Password Error Parser... [PASS]
5. Testing AsyncMutex Concurrency Lock... [PASS]
6. Testing Selectors Registry... [PASS]
7. Testing Universal Password Restoration Logic... [PASS]
--- ALL VERIFICATION CHECKS PASSED SUCCESSFULLY ---
```