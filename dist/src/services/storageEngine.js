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

    getCachePath() {
        return config.CACHE_FILE;
    }

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

            const channelMessages = await telegramService.getMessages(this.indexChannel, {
                limit: 100,
            });

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

            const hasDataInChannel = manifestFound || Object.keys(items).length > 0;

            if (!hasDataInChannel) {

                console.log('🚀 Index channel is completely empty. Creating and pinning empty manifest...');
                try {
                    pinnedMsgId = await this.rebuildAndPinManifest({}, 0);
                    items = {};
                    deltaCount = 0;
                } catch (pinErr) {
                    console.warn('Notice: Could not pin empty bootstrap manifest:', pinErr.message);
                }
            } else {

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

        const index = await this.getFileSystemIndex();
        index.items[id] = entry;
        index.delta_count = (index.delta_count || 0) + 1;
        index.total_items = Object.keys(index.items).length;

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

    async renameItem(id, newName) {
        const index = await this.getFileSystemIndex();
        const item = index.items[id];
        if (!item) {
            throw new Error(`Item ${id} not found.`);
        }

        const safeName = Helpers.sanitizeFilename(newName);
        item.name = safeName;
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

            const delta = { id, name: safeName, updated_at: item.updated_at };
            const sent = await telegramService.sendTextMessage(this.indexChannel, JSON.stringify(delta));
            item.index_message_id = sent.message_id;
            index.delta_count = (index.delta_count || 0) + 1;
        }

        this.writeLocalCache(index);
        return item;
    }

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

    async deleteItem(id) {
        return await this.deleteItems([id]);
    }

    async deleteItems(ids) {
        const index = await this.getFileSystemIndex();
        const items = index.items;
        const toDeleteIds = new Set();
        const storageMsgIdsToDelete = [];
        const indexMsgIdsToDelete = [];

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

        if (storageMsgIdsToDelete.length > 0) {
            try {
                await telegramService.deleteMessages(this.storageChannel, storageMsgIdsToDelete);
            } catch (err) {
                console.error('Failed to delete storage chunk messages:', err.message);
            }
        }

        for (const delId of toDeleteIds) {
            delete items[delId];
            const tombstone = { id: delId, deleted: true, updated_at: new Date().toISOString() };
            try {
                await telegramService.sendTextMessage(this.indexChannel, JSON.stringify(tombstone));
                index.delta_count = (index.delta_count || 0) + 1;
            } catch (e) {

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

        const uploaded = await telegramService.uploadDocumentBuffer(
            this.indexChannel,
            manifestBuffer,
            'master_manifest.json',
            `TeleDrive Master Manifest (Items: ${manifestObj.total_items})`
        );

        const newPinnedMsgId = uploaded.message_id;

        try {
            await this.purgeOldMessages(oldPinnedMsgId || 0, newPinnedMsgId);
        } catch (err) {
            console.error('Compaction purge error:', err.message);
        }

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

        const updatedIndex = {
            items: itemsMap,
            pinned_message_id: newPinnedMsgId,
            delta_count: 0,
            total_items: manifestObj.total_items,
        };
        this.writeLocalCache(updatedIndex);

        return newPinnedMsgId;
    }

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
