# TeleDrive Changelog

All notable changes to the TeleDrive project will be documented in this file.

---

## [4.1.2] - 2026-10-02

### 🔐 Configurable Persistent Session Directory & Resilient Store
1. **Configurable Session Directory (`SESSION_DIR`)**:
   - Added support for `SESSION_DIR` environment variable in `DiskSessionStore` constructor (`server.js`).
   - Allows configuring a persistent directory outside versioned deployment build folders on Hostinger, cPanel, or Linux hosting providers to prevent user session loss during server auto-purges or redeployments.
   - Added `.env.example` documentation for setting persistent session paths (`SESSION_DIR`).

2. **Self-Healing Session Directory Verification (`_ensureDir()`)**:
   - Added automated directory verification (`this._ensureDir()`) across all `DiskSessionStore` operations (`get`, `set`, `destroy`, `touch`).
   - Prevents `ENOENT: no such file or directory` exceptions on fresh deployments or uninitialized storage directories.

---

## [4.1.1] - 2026-10-02

### 🧹 Automated Temp Chunk Cleaner & Server Path Masking
1. **Automated Background Purge Engine (`cleanup-temp-chunks.js`)**:
   - Implemented daemon-mode automated background cleanup scanning for temporary upload chunk directories (`temp_chunks`).
   - Added inner-file timestamp inspection (`fs.statSync`) to accurately measure folder age based on the last written chunk rather than folder creation time.
   - Prevents disk space leakage on server environments (Hostinger / cPanel / Linux).

2. **Hostinger / Passenger Module Lifecycle Integration (`src/services/tempCleaner.js`)**:
   - Placed `tempCleaner.init()` at server top-level scope in `server.js` so background cleanup activates seamlessly under both standard CLI (`node server.js`) and Passenger application servers.
   - Added single-instance execution protection (`isStarted` guard) to prevent duplicate `setInterval` timers on module reload.

3. **Log Security & Information Leak Shielding**:
   - Masked internal absolute server path references in cleanup log output (`./temp_chunks`), eliminating directory structure exposure in server logs.

---

## [3.0.0] - 2026-10-01

### 🚀 Major Highlights
Version **v3.0.0** is a major milestone release focusing on **Zero-Database Engine Resilience**, **14-Point Comprehensive Security Hardening**, **Upload Concurrency & Rate-Limit Shielding**, and a **Standardized Production Build Pipeline**.

---

### 🗄️ Zero-Database Storage & Compaction Engine
1. **Empty Index Channel Auto-Initialization**:
   - When the index channel is empty upon clicking **Refresh** or initializing storage, the engine automatically creates, uploads, and pins an empty JSON root manifest (`files_manifest.json`).
   - If index data or delta messages already exist, the engine loads them without creating unnecessary duplicate manifests.
2. **Automated Checkpoint Pinning on Compaction**:
   - Fixed compaction cycles (triggered at the 10-message delta threshold): whenever deltas are merged into a new consolidated manifest document, the resulting JSON file is **automatically pinned** in the Index Channel, and obsolete delta messages are pruned.
3. **Telegram MTProto Rate-Limit (`FLOOD_WAIT`) Resilience**:
   - Integrated a 3-stage exponential backoff retry loop in `TelegramService.sendTextMessage` to survive rapid bursts.
   - Configured `floodSleepThreshold: 120` in `TelegramClient` initialization to allow GramJS to sleep through temporary Telegram rate-limit throttles automatically.
4. **Resilient Compaction Execution**:
   - Wrapped compaction and index rebuild procedures in robust `try/catch` handlers in `storageEngine.js`, ensuring background compaction faults never crash active upload or download streams.
5. **Temporary File Buffer Strategy**:
   - Refactored `uploadDocumentBuffer` to stream via temporary files on disk, resolving GramJS `MEDIA_INVALID` errors caused by empty CustomFile paths.

---

### 🛡️ 14-Point Full Codebase Security & Integrity Hardening
A comprehensive security audit was executed across all layers with 100% resolution:

1. **CRIT-1 — CSRF Protection Enforced**:
   - Enforced `AuthService.verifyCsrf(req)` across all mutating API routes (`handleAction()`) using an explicit `SAFE_ACTIONS` allowlist for read-only endpoints.
2. **CRIT-2 — Auth Guard on Upload Progress**:
   - Added session authorization verification to `files.upload_progress` (`/api?action=files.upload_progress`) to prevent unauthenticated access to active transfer metadata.
