/**
 * TeleDrive Zero-Database Storage & Metadata Checkpointing Engine
 * 
 * Features:
 * 1. Auto-Bootstrap: Initializes and PINs master_manifest.json on fresh channel.
 * 2. Delta Streaming: Logs JSON metadata records to Index Channel for every CRUD action.
 * 3. 50-Message Compaction: Consolidates delta records, uploads new master_manifest.json,
 *    pins it, unpins old manifest, and purges previous deltas.
 * 4. Fast Local Caching: In-memory & disk caching ensures sub-millisecond API responses.
 * 5. Cascade Delete: Recursively removes all files and subfolders from Storage & Index channels.
 */

const fs = require('fs');
const path = require('path');
const config = require('../config');
const telegramService = require('./telegram');
const Helpers = require('../utils/helpers');

class StorageEngine {
    constructor() {
        this.indexChannel = config.INDEX_CHANNEL_ID;
        this.storageChannel = config.STORAGE_CHANNEL_ID;
        this.memoryCache = null;
        this.cacheTimestamp = 0;
    }

    isConfigured() {
        return config.isConfigured();
    }

    /**
     * Get local cache path
     */
    getCachePath() {
        return config.CACHE_FILE;
    }

    /**
     * Read from disk cache if valid
     */
    readLocalCache() {
        if (this.memoryCache && (Date.now() - this.cacheTimestamp < 30000)) {
            return this.memoryCache;
        }

        const cachePath = this.getCachePath();
        if (fs.existsSync(cachePath)) {
            try {
                const data = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
                if (data && typeof data === 'object' && data.items) {
                    this.memoryCache = data;
                    this.cacheTimestamp = Date.now();
                    return data;
                }
            } catch (err) {
                console.error('Failed to read local index cache:', err.message);
            }
        }
        return null;
    }

    /**
     * Save to local cache
     */
    writeLocalCache(indexData) {
        this.memoryCache = indexData;
        this.cacheTimestamp = Date.now();
        const cachePath = this.getCachePath();
        try {
            fs.writeFileSync(cachePath, JSON.stringify(indexData, null, 2), 'utf8');
        } catch (err) {
            console.error('Failed to write local index cache:', err.message);
        }
    }

