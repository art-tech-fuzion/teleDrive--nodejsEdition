You are a senior full-stack backend engineer. Migrate and upgrade my existing PHP-based "TeleDrive" codebase into a high-performance, production-ready Node.js application (Express.js backend + Vanilla JS/Tailwind frontend).

### GOAL & OBJECTIVE:
Replace the old Telegram Bot API (which had a 50MB limit) with native Telegram MTProto User API (using `telegram` / GramJS package). This will enable:
1. Native 2GB single-file uploads without Bot API restrictions (100% Free Telegram account).
2. Large file handling for files > 2GB by automatically splitting them into 1.9GB volume parts and stream-merging them on download.
3. Completely stateless server with ZERO external databases (Telegram acts as storage and NoSQL DB).

---

### CORE ARCHITECTURAL SPECIFICATIONS:

1. TELEGRAM MTPROTO ENGINE (`telegram` / GramJS):
   - Authenticate using `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, and a persistent `TELEGRAM_STRING_SESSION` (User Client, NOT a Bot).
   - Direct file upload using `client.sendFile()` / `uploadFile()` with custom chunk streaming to maximize transfer speeds.
   - For files <= 2GB: Upload directly as a single file to the Storage Channel.
   - For files > 2GB: Split stream dynamically into 1.9GB parts (`.part1`, `.part2`) and upload sequentially to the Storage Channel.

2. ZERO DATABASE & TWO-CHANNEL ARCHITECTURE:
   - Storage Channel: Stores raw files and 1.9GB multipart chunks.
   - Index Channel: Acts as the NoSQL database storing JSON metadata messages.

3. 50-MESSAGE CHECKPOINTING ENGINE:
   - Post folder creation and file upload events as JSON messages in the Index Channel.
   - Maintain the 50-message compaction cycle:
     a. Every 50 delta messages, fetch the pinned `master_manifest.json` document (if existing).
     b. Merge the 50 delta metadata records into the manifest.
     c. Upload the consolidated `master_manifest.json` as a document to the Index Channel.
     d. Pin the new manifest message using MTProto API and delete/unpin the previous one.
   - On app reload/boot: Fetch ONLY the pinned `master_manifest.json` + delta messages for instant (<500ms) directory tree rendering.

4. SEAMLESS STREAMING DOWNLOAD & MERGE:
   - For single-part files: Stream file bytes directly from Telegram to HTTP response (`res`).
   - For multi-part (>2GB) files: Stream sequential parts back-to-back into the same HTTP response stream without ever storing the full file on the server disk.

5. FOLDER MANAGEMENT & CRUD:
   - Full virtual folder tree support (root, subfolders, breadcrumbs).
   - In-place renaming via Telegram message edit API.
   - Cascade delete (deleting a folder recursively wipes all its files from Storage Channel and metadata from Index Channel).

6. FRONTEND & UI:
   - Modern Google Drive style UI (HTML5, CSS, Vanilla JS).
   - Real-time progress tracking via `XMLHttpRequest.upload.onprogress` (displaying %, upload speed in MB/s, and byte counters).
   - Drag-and-drop file uploader and breadcrumb folder navigation.

7. AUTHENTICATION & CONFIG:
   - Protected routes using session/JWT tokens.
   - Load configuration from `.env` (`ADMIN_USERNAME`, `ADMIN_PASSWORD_HASH`, `API_ID`, `API_HASH`, `STRING_SESSION`, `STORAGE_CHANNEL_ID`, `INDEX_CHANNEL_ID`, `PORT`).
   - Provide a quick CLI helper script `generate-session.js` to log in with phone number + OTP and generate the initial `STRING_SESSION`.

---

### DELIVERABLES:
1. Complete project structure.
2. `package.json` with all required dependencies.
3. `generate-session.js` (one-time interactive login script).
4. Backend server (`server.js`, MTProto client service, Index/Storage managers).
5. Frontend assets (`index.html`, `app.js`, `style.css`).
6. `.env.example` and step-by-step setup instructions.