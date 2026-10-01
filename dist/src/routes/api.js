const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs");

const config = require("../config");
const AuthService = require("../services/auth");
const storageEngine = require("../services/storageEngine");
const telegramService = require("../services/telegram");
const Helpers = require("../utils/helpers");

const uploadProgressTracker = new Map();

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadId = (req.body.upload_id || "").replace(/[^\w\-]/g, "");
    if (!uploadId) {
      return cb(new Error("Missing or invalid upload_id"));
    }
    const sessionDir = path.join(config.TEMP_CHUNK_DIR, uploadId);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    cb(null, sessionDir);
  },
  filename: (req, file, cb) => {
    const chunkIndex = parseInt(req.body.chunk_index || "0", 10);
    cb(null, `part_${chunkIndex}`);
  },
});

const uploadMiddleware = multer({
  storage: uploadStorage,
  limits: {
    fileSize: Math.floor(2.1 * 1024 * 1024 * 1024),
  },
});

const directUploadStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, config.TEMP_CHUNK_DIR);
  },
  filename: (req, file, cb) => {
    const unique = `direct_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`;
    cb(null, `${unique}_${Helpers.sanitizeFilename(file.originalname)}`);
  },
});

const directUploadMiddleware = multer({
  storage: directUploadStorage,
  limits: {
    fileSize: Math.floor(2.1 * 1024 * 1024 * 1024),
  },
});

const SAFE_ACTIONS = new Set([
  "auth.login",
  "auth.status",
  "system.status",
  "files.list",
  "folders.list",
  "files.download",
  "files.preview",
  "files.stream_preview",
  "files.upload_progress",
]);