3. **CRIT-3 — CORS Origin Lockdown**:
   - Replaced wildcard CORS with strict `CORS_ORIGIN` environment whitelist; disabled cross-origin by default (`false`) to eliminate credentialed cross-origin attacks.
4. **HIGH-1 — Environment-Aware Secure Cookies**:
   - Dynamically set `cookie.secure` based on environment and proxy headers (`trust proxy`), ensuring HTTPS cookie protection behind reverse proxies.
5. **HIGH-2 — Stored XSS Prevention in UI Attributes**:
   - Applied `escapeHtml()` to all file and folder `title` tooltip attributes in `app.js` to prevent HTML attribute breakout via crafted file names.
6. **HIGH-3 — Template Injection Defense**:
   - Added server-side HTML escaping for `{{USERNAME}}` replacements in `views.js`.
7. **HIGH-4 — Default Credential Warning**:
   - Added loud console warnings on startup and login if `ADMIN_PASSWORD_HASH` is not configured in `.env`.
8. **MED-1 — Information Leakage Suppression**:
   - Sanitized production error responses in `api.js` and `server.js` so internal Telegram IDs, channel hashes, and stack traces are never exposed to clients, while retaining full server logs.
9. **MED-2 — DiskSessionStore Path Traversal Protection**:
   - Sanitized session IDs in `DiskSessionStore._getFilePath()` using strict alphanumeric regex to prevent directory traversal outside `.sessions/`.
10. **MED-3 — Content-Disposition Header Injection Defense**:
    - Sanitized download filenames in HTTP headers to strip quotes (`"`), semicolons (`;`), and control characters.
11. **MED-4 — State-Changing HTTP Method Enforcement**:
    - Restricted mutating endpoints (including `auth.logout`) to POST only, returning `405 Method Not Allowed` on GET/HEAD requests.
12. **LOW-1 — Session Cookie Clearance Alignment**:
    - Synchronized `res.clearCookie('TELEDRIVE_SESSID')` on logout to properly invalidate the session cookie in browsers.
13. **LOW-2 — In-Memory Lockout Map Pruning**:
    - Added automatic stale-record pruning to `loginAttempts` to prevent memory growth under brute-force probes.
14. **LOW-3 — Safe Constant-Time Comparison**:
    - Added length validation before `crypto.timingSafeEqual()` in `AuthService.verifyCsrf()` to prevent uncaught exceptions.

---

### 🎨 Frontend & User Experience
1. **Strict 5-File Selection Limit**:
   - Added strict validation in the file selector handler (`app.js`). If more than 5 files are selected at once, the selection is rejected, the file input is cleared, and an informative toast alert is displayed.
2. **Queue Item Dismissal**:
   - Enabled dismiss/cancel actions for individual failed or completed items in the upload queue.
3. **Dynamic Cache-Busting**:
   - Implemented `filemtime`-based dynamic versioning (`{{ASSET_VERSION}}`) for scripts and stylesheets rendered by `views.js`.

---

### 📦 Build & Compression Pipeline
1. **Automated `npm run build` Script**:
   - Added [`build-dist.js`](./build-dist.js) to clean, compress, and regenerate the `dist/` directory on demand.
   - Compresses CSS (up to 36.5% reduction), minifies HTML templates (up to 36.2% reduction), strips comments and optimizes JavaScript bundles.
   - Automatically injects security `index.php` ("Silence is golden") files into every subfolder to prevent directory listing on Apache/Hostinger environments.
   - Validates all generated JavaScript bundles via VM script syntax verification during build.

---

## [2.1.0] - 2026-09-30

### 🛡️ Security Vulnerabilities Patched (15 CVEs Cleared)
In version **v2.0.0**, automated security scanners (such as Hostinger hPanel Security Scanner and npm audit) reported **15 unpatched vulnerabilities** across dependencies. Version **v2.1.0** completely resolves all 15 advisories (`found 0 vulnerabilities`):

1. **Multer (10 High Severity + 1 Low Severity CVEs):**
   - **Vulnerable Version in v2.0.0:** `multer@1.4.5-lts.2`
   - **Patched Version in v2.1.0:** `multer@^2.0.0` (`2.4.0`)
   - **Vulnerabilities Resolved:**
     - **CVE-2026-77078 & CVE-2026-82333 (High):** Denial of Service (DoS) via crafted multipart form-data boundaries.
     - **CVE-2026-5079, CVE-2026-3520, CVE-2026-3304, CVE-2026-2359 (High):** Uncontrolled memory consumption and event-loop blocking in legacy parser internals.
     - **CVE-2025-7338, CVE-2025-48997, CVE-2025-47944, CVE-2025-47935 (High):** Process hangs and DoS vectors on malformed multipart boundary chains.
     - **CVE-2026-77063 (Low):** File size limit bypass vulnerability during multipart stream processing.