    /**
     * Fetch complete filesystem index
     * Prioritizes local cache; falls back to pinned master_manifest.json + delta messages
     */
    async getFileSystemIndex(forceRemote = false) {
        if (!forceRemote) {
            const cached = this.readLocalCache();
            if (cached) {
                return cached;
            }
        }

        if (!this.isConfigured()) {
            return {
                items: {},
                pinned_message_id: 0,
                delta_count: 0,
                total_items: 0,
            };
        }

        let items = {};
        let pinnedMsgId = 0;
        let deltaCount = 0;
        let manifestFound = false;

        try {
            // 1. Fetch current pinned message from Telegram Index Channel
            const pinnedMessage = await telegramService.getPinnedMessage(this.indexChannel);
            if (pinnedMessage) {
                pinnedMsgId = pinnedMessage.id;
                if (pinnedMessage.media && pinnedMessage.media.document) {
                    try {
                        const manifestJson = await telegramService.downloadDocumentBuffer(
                            this.indexChannel,
                            pinnedMsgId
                        );
                        if (manifestJson) {
                            const manifestData = JSON.parse(manifestJson);
                            if (manifestData && Array.isArray(manifestData.items)) {
                                for (const it of manifestData.items) {
                                    items[it.id] = it;
                                }
                                deltaCount = parseInt(manifestData.delta_count || '0', 10);
                                manifestFound = true;
                            }
                        }
                    } catch (e) {
                        console.error('Failed to download pinned manifest document:', e.message);
                    }
                }
            }

            // 2. Fetch messages from the index channel to check for data and deltas
            const channelMessages = await telegramService.getMessages(this.indexChannel, {
                limit: 100,
            });

            // If no pinned manifest was found, check if an unpinned master_manifest.json document exists in channel
            if (!manifestFound && channelMessages && channelMessages.length > 0) {
                for (const msg of channelMessages) {
                    if (msg.media && msg.media.document) {
                        try {
                            const manifestJson = await telegramService.downloadDocumentBuffer(
                                this.indexChannel,
                                msg.id
                            );
                            if (manifestJson) {
                                const manifestData = JSON.parse(manifestJson);
                                if (manifestData && Array.isArray(manifestData.items)) {
                                    for (const it of manifestData.items) {
                                        items[it.id] = it;
                                    }
                                    deltaCount = parseInt(manifestData.delta_count || '0', 10);
                                    pinnedMsgId = msg.id;
                                    manifestFound = true;
                                    break;
                                }
                            }
                        } catch (e) {}
                    }
                }
            }

            // 3. Replay delta messages from channel
            if (channelMessages && channelMessages.length > 0) {
                const sortedMessages = [...channelMessages].sort((a, b) => a.id - b.id);
                for (const msg of sortedMessages) {
                    if (manifestFound && pinnedMsgId > 0 && msg.id <= pinnedMsgId) {
                        continue;
                    }

                    if (!msg.message || !msg.message.trim().startsWith('{')) {
                        continue;
                    }

                    try {
                        const delta = JSON.parse(msg.message.trim());
                        if (delta && delta.id) {
                            deltaCount += 1;
                            if (delta.deleted) {
                                delete items[delta.id];
                            } else {
                                items[delta.id] = {
                                    ...(items[delta.id] || {}),
                                    ...delta,
                                    index_message_id: msg.id,
                                };
                            }
                        }
                    } catch (err) {}
                }
            }

            // 4. Check if ANY data exists in the index channel:
            // Data exists if a manifest document exists, OR at least one file/folder delta exists
            const hasDataInChannel = manifestFound || Object.keys(items).length > 0;

            if (!hasDataInChannel) {
                // ONLY if the index channel is completely empty: create empty JSON document, upload it, and pin it
                console.log('🚀 Index channel is completely empty. Creating and pinning empty manifest...');
                try {
                    pinnedMsgId = await this.rebuildAndPinManifest({}, 0);
                    items = {};
                    deltaCount = 0;
                } catch (pinErr) {
                    console.warn('Notice: Could not pin empty bootstrap manifest:', pinErr.message);
                }
            } else {
                // If anything already exists in the channel, do NOT create or pin an empty JSON document.
                // Simply use the loaded data.
            }

            const result = {
                items,
                pinned_message_id: pinnedMsgId,
                delta_count: deltaCount,
                total_items: Object.keys(items).length,
            };

            this.writeLocalCache(result);
            return result;
        } catch (error) {
            console.error('Error fetching file system index:', error.message);
            const fallback = this.readLocalCache() || {
                items: {},
                pinned_message_id: 0,
                delta_count: 0,
                total_items: 0,
            };
            return fallback;
        }
    }

    /**
     * Create a file entry in Index Channel and update local cache
     */
    async createFileEntry(fileData) {
        const id = Helpers.generateId('file');
        const now = new Date().toISOString();

        const entry = {
            id,
            type: 'file',
            name: Helpers.sanitizeFilename(fileData.name),
            size: parseInt(fileData.size || 0, 10),
            mime_type: fileData.mime_type || Helpers.getMimeType(fileData.name),
            parent_id: fileData.parent_id || 'root',
            chunks: fileData.chunks || [],
            created_at: now,
            updated_at: now,
        };

        const jsonStr = JSON.stringify(entry);
        const sent = await telegramService.sendTextMessage(this.indexChannel, jsonStr);
        entry.index_message_id = sent.message_id;

        // Update local cache
        const index = await this.getFileSystemIndex();
        index.items[id] = entry;
        index.delta_count = (index.delta_count || 0) + 1;
        index.total_items = Object.keys(index.items).length;

        // Check compaction threshold
        let needsPurge = false;
        if (index.delta_count >= config.COMPACTION_THRESHOLD) {
            console.log(`📦 Delta count reached ${index.delta_count}. Running compaction cycle...`);
            try {
                await this.rebuildAndPinManifest(index.items, index.pinned_message_id);
                needsPurge = true;
            } catch (compactionErr) {
                console.error('Compaction failed during file entry creation:', compactionErr.message);
                this.writeLocalCache(index);
            }
        } else {
            this.writeLocalCache(index);
        }

        return {
            ...entry,
            needs_purge: needsPurge,
        };
    }

