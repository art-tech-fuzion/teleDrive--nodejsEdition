# TeleDrive Node.js MTProto Migration Plan

Migrate and upgrade the existing PHP-based "TeleDrive" codebase into a high-performance, production-ready Node.js application powered by the native Telegram MTProto User API (`telegram` / GramJS). This removes the 50MB Telegram Bot API limit and unlocks 2GB single uploads (and >2GB dynamic multi-part streaming) with zero external databases.

## User Review Required

> [!IMPORTANT]
> - **Telegram MTProto User API (GramJS)**: Replaces the Bot token with `API_ID`, `API_HASH`, and `STRING_SESSION` generated via `generate-session.js`.
> - **Zero Database Architecture**: Metadata is stored directly in the Telegram Index Channel with a 50-message manifest checkpointing engine and local memory/file cache for sub-second responses.
> - **Uploads & Streaming**: Direct file uploads with client-to-server chunking/pipelining and streaming download directly from Telegram MTProto to Express HTTP responses without storing full multi-GB files on disk.

## Proposed Architecture & Directory Structure

```
TeleDrive-nodejs/
├── package.json
├── package-lock.json
├── .env.example
├── .gitignore
├── generate-session.js            # Interactive CLI tool to generate STRING_SESSION
├── server.js                      # Express HTTP server & entry point
├── src/
│   ├── config/
│   │   └── index.js               # Environment loader & configuration validation
│   ├── services/
│   │   ├── telegram.js            # GramJS MTProto client service (upload, download stream, channels)
│   │   ├── storageEngine.js       # Zero-DB Storage & 50-message Checkpointing Manifest Engine
│   │   └── auth.js                # Session/JWT authentication & password verification (bcrypt)
│   ├── routes/
│   │   ├── api.js                 # Unified API router (files, folders, auth, system)
│   │   └── views.js               # Web frontend routes (dashboard, login)
│   └── utils/
│       ├── helpers.js             # Mime type detection, size formatting, sanitization
│       └── streamSplitter.js      # Part-splitting / streaming utilities for >2GB files
├── assets/                        # Static UI assets (global.css, global.js, app.css, app.js, login.css, login.js)
├── templates/                     # HTML templates served dynamically / statically
│   ├── backend/
│   │   └── login.html
│   └── frontend/
│       └── app.html
└── temp_chunks/                   # Scratch directory for in-flight upload chunks
```

## Proposed Changes

### 1. Project Initialization & Dependencies
#### [NEW] [package.json](file:///Users/rahulkumar/Desktop/TeleDrive-nodejs/package.json)
- Dependencies: `telegram` (GramJS), `express`, `dotenv`, `cors`, `cookie-parser`, `express-session`, `bcryptjs`, `multer`, `mime-types`, `input` / `@inquirer/prompts` (for interactive CLI).

#### [NEW] [.env.example](file:///Users/rahulkumar/Desktop/TeleDrive-nodejs/.env.example)
- Configuration variables: `PORT`, `ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `API_ID`, `API_HASH`, `STRING_SESSION`, `STORAGE_CHANNEL_ID`, `INDEX_CHANNEL_ID`, `TEMP_CHUNK_DIR`.

---

### 2. Telegram MTProto Client & Session Generator
#### [NEW] [generate-session.js](file:///Users/rahulkumar/Desktop/TeleDrive-nodejs/generate-session.js)
- One-time interactive CLI script using `telegram/sessions/StringSession` and `telegram/TelegramClient`.
- Prompts for API ID, API Hash, phone number, SMS OTP, and 2FA password (if enabled).
- Prints and saves the generated `STRING_SESSION` to `.env`.

#### [NEW] [src/services/telegram.js](file:///Users/rahulkumar/Desktop/TeleDrive-nodejs/src/services/telegram.js)
- Initializes singleton `TelegramClient` with `StringSession`.
- Handles channel resolution (`peer` resolution for storage and index channels).
- High-speed MTProto file upload (`client.sendFile` / `uploadFile` with custom worker concurrency and chunk size).
- High-speed streaming download using `iterDownload` / `downloadMedia` with Range and backpressure support.
- Channel message fetching, posting, editing, pinning, unpinning, and batch deleting.

---

### 3. Zero-Database Storage Engine & Checkpointing
#### [NEW] [src/services/storageEngine.js](file:///Users/rahulkumar/Desktop/TeleDrive-nodejs/src/services/storageEngine.js)
- 50-Message Compaction Cycle:
  1. Boot: Reads pinned `master_manifest.json` from Index Channel + delta messages; caches locally in memory & `temp_chunks/index_cache.json`.
  2. Delta Events: New file, new folder, rename, move, delete logged as JSON messages in Index Channel.
  3. Compaction: When delta messages reach 50, consolidates all metadata, uploads `master_manifest.json`, pins it, unpins old manifest, and purges superseded delta messages.
  4. Instant lookups (<50ms) from local cache with auto-sync.

---

### 4. Express Application & REST API
#### [NEW] [server.js](file:///Users/rahulkumar/Desktop/TeleDrive-nodejs/server.js)
- Configures middleware: JSON parser, URL-encoded parser, cookie parser, sessions, security headers (CSP, CORS, X-Frame-Options, nosniff).
- Mounts `/api` routes and backward-compatible `api/index.php` action router.
- Serves static assets from `assets/` and pages from `templates/`.

#### [NEW] [src/routes/api.js](file:///Users/rahulkumar/Desktop/TeleDrive-nodejs/src/routes/api.js)
- Routes:
  - `auth.login`, `auth.logout`, `auth.status`
  - `files.list`, `folders.list`
  - `files.upload_chunk`, `files.complete_upload`, `files.cancel_upload`
  - `files.download`, `files.preview` (stream direct from Telegram)
  - `folder.create`, `items.rename`, `items.move`, `items.delete`, `items.bulk_delete`
  - `system.status`, `system.purge_index_messages`

---

### 5. Frontend & UI Integration
#### [NEW] [templates/frontend/app.html](file:///Users/rahulkumar/Desktop/TeleDrive-nodejs/templates/frontend/app.html) & [templates/backend/login.html](file:///Users/rahulkumar/Desktop/TeleDrive-nodejs/templates/backend/login.html)
- Clean HTML5 templates converted from PHP views, maintaining modern Google Drive styling.
- Compatible with existing `assets/global.css`, `assets/global.js`, `assets/frontend/app.css`, `assets/frontend/app.js`, `assets/backend/login.css`, `assets/backend/login.js`.

---

## Verification Plan

### Automated / Syntax Verification
- Run Node syntax checks: `node -c server.js`, `node -c generate-session.js`, `node -c src/**/*.js`.
- Run dependency audit and test server startup with dummy/mock env configuration.

### Functional Verification
- Verify `generate-session.js` script CLI prompts.
- Verify Express routes (`/api`, `api/index.php`, `/`, `/login`, `/logout`).
- Verify Auth login/logout flow, CSRF token handling, and session persistence.
- Verify StorageEngine indexing, delta recording, manifest compaction logic.
- Verify upload chunking, multipart combination (>2GB support), and streaming download piping.
