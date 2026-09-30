# TeleDrive Changelog

All notable changes to the TeleDrive project will be documented in this file.

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

### 📦 Distribution (`dist/`) Minification & Compression

- **v2.0.0 State:** Several critical files in `dist/` were uncompressed and unminified (e.g. `dist/assets/frontend/app.js` was 1,691 lines, and server files were plain multi-line scripts).
- **v2.1.0 State:** 100% of production files in `dist/` are fully minified into single-line optimized bundles:
  - `dist/assets/frontend/app.js` minified (reduced from 60 KB $\rightarrow$ 34 KB).
  - `dist/assets/backend/login.js` and `dist/assets/global.js` minified.
  - `dist/assets/frontend/app.css` and `dist/assets/backend/login.css` minified.
  - Server modules (`dist/server.js`, `dist/src/services/telegram.js`, `dist/src/utils/helpers.js`) minified.
  - All templates (`dist/templates/frontend/app.html`, `dist/templates/backend/login.html`) minified.

---

### 🔒 Security & Privacy Audit Verification

- **Git Commit History Audit:** Verified that no sensitive credentials (`API_ID`, `API_HASH`, `STRING_SESSION`, or `ADMIN_PASSWORD_HASH`) were ever committed to Git history.
- **Local Secret Isolation:** Removed duplicate `dist/.env` to eliminate any accidental leak vector.
- **`.gitignore` Hardening:** Strengthened wildcard patterns (`**/.env*`, `**/*.session*`) to permanently prevent tracking of environment or session files in any directory.
- **CI/CD Security:** Confirmed that `.github/workflows/deploy.yml` utilizes GitHub Encrypted Secrets exclusively and excludes all `.env*` and `node_modules` during FTP sync.

---

## [2.0.0] - 2026-09-02

- Initial major release: Zero-database cloud drive powered by Telegram MTProto (GramJS).
- 2 GB+ multipart chunked streaming engine.
- Web admin interface with session authentication.
- Automated GitHub Actions FTP deployment.