async function handleAction(action, req, res) {
  try {

    if (!SAFE_ACTIONS.has(action)) {

      if (req.method === "GET" || req.method === "HEAD") {
        return Helpers.error(
          res,
          "Method not allowed for state-changing action.",
          405,
        );
      }

      if (action === "auth.logout" && (!req.session || !req.session.user)) {
        res.clearCookie("TELEDRIVE_SESSID");
        return Helpers.success(res, {}, "Logged out successfully.");
      }

      if (!AuthService.verifyCsrf(req)) {
        return Helpers.error(res, "Invalid or missing CSRF token.", 403);
      }
    }

    switch (action) {

      case "auth.login": {
        if (req.method !== "POST") {
          return Helpers.error(
            res,
            "Method not allowed for authentication.",
            405,
          );
        }
        const username = (req.body.username || "").trim();
        const password = (req.body.password || "").trim();
        const clientIp = req.ip || req.connection.remoteAddress || "unknown";

        if (!username || !password) {
          return Helpers.error(res, "Username and password are required.", 400);
        }

        const result = await AuthService.login(username, password, clientIp);
        if (result.locked) {
          return Helpers.error(
            res,
            `Too many failed attempts. Try again in ${result.remainingSecs} seconds.`,
            429,
          );
        }

        if (result.success) {
          req.session.user = username;
          const csrfToken = AuthService.getCsrfToken(req);
          return Helpers.success(
            res,
            {
              username,
              csrf_token: csrfToken,
            },
            "Login successful.",
          );
        }

        return Helpers.error(res, "Invalid credentials.", 401);
      }

      case "auth.logout": {
        if (req.session) {
          req.session.destroy(() => {
            res.clearCookie("TELEDRIVE_SESSID");
            return Helpers.success(res, {}, "Logged out successfully.");
          });
        } else {
          res.clearCookie("TELEDRIVE_SESSID");
          return Helpers.success(res, {}, "Logged out successfully.");
        }
        return;
      }

      case "auth.status": {
        const authenticated = Boolean(req.session && req.session.user);
        const payload = { authenticated };
        if (authenticated) {
          payload.user = req.session.user;
          payload.csrf_token = AuthService.getCsrfToken(req);
        }
        return Helpers.success(res, payload);
      }

      case "system.status": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        return Helpers.success(res, {
          configured: storageEngine.isConfigured(),
          mtproto_connected: telegramService.isConnected,
          api_id_set: Boolean(config.API_ID),
          session_set: Boolean(config.STRING_SESSION),
          storage_channel: config.STORAGE_CHANNEL_ID || "Not set",
          index_channel: config.INDEX_CHANNEL_ID || "Not set",
          engine_version: config.ENGINE_VERSION,
          node_version: process.version,
          max_part_size: Helpers.formatBytes(config.PART_SIZE_LIMIT),
        });
      }

      case "files.list": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        const parentId = req.query.parent_id || "root";
        const search = (req.query.search || "").trim().toLowerCase();
        const forceRefresh = Boolean(
          req.query.refresh || req.query.force_remote,
        );

        const data = await storageEngine.getFileSystemIndex(forceRefresh);
        const allItems = Object.values(data.items || {});

        let filtered = [];
        if (search) {
          filtered = allItems.filter((it) =>
            (it.name || "").toLowerCase().includes(search),
          );
        } else {
          filtered = allItems.filter(
            (it) => (it.parent_id || "root") === parentId,
          );
        }

        filtered.sort((a, b) => {
          if (a.type === b.type) {
            return (a.name || "").localeCompare(b.name || "");
          }
          return a.type === "folder" ? -1 : 1;
        });

        return Helpers.success(res, {
          current_folder_id: parentId,
          items: filtered,
          total_count: filtered.length,
        });
      }

      case "files.direct_upload": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        const file = req.file;
        if (!file) {
          return Helpers.error(res, "No file received for direct upload.", 400);
        }

        const uploadId = (req.body.upload_id || "").replace(/[^\w\-]/g, "");
        const filename = Helpers.sanitizeFilename(
          req.body.filename || file.originalname,
        );
        const parentId = req.body.parent_id || "root";
        const filePath = file.path;
        const fileSize = file.size;

        if (uploadId) {
          uploadProgressTracker.set(uploadId, {
            status: "uploading_telegram",
            percent: 0,
            loaded: 0,
            total: fileSize,
            startTime: Date.now(),
          });
        }

        let lastLoaded = 0;
        let lastTime = Date.now();

        try {

          const uploadRes = await telegramService.uploadFileToStorage(
            filePath,
            filename,
            `TeleDrive File: ${filename}`,
            (progress) => {
              if (uploadId) {
                const now = Date.now();
                const loaded = Math.round(progress * fileSize);
                const percent = Math.min(99, Math.round(progress * 100));
                const elapsed = (now - lastTime) / 1000;
                let speed = 0;
                if (elapsed > 0.3) {
                  speed = (loaded - lastLoaded) / elapsed;
                  lastLoaded = loaded;
                  lastTime = now;
                }
                uploadProgressTracker.set(uploadId, {
                  status: "uploading_telegram",
                  percent,
                  loaded,
                  total: fileSize,
                  speed,
                });
              }
            },
          );

          try {
            fs.unlinkSync(filePath);
          } catch (e) {}

          if (uploadId) {
            uploadProgressTracker.set(uploadId, {
              status: "indexing",
              percent: 99,
              loaded: fileSize,
              total: fileSize,
            });
          }

          const chunks = [
            {
              part: 1,
              message_id: uploadRes.message_id,
              file_id: uploadRes.file_id,
              size: uploadRes.file_size || fileSize,
            },
          ];

          const newEntry = await storageEngine.createFileEntry({
            name: filename,
            size: uploadRes.file_size || fileSize,
            mime_type: Helpers.getMimeType(filename),
            parent_id: parentId,
            chunks,
          });

          if (uploadId) {
            uploadProgressTracker.set(uploadId, {
              status: "completed",
              percent: 100,
              loaded: fileSize,
              total: fileSize,
              item: newEntry,
              needs_purge: Boolean(newEntry.needs_purge),
            });
            setTimeout(() => uploadProgressTracker.delete(uploadId), 30000);
          }

          return Helpers.success(
            res,
            {
              item: newEntry,
              folder: newEntry,
              needs_purge: Boolean(newEntry.needs_purge),
            },
            "File uploaded directly to Telegram Cloud successfully.",
          );
        } catch (uploadErr) {
          if (uploadId) uploadProgressTracker.delete(uploadId);
          try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          } catch (e) {}
          throw uploadErr;
        }
      }

      case "files.upload_progress": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        const uploadId = (
          req.query.upload_id ||
          req.body.upload_id ||
          ""
        ).replace(/[^\w\-]/g, "");
        const progress = uploadProgressTracker.get(uploadId) || {
          status: "idle",
          percent: 0,
          loaded: 0,
          total: 0,
        };
        return Helpers.success(res, { progress });
      }

      case "files.upload_chunk": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);

        const uploadId = (req.body.upload_id || "").replace(/[^\w\-]/g, "");
        const chunkIndex = parseInt(req.body.chunk_index || "0", 10);
        const totalChunks = parseInt(req.body.total_chunks || "1", 10);
        const filename = Helpers.sanitizeFilename(req.body.filename || "file");

        if (!uploadId) {
          return Helpers.error(res, "Invalid upload session ID.", 400);
        }

        const uploadSessionDir = path.join(config.TEMP_CHUNK_DIR, uploadId);
        const stateFile = path.join(uploadSessionDir, "session_state.json");
        const chunksFile = path.join(uploadSessionDir, "session_chunks.json");

        let state = { next_part_index: 0, batch_index: 1 };
        if (fs.existsSync(stateFile)) {
          try {
            state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
          } catch (e) {}
        }

        const batchThreshold =
          config.PART_SIZE_LIMIT || 1.9 * 1024 * 1024 * 1024;
        let nextPart = state.next_part_index || 0;
        let batchIdx = state.batch_index || 1;

        while (nextPart < totalChunks) {
          let accumulatedBytes = 0;
          let scanIdx = nextPart;
          const contiguousParts = [];

          while (scanIdx < totalChunks) {
            const pPath = path.join(uploadSessionDir, `part_${scanIdx}`);
            if (fs.existsSync(pPath)) {
              const pSize = fs.statSync(pPath).size;
              contiguousParts.push({
                index: scanIdx,
                path: pPath,
                size: pSize,
              });
              accumulatedBytes += pSize;
              scanIdx++;
              if (accumulatedBytes >= batchThreshold) break;
            } else {
              break;
            }
          }

          if (accumulatedBytes >= batchThreshold) {
            const batchFilename = `batch_${batchIdx}_${filename}`;
            const batchPath = path.join(uploadSessionDir, batchFilename);

            const outStream = fs.createWriteStream(batchPath, { flags: "w" });
            for (const part of contiguousParts) {
              if (fs.existsSync(part.path)) {
                await new Promise((resolve, reject) => {
                  const inStream = fs.createReadStream(part.path);
                  inStream.on("error", reject);
                  inStream.on("end", () => {
                    try {
                      fs.unlinkSync(part.path);
                    } catch (e) {}
                    resolve();
                  });
                  inStream.pipe(outStream, { end: false });
                });
              }
            }
            outStream.end();
            await new Promise((resolve, reject) => {
              outStream.on("finish", resolve);
              outStream.on("error", reject);
            });

            if (fs.existsSync(batchPath) && fs.statSync(batchPath).size > 0) {
              const uploadRes = await telegramService.uploadFileToStorage(
                batchPath,
                batchFilename,
                `TeleDrive File: ${filename} (Part ${batchIdx})`,
              );

              try {
                fs.unlinkSync(batchPath);
              } catch (e) {}

              let chunksList = [];
              if (fs.existsSync(chunksFile)) {
                try {
                  chunksList = JSON.parse(fs.readFileSync(chunksFile, "utf8"));
                } catch (e) {}
              }

              chunksList.push({
                part: batchIdx,
                message_id: uploadRes.message_id,
                file_id: uploadRes.file_id,
                size: uploadRes.file_size,
              });

              fs.writeFileSync(
                chunksFile,
                JSON.stringify(chunksList, null, 2),
                "utf8",
              );
            }

            nextPart = scanIdx;
            batchIdx += 1;
            state.next_part_index = nextPart;
            state.batch_index = batchIdx;
            fs.writeFileSync(stateFile, JSON.stringify(state), "utf8");
          } else {
            break;
          }
        }

        return Helpers.success(
          res,
          {
            chunk_index: chunkIndex,
            total_chunks: totalChunks,
            received: true,
          },
          "Chunk uploaded successfully.",
        );
      }

      case "files.complete_upload": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);

        const uploadId = (req.body.upload_id || "").replace(/[^\w\-]/g, "");
        const filename = Helpers.sanitizeFilename(req.body.filename || "file");
        const parentId = req.body.parent_id || "root";
        const fileSize = parseInt(req.body.size || "0", 10);
        const totalChunks = parseInt(req.body.total_chunks || "1", 10);

        if (!uploadId) {
          return Helpers.error(res, "Invalid upload session ID.", 400);
        }

        const uploadSessionDir = path.join(config.TEMP_CHUNK_DIR, uploadId);
        if (!fs.existsSync(uploadSessionDir)) {

          const currentProgress = uploadProgressTracker.get(uploadId);
          if (currentProgress && currentProgress.status === "completed") {
            return Helpers.success(
              res,
              {
                status: "completed",
                item: currentProgress.item,
                needs_purge: currentProgress.needs_purge,
              },
              "File uploaded and indexed successfully.",
            );
          }
          return Helpers.error(res, "Upload session directory not found.", 400);
        }

        const currentStatus = uploadProgressTracker.get(uploadId)?.status;
        if (
          currentStatus === "assembling" ||
          currentStatus === "uploading_telegram" ||
          currentStatus === "indexing"
        ) {
          return Helpers.success(
            res,
            {
              status: "processing",
              upload_id: uploadId,
            },
            "Upload is being processed in background.",
          );
        }

        uploadProgressTracker.set(uploadId, {
          status: "assembling",
          percent: 50,
          loaded: 0,
          total: fileSize,
          speed: 0,
        });

        Helpers.success(
          res,
          {
            status: "processing",
            upload_id: uploadId,
          },
          "Upload assembly and Telegram Cloud transfer started.",
        );

        (async () => {
          try {
            const stateFile = path.join(uploadSessionDir, "session_state.json");
            const chunksFile = path.join(
              uploadSessionDir,
              "session_chunks.json",
            );

            let state = { next_part_index: 0, batch_index: 1 };
            if (fs.existsSync(stateFile)) {
              try {
                state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
              } catch (e) {}
            }

            let nextPart = state.next_part_index || 0;
            let batchIdx = state.batch_index || 1;

            if (nextPart < totalChunks) {
              const tailFilename = `batch_${batchIdx}_${filename}`;
              const tailPath = path.join(uploadSessionDir, tailFilename);

              const outStream = fs.createWriteStream(tailPath, {
                flags: "w",
                highWaterMark: 1024 * 1024,
              });
              for (let i = nextPart; i < totalChunks; i++) {
                const pPath = path.join(uploadSessionDir, `part_${i}`);
                if (fs.existsSync(pPath)) {
                  await new Promise((resolve, reject) => {
                    const inStream = fs.createReadStream(pPath, {
                      highWaterMark: 1024 * 1024,
                    });
                    inStream.on("error", reject);
                    inStream.on("end", () => {
                      try {
                        fs.unlinkSync(pPath);
                      } catch (e) {}
                      resolve();
                    });
                    inStream.pipe(outStream, { end: false });
                  });
                }
              }
              outStream.end();
              await new Promise((resolve, reject) => {
                outStream.on("finish", resolve);
                outStream.on("error", reject);
              });

              if (fs.existsSync(tailPath) && fs.statSync(tailPath).size > 0) {
                const tailSize = fs.statSync(tailPath).size;
                uploadProgressTracker.set(uploadId, {
                  status: "uploading_telegram",
                  percent: 0,
                  loaded: 0,
                  total: tailSize,
                  speed: 0,
                });

                let lastLoaded = 0;
                let lastTime = Date.now();

                const uploadRes = await telegramService.uploadFileToStorage(
                  tailPath,
                  tailFilename,
                  `TeleDrive File: ${filename}` +
                    (batchIdx > 1 ? ` (Part ${batchIdx})` : ""),
                  (progress) => {
                    const loaded = Math.round(progress * tailSize);
                    const now = Date.now();
                    const percent = Math.min(99, Math.round(progress * 100));
                    const elapsed = (now - lastTime) / 1000;
                    let speed = 0;
                    if (elapsed > 0.3) {
                      speed = (loaded - lastLoaded) / elapsed;
                      lastLoaded = loaded;
                      lastTime = now;
                    }
                    uploadProgressTracker.set(uploadId, {
                      status: "uploading_telegram",
                      percent,
                      loaded,
                      total: tailSize,
                      speed,
                    });
                  },
                );

                try {
                  fs.unlinkSync(tailPath);
                } catch (e) {}

                let chunksList = [];
                if (fs.existsSync(chunksFile)) {
                  try {
                    chunksList = JSON.parse(
                      fs.readFileSync(chunksFile, "utf8"),
                    );
                  } catch (e) {}
                }

                chunksList.push({
                  part: batchIdx,
                  message_id: uploadRes.message_id,
                  file_id: uploadRes.file_id,
                  size: uploadRes.file_size || tailSize,
                });

                fs.writeFileSync(
                  chunksFile,
                  JSON.stringify(chunksList, null, 2),
                  "utf8",
                );
              }
            }

            let finalChunks = [];
            if (fs.existsSync(chunksFile)) {
              try {
                finalChunks = JSON.parse(fs.readFileSync(chunksFile, "utf8"));
              } catch (e) {}
            }

            Helpers.removeDir(uploadSessionDir);

            if (!finalChunks || finalChunks.length === 0) {
              uploadProgressTracker.set(uploadId, {
                status: "failed",
                error: "No chunks uploaded to Telegram Storage.",
              });
              return;
            }

            finalChunks.sort((a, b) => (a.part || 0) - (b.part || 0));

            let totalUploadedBytes = 0;
            finalChunks.forEach((c, idx) => {
              c.part = idx + 1;
              totalUploadedBytes += c.size || 0;
            });

            uploadProgressTracker.set(uploadId, {
              status: "indexing",
              percent: 99,
              loaded: totalUploadedBytes > 0 ? totalUploadedBytes : fileSize,
              total: totalUploadedBytes > 0 ? totalUploadedBytes : fileSize,
            });

            const newEntry = await storageEngine.createFileEntry({
              name: filename,
              size: totalUploadedBytes > 0 ? totalUploadedBytes : fileSize,
              mime_type: Helpers.getMimeType(filename),
              parent_id: parentId,
              chunks: finalChunks,
            });

            uploadProgressTracker.set(uploadId, {
              status: "completed",
              percent: 100,
              loaded: totalUploadedBytes > 0 ? totalUploadedBytes : fileSize,
              total: totalUploadedBytes > 0 ? totalUploadedBytes : fileSize,
              item: newEntry,
              needs_purge: Boolean(newEntry.needs_purge),
            });
            setTimeout(() => uploadProgressTracker.delete(uploadId), 60000);

            Helpers.cleanStaleUploadSessions(config.TEMP_CHUNK_DIR, 1800);
          } catch (bgErr) {
            console.error(
              `[CompleteUpload] Background upload failed for ${uploadId}:`,
              bgErr,
            );
            uploadProgressTracker.set(uploadId, {
              status: "failed",
              error:
                bgErr.message ||
                "Failed to complete upload to Telegram Storage.",
            });
            Helpers.removeDir(uploadSessionDir);
            setTimeout(() => uploadProgressTracker.delete(uploadId), 30000);
          }
        })();

        return;
      }

      case "files.cancel_upload": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        const uploadId = (req.body.upload_id || "").replace(/[^\w\-]/g, "");

        if (uploadId) {
          const uploadSessionDir = path.join(config.TEMP_CHUNK_DIR, uploadId);
          const chunksFile = path.join(uploadSessionDir, "session_chunks.json");

          if (fs.existsSync(chunksFile)) {
            try {
              const chunksList = JSON.parse(
                fs.readFileSync(chunksFile, "utf8"),
              );
              const msgIds = chunksList
                .map((c) => c.message_id)
                .filter(Boolean);
              if (msgIds.length > 0) {
                await telegramService.deleteMessages(
                  config.STORAGE_CHANNEL_ID,
                  msgIds,
                );
              }
            } catch (e) {}
          }
          Helpers.removeDir(uploadSessionDir);
        }

        return Helpers.success(res, {}, "Upload session cancelled.");
      }

      case "files.download":
      case "files.preview":
      case "files.stream_preview": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);

        const id = req.query.id || req.params.id || "";
        const index = await storageEngine.getFileSystemIndex();
        const target = index.items ? index.items[id] : null;

        if (
          !target ||
          target.type !== "file" ||
          !Array.isArray(target.chunks) ||
          target.chunks.length === 0
        ) {
          return Helpers.error(res, "File not found or has no chunks.", 404);
        }

        const isDownload = action === "files.download";
        const disposition = isDownload ? "attachment" : "inline";
        const safeFilename = Helpers.sanitizeFilename(target.name);
        const asciiFilename = safeFilename.replace(
          /["\\;\r\n\x00-\x1F\x7F]/g,
          "_",
        );
        const encodedFilename = encodeURIComponent(safeFilename);
        const mimeType = target.mime_type || Helpers.getMimeType(safeFilename);

        let totalSize = target.size || 0;
        if (!totalSize) {
          totalSize = target.chunks.reduce((acc, c) => acc + (c.size || 0), 0);
        }

        let currentOffset = 0;
        const chunkRanges = target.chunks.map((chunk) => {
          const chunkSize = chunk.size || 0;
          const chunkStart = currentOffset;
          const chunkEnd = currentOffset + chunkSize - 1;
          currentOffset += chunkSize;
          return {
            message_id: chunk.message_id,
            size: chunkSize,
            start: chunkStart,
            end: chunkEnd,
          };
        });

        if (totalSize === 0 && currentOffset > 0) {
          totalSize = currentOffset;
        }

        const rangeHeader = req.headers.range;
        let start = 0;
        let end = totalSize > 0 ? totalSize - 1 : 0;
        let isRangeRequest = false;

        if (rangeHeader && totalSize > 0) {
          const parts = rangeHeader.replace(/bytes=/, "").split("-");
          const partialStart = parseInt(parts[0], 10);
          const partialEnd = parseInt(parts[1], 10);

          if (!isNaN(partialStart)) {
            start = partialStart;
          }
          if (!isNaN(partialEnd)) {
            end = partialEnd;
          } else if (isNaN(partialStart) && !isNaN(partialEnd)) {
            start = Math.max(0, totalSize - partialEnd);
            end = totalSize - 1;
          }

          if (start >= totalSize || start < 0 || end < start) {
            res.setHeader("Content-Range", `bytes */${totalSize}`);
            return res.status(416).send("Requested Range Not Satisfiable");
          }

          end = Math.min(end, totalSize - 1);
          isRangeRequest = true;
        }

        const contentLength = end - start + 1;

        res.setHeader("Content-Type", mimeType);
        res.setHeader(
          "Content-Disposition",
          `${disposition}; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`,
        );
        res.setHeader("Cache-Control", "no-transform, private, max-age=3600");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("X-Content-Type-Options", "nosniff");

        if (isRangeRequest) {
          res.status(206);
          res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
          res.setHeader("Content-Length", contentLength);
        } else {
          res.status(200);
          if (totalSize > 0) {
            res.setHeader("Content-Length", totalSize);
          }
        }

        res.flushHeaders();

        const activeChunks = chunkRanges.filter(
          (c) => c.end >= start && c.start <= end,
        );
        const chunksToStream = activeChunks.map((c) => {
          const rangeStartInChunk = Math.max(0, start - c.start);
          const rangeEndInChunk = Math.min(c.size - 1, end - c.start);
          return {
            message_id: c.message_id,
            start: rangeStartInChunk,
            end: rangeEndInChunk,
            size: c.size,
          };
        });

        await telegramService.streamChunksToResponse(
          config.STORAGE_CHANNEL_ID,
          chunksToStream,
          res,
        );
        return res.end();
      }

      case "folder.create": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        const name = (req.body.name || "").trim();
        const parentId = req.body.parent_id || "root";

        if (!name) {
          return Helpers.error(res, "Folder name cannot be empty.", 400);
        }

        const folder = await storageEngine.createFolder(name, parentId);
        return Helpers.success(
          res,
          {
            folder,
            needs_purge: Boolean(folder.needs_purge),
          },
          "Folder created successfully.",
        );
      }

      case "items.rename": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        const id = req.body.id || "";
        const newName = (req.body.name || "").trim();

        if (!id || !newName) {
          return Helpers.error(res, "Item ID and new name are required.", 400);
        }

        const updated = await storageEngine.renameItem(id, newName);
        return Helpers.success(
          res,
          { item: updated },
          "Item renamed successfully.",
        );
      }

      case "items.move": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        const id = req.body.id || "";
        const destParentId = req.body.parent_id || "root";

        if (!id) {
          return Helpers.error(res, "Item ID is required for moving.", 400);
        }

        const moved = await storageEngine.moveItem(id, destParentId);
        return Helpers.success(
          res,
          { item: moved },
          "Item moved successfully.",
        );
      }

      case "folders.list": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        const index = await storageEngine.getFileSystemIndex();
        const folders = Object.values(index.items || {}).filter(
          (it) => it.type === "folder",
        );
        return Helpers.success(res, { folders });
      }

      case "items.delete": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        const id = req.body.id || "";

        if (!id) {
          return Helpers.error(res, "Item ID is required for deletion.", 400);
        }

        const result = await storageEngine.deleteItem(id);
        return Helpers.success(res, result, "Item deleted successfully.");
      }

      case "items.bulk_delete": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        let rawIds = req.body.ids;

        if (typeof rawIds === "string") {
          try {
            rawIds = JSON.parse(rawIds);
          } catch (e) {
            rawIds = rawIds.split(",").map((s) => s.trim());
          }
        }

        const ids = Array.isArray(rawIds) ? rawIds.filter(Boolean) : [];
        if (ids.length === 0) {
          return Helpers.error(
            res,
            "No item IDs provided for bulk deletion.",
            400,
          );
        }

        const result = await storageEngine.deleteItems(ids);
        return Helpers.success(
          res,
          result,
          `Successfully deleted ${result.deleted_count} item(s).`,
        );
      }

      case "system.purge_index_messages": {
        if (!req.session?.user) return Helpers.error(res, "Unauthorized.", 401);
        const result = await storageEngine.purgePendingIndexMessages();
        return Helpers.success(
          res,
          result,
          "Index messages purged successfully.",
        );
      }

      default:
        return Helpers.error(res, `Unknown action: ${action}`, 404);
    }
  } catch (err) {
    console.error(`API Error on action [${action}]:`, err);

    const isProd = process.env.NODE_ENV === "production";
    const clientMessage = isProd
      ? "An internal server error occurred. Please try again."
      : err.message || "Internal Server Error";
    return Helpers.error(res, clientMessage, 500);
  }
}