    /**
     * Create a folder entry in Index Channel
     */
    async createFolder(name, parentId = 'root') {
        const id = Helpers.generateId('folder');
        const now = new Date().toISOString();

        const entry = {
            id,
            type: 'folder',
            name: Helpers.sanitizeFilename(name),
            size: 0,
            parent_id: parentId || 'root',
            created_at: now,
            updated_at: now,
        };

        const jsonStr = JSON.stringify(entry);
        const sent = await telegramService.sendTextMessage(this.indexChannel, jsonStr);
        entry.index_message_id = sent.message_id;

        // Update local cache
        const index = await this.getFileSystemIndex();
        index.items[id] = entry;
        index.delta_count = (index.delta_count || 0) + 1;
        index.total_items = Object.keys(index.items).length;

        let needsPurge = false;
        if (index.delta_count >= config.COMPACTION_THRESHOLD) {
            try {
                await this.rebuildAndPinManifest(index.items, index.pinned_message_id);
                needsPurge = true;
            } catch (compactionErr) {
                console.error('Compaction failed during folder creation:', compactionErr.message);
                this.writeLocalCache(index);
            }
        } else {
            this.writeLocalCache(index);
        }

        return {
            ...entry,
            needs_purge: needsPurge,
        };
    }

    /**
     * Rename an item (file or folder)
     */
    async renameItem(id, newName) {
        const index = await this.getFileSystemIndex();
        const item = index.items[id];
        if (!item) {
            throw new Error(`Item ${id} not found.`);
        }

        const safeName = Helpers.sanitizeFilename(newName);
        item.name = safeName;
        item.updated_at = new Date().toISOString();

        // If it was an uncompacted delta with an index message, attempt in-place edit first
        let edited = false;
        if (item.index_message_id) {
            try {
                await telegramService.editMessage(
                    this.indexChannel,
                    item.index_message_id,
                    JSON.stringify(item)
                );
                edited = true;
            } catch (e) {
                edited = false;
            }
        }

        if (!edited) {
            // Append delta
            const delta = { id, name: safeName, updated_at: item.updated_at };
            const sent = await telegramService.sendTextMessage(this.indexChannel, JSON.stringify(delta));
            item.index_message_id = sent.message_id;
            index.delta_count = (index.delta_count || 0) + 1;
        }

        this.writeLocalCache(index);
        return item;
    }

    /**
     * Move an item to a new parent folder
     */
    async moveItem(id, destParentId = 'root') {
        const index = await this.getFileSystemIndex();
        const item = index.items[id];
        if (!item) {
            throw new Error(`Item ${id} not found.`);
        }

        if (destParentId !== 'root') {
            const dest = index.items[destParentId];
            if (!dest || dest.type !== 'folder') {
                throw new Error('Destination folder does not exist.');
            }
            // Prevent moving a folder inside itself
            if (id === destParentId) {
                throw new Error('Cannot move a folder into itself.');
            }
        }

        item.parent_id = destParentId;
        item.updated_at = new Date().toISOString();

        let edited = false;
        if (item.index_message_id) {
            try {
                await telegramService.editMessage(
                    this.indexChannel,
                    item.index_message_id,
                    JSON.stringify(item)
                );
                edited = true;
            } catch (e) {
                edited = false;
            }
        }

        if (!edited) {
            const delta = { id, parent_id: destParentId, updated_at: item.updated_at };
            const sent = await telegramService.sendTextMessage(this.indexChannel, JSON.stringify(delta));
            item.index_message_id = sent.message_id;
            index.delta_count = (index.delta_count || 0) + 1;
        }

        this.writeLocalCache(index);
        return item;
    }

    /**
     * Cascade delete an item (folder or file) and all nested descendants
     */
    async deleteItem(id) {
        return await this.deleteItems([id]);
    }