2. **qs (1 Moderate Severity + 1 Low Severity CVEs):**
   - **Vulnerable Version in v2.0.0:** `qs@6.15.3` (transitive dependency from `express` $\rightarrow$ `body-parser`)
   - **Patched Version in v2.1.0:** `qs@^6.15.4` (enforced via npm `overrides`)
   - **Vulnerabilities Resolved:**
     - **CVE-2026-82417 (Moderate):** DoS via attacker-controlled parameters causing exponential parsing complexity.
     - **CVE-2026-82562 (Low):** Array-limit bypass via specific bracket-key comma syntax.

3. **ip-address (2 Moderate Severity CVEs):**
   - **Vulnerable Version in v2.0.0:** `ip-address@10.7.0` (transitive dependency from `telegram` $\rightarrow$ `socks`)
   - **Patched Version in v2.1.0:** `ip-address@^10.7.1` (enforced via npm `overrides`)
   - **Vulnerabilities Resolved:**
     - **CVE-2026-101911 (Moderate):** `Address6` builds unconstrained parse diagnostics proportional to input, allowing long malicious strings to crash the process.
     - **CVE-2026-101912 (Moderate):** `isInSubnet()` and `isHostInSubnet()` address family comparison flaw allowing bypass of allowlists.

---

### ⚙️ Core Runtime & Compatibility Fixes

1. **Multer 2.x Type Strictness Crash:**
   - **Issue in v2.0.0:** In `src/routes/api.js`, `limits.fileSize` was configured as `2.1 * 1024 * 1024 * 1024`. Because `2.1` is floating-point, JavaScript computed this as `2254857830.4`. Multer 2.x enforces strict integer validation and threw `TypeError: Expected limits.fileSize to be a non-negative integer or Infinity`, breaking file uploads and server initialization.
   - **Fix in v2.1.0:** Enforced `Math.floor(2.1 * 1024 * 1024 * 1024)` (`2254857830`) in both `src/routes/api.js` and `dist/src/routes/api.js`, ensuring 100% upload reliability.

2. **Hostinger FTP Deployment Manifest Sync:**
   - **Issue in v2.0.0:** GitHub Actions deployed the `dist/` directory, which contained an outdated `package-lock.json` and older dependency versions, causing Hostinger to reinstall vulnerable packages on redeploy.
   - **Fix in v2.1.0:** Synchronized `dist/package.json` and `dist/package-lock.json` with root dependency overrides, guaranteeing that server builds are identically vulnerability-free.

3. **Telegram MTProto Channel Entity Resolution:**
   - **Issue in v2.0.0:** Resolving channel entities could fail with `Could not resolve Telegram Channel entity` when channel IDs used `-100` prefix variations or were not pre-cached.
   - **Fix in v2.1.0:** Enhanced multi-stage entity resolution checking active and archived dialogs to resolve true `access_hash` credentials before falling back to input entities.

4. **Hostinger Reverse-Proxy Session Cookie Fix:**
   - **Issue in v2.0.0:** `secure: true` session cookies caused login session loss behind Hostinger's Nginx SSL termination reverse proxy.
   - **Fix in v2.1.0:** Configured `DiskSessionStore` with proxy-aware cookie settings (`secure: false` at app level, relying on upstream Nginx HTTPS).

5. **Interactive Session Generator Hardening (`generate-session.js`):**
   - **Issue in v2.0.0:** Running `npm run generate-session` on modern Node.js versions (v22/v25) caused an asynchronous runtime warning `(node) Warning: '--localstorage-file' was provided without a valid path` to print directly over the input prompt. If an empty input was entered, the script prematurely crashed with `❌ Error: API_ID must be a valid integer.`
   - **Fix in v2.1.0:** Suppressed the experimental webstorage warning and implemented interactive validation loops that gracefully re-prompt for `API_ID` and `API_HASH` until valid input is provided.

---

## [2.0.0] - 2026-09-02

- Initial major release: Zero-database cloud drive powered by Telegram MTProto (GramJS).
- 2 GB+ multipart chunked streaming engine.
- Web admin interface with session authentication.
- Automated GitHub Actions FTP deployment.