const formParser = multer().none();

router.post("/upload", directUploadMiddleware.single("file"), (req, res) => {
  return handleAction("files.direct_upload", req, res);
});

router.post("/upload_chunk", uploadMiddleware.single("chunk"), (req, res) => {
  return handleAction("files.upload_chunk", req, res);
});

router.all("/", (req, res, next) => {
  const contentType = req.headers["content-type"] || "";
  if (contentType.includes("multipart/form-data")) {
    const actionQuery = req.query.action || "";
    if (
      actionQuery === "files.direct_upload" ||
      actionQuery === "files.upload"
    ) {
      return directUploadMiddleware.single("file")(req, res, (err) => {
        if (err) return Helpers.error(res, err.message, 400);
        handleAction("files.direct_upload", req, res);
      });
    }
    if (actionQuery === "files.upload_chunk") {
      return uploadMiddleware.single("chunk")(req, res, (err) => {
        if (err) return Helpers.error(res, err.message, 400);
        handleAction("files.upload_chunk", req, res);
      });
    }
    return formParser(req, res, (err) => {
      if (err) return Helpers.error(res, err.message, 400);
      const action = req.query.action || req.body.action || "";
      if (action) {
        return handleAction(action, req, res);
      }
      return next();
    });
  }

  const action = req.query.action || req.body.action || "";
  if (action) {
    return handleAction(action, req, res);
  }
  return next();
});

router.get("/auth/status", (req, res) => handleAction("auth.status", req, res));
router.post("/auth/login", (req, res) => handleAction("auth.login", req, res));
router.post("/auth/logout", (req, res) =>
  handleAction("auth.logout", req, res),
);
router.get("/files", (req, res) => handleAction("files.list", req, res));
router.get("/folders", (req, res) => handleAction("folders.list", req, res));
router.post("/folders", (req, res) => handleAction("folder.create", req, res));
router.get("/download/:id", (req, res) =>
  handleAction("files.download", req, res),
);
router.get("/preview/:id", (req, res) =>
  handleAction("files.preview", req, res),
);

module.exports = router;