    /**
     * Bulk delete items
     */
    async deleteItems(ids) {
        const index = await this.getFileSystemIndex();
        const items = index.items;
        const toDeleteIds = new Set();
        const storageMsgIdsToDelete = [];
        const indexMsgIdsToDelete = [];

        // Helper to collect all descendants recursively
        function collect(itemId) {
            toDeleteIds.add(itemId);
            const target = items[itemId];
            if (target) {
                if (target.type === 'file' && Array.isArray(target.chunks)) {
                    for (const ch of target.chunks) {
                        if (ch.message_id) storageMsgIdsToDelete.push(ch.message_id);
                    }
                }
                if (target.index_message_id) {
                    indexMsgIdsToDelete.push(target.index_message_id);
                }
                // If folder, find children
                if (target.type === 'folder') {
                    for (const childId of Object.keys(items)) {
                        if (items[childId].parent_id === itemId) {
                            collect(childId);
                        }
                    }
                }
            }
        }

        for (const id of ids) {
            collect(id);
        }

        // Delete raw chunk files from Telegram Storage Channel
        if (storageMsgIdsToDelete.length > 0) {
            try {
                await telegramService.deleteMessages(this.storageChannel, storageMsgIdsToDelete);
            } catch (err) {
                console.error('Failed to delete storage chunk messages:', err.message);
            }
        }

        // Post tombstone deltas or remove index messages
        for (const delId of toDeleteIds) {
            delete items[delId];
            const tombstone = { id: delId, deleted: true, updated_at: new Date().toISOString() };
            try {
                await telegramService.sendTextMessage(this.indexChannel, JSON.stringify(tombstone));
                index.delta_count = (index.delta_count || 0) + 1;
            } catch (e) {
                // Ignore tombstone post failure
            }
        }

        index.total_items = Object.keys(items).length;

        let needsPurge = false;
        if (index.delta_count >= config.COMPACTION_THRESHOLD) {
            try {
                await this.rebuildAndPinManifest(items, index.pinned_message_id);
                needsPurge = true;
            } catch (compactionErr) {
                console.error('Compaction failed during item deletion:', compactionErr.message);
                this.writeLocalCache(index);
            }
        } else {
            this.writeLocalCache(index);
        }

        return {
            deleted_count: toDeleteIds.size,
            deleted_ids: Array.from(toDeleteIds),
            needs_purge: needsPurge,
        };
    }

    /**
     * Rebuild and PIN consolidated master_manifest.json document in Index Channel
     */
    async rebuildAndPinManifest(itemsMap, oldPinnedMsgId = 0) {
        const manifestObj = {
            version: config.VERSION,
            engine: 'TeleDrive MTProto Zero-DB',
            generated_at: new Date().toISOString(),
            total_items: Object.keys(itemsMap).length,
            delta_count: 0,
            items: Object.values(itemsMap),
        };

        const manifestBuffer = Buffer.from(JSON.stringify(manifestObj, null, 2), 'utf8');

        // 1. Upload new manifest document
        const uploaded = await telegramService.uploadDocumentBuffer(
            this.indexChannel,
            manifestBuffer,
            'master_manifest.json',
            `TeleDrive Master Manifest (Items: ${manifestObj.total_items})`
        );

        const newPinnedMsgId = uploaded.message_id;

        // 2. Purge old delta messages and old manifests before pinning the new one
        try {
            await this.purgeOldMessages(oldPinnedMsgId || 0, newPinnedMsgId);
        } catch (err) {
            console.error('Compaction purge error:', err.message);
        }

        // 3. PIN the new consolidated master manifest document (with verification and retries)
        let pinSuccess = false;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const res = await telegramService.pinMessage(this.indexChannel, newPinnedMsgId);
                if (res) {
                    console.log(`📌 Master manifest pinned successfully (ID: ${newPinnedMsgId}) on attempt ${attempt}`);
                    pinSuccess = true;
                    break;
                }
            } catch (err) {
                console.warn(`Warning: Pin attempt ${attempt} failed:`, err.message);
            }
            await new Promise((r) => setTimeout(r, 400));
        }

        if (!pinSuccess) {
            console.error(`❌ Could not pin new manifest message ID: ${newPinnedMsgId}`);
        }

        // Update local cache
        const updatedIndex = {
            items: itemsMap,
            pinned_message_id: newPinnedMsgId,
            delta_count: 0,
            total_items: manifestObj.total_items,
        };
        this.writeLocalCache(updatedIndex);

        return newPinnedMsgId;
    }

    /**
     * Purge all old messages between oldPinnedMsgId and newPinnedMsgId
     */
    async purgeOldMessages(startMsgId, endMsgId) {
        try {
            const queryOptions = {
                maxId: endMsgId,
                limit: 100,
            };
            if (startMsgId && startMsgId > 0) {
                queryOptions.minId = Math.max(0, startMsgId - 1);
            }

            const msgs = await telegramService.getMessages(this.indexChannel, queryOptions);

            if (msgs && msgs.length > 0) {
                const ids = msgs.map((m) => m.id).filter((id) => id !== endMsgId);
                if (ids.length > 0) {
                    await telegramService.deleteMessages(this.indexChannel, ids);
                }
            }
        } catch (err) {
            console.error('Purge error:', err.message);
        }
    }

    /**
     * Purge pending index messages manually triggered from UI
     */
    async purgePendingIndexMessages() {
        const index = await this.getFileSystemIndex(true);
        const newPin = await this.rebuildAndPinManifest(index.items, index.pinned_message_id);
        return {
            success: true,
            pinned_message_id: newPin,
        };
    }
}

module.exports = new StorageEngine();
