import { Plugin, Notice, Events, setIcon, Platform } from "obsidian";
import { RemoteWebDAV } from "./fsWebdav";
import { LocalFS } from "./fsLocal";
import { DEFAULT_SETTINGS, PluginSettings, Entity, SyncDirection } from "./types";
import { WebDAVSettingTab } from "./settings";
import { performSync } from "./syncAlgorithm";
import { loadPrevSyncEntities, savePrevSyncEntities, setMetadata, clearPrevSyncEntities, getMetadata } from "./localdb";
import { encryptPassword, decryptPassword } from "./utils";
import { SyncView, SYNC_VIEW_TYPE } from "./syncView";
import { logger } from "./logger";

// Helper to access stat property on TAbstractFile
interface HasStat {
    stat: {
        mtime: number;
        size?: number;
        ctime?: number;
    };
}

export default class WebDAVSyncPlugin extends Plugin {
    settings: PluginSettings = DEFAULT_SETTINGS;
    syncInProgress = false;
    syncEvents!: Events;
    lastSyncedEntities: Map<string, Entity> | null = null; // key -> last synced entity (stores both local and remote metadata)
    private pendingPaths = new Set<string>(); // paths changed by the current sync
    private autoRunIntervalID: number | null = null; // store interval ID
    private syncOnSaveUnregister: (() => void)[] = [];
    private syncOnSaveTimeout: NodeJS.Timeout | null = null; // timer for sync-on-save
    lastSyncTime?: number;
    lastSyncChanges?: number;
    syncStatus: 'idle' | 'syncing' | 'success' | 'failed' = 'idle';
    lastError?: string;
    // Progress tracking for sync view
    syncProgressCurrent: number = 0;
    syncProgressTotal: number = 0;
    vaultName: string = "";

    async onload() {
        console.log("Loading ObsiDAV Sync plugin");

        this.vaultName = this.app.vault.getName();

        await this.loadSettings();

        // Check if remote config changed and reset sync state if needed
        await this.checkRemoteConfigChange();

        // Load previous sync state for this vault/profile into memory
        const vaultID = this.app.vault.getName();
        const profileID = "webdav-default";
        const prevEntities = await loadPrevSyncEntities(vaultID, profileID);
        this.lastSyncedEntities = new Map(prevEntities.map(e => [e.key, e]));
        logger.debug(`Loaded ${prevEntities.length} previous sync entities`);
        this.syncEvents = new Events();

        // Ribbon icon
        this.addRibbonIcon("cloud", "Sync with WebDAV", () => this.sync());

        // Command (keyboard shortcuts)
        this.addCommand({
            id: "sync-webdav",
            name: "Sync now",
            callback: () => this.sync(),
        });

        // Command: sync now (uses current settings)
        this.addCommand({
            id: "sync-webdav-current",
            name: "Sync now (current direction)",
            callback: () => this.sync(),
        });

        // Direction sync commands
        this.addCommand({
            id: "sync-webdav-bidirectional",
            name: "Sync now (bidirectional)",
            callback: () => this.syncWithDirection("bidirectional"),
        });

        this.addCommand({
            id: "sync-webdav-push",
            name: "Sync now (incremental push)",
            callback: () => this.syncWithDirection("incremental_push"),
        });

        this.addCommand({
            id: "sync-webdav-pull",
            name: "Sync now (incremental pull)",
            callback: () => this.syncWithDirection("incremental_pull"),
        });

        this.addCommand({
            id: "sync-webdav-push-delete",
            name: "Sync now (incremental push + delete)",
            callback: () => this.syncWithDirection("incremental_push_delete"),
        });

        this.addCommand({
            id: "sync-webdav-pull-delete",
            name: "Sync now (incremental pull + delete)",
            callback: () => this.syncWithDirection("incremental_pull_delete"),
        });

        // Status bar item
        const statusBarItem = this.addStatusBarItem();
        statusBarItem.addClass("mod-clickable");
        statusBarItem.onClickEvent(() => {
            this.activateView();
        });

        // Function to update status bar with icon and text
        const updateStatusBar = () => {
            statusBarItem.empty();
            setIcon(statusBarItem, "cloud");
            let text = "ObsiDAV Sync";
            if (this.syncStatus === 'syncing') {
                text = "Syncing...";
            } else if (this.syncStatus === 'failed') {
                text = "Sync failed";
            } else if (this.syncStatus === 'success') {
                text = "All synced";
            }
            statusBarItem.appendText(text);
        };
        updateStatusBar();

        // Register the custom view
        this.registerView( SYNC_VIEW_TYPE, (leaf) => new SyncView(leaf, this));
        // Ensure the view leaf exists so it appears in the right‑sidebar dropdown
        this.app.workspace.onLayoutReady(() => {
            if (!this.app.workspace.getLeavesOfType(SYNC_VIEW_TYPE).length) {
                const leaf = this.app.workspace.getRightLeaf(false);
                if (leaf) {
                    leaf.setViewState({ type: SYNC_VIEW_TYPE, active: false });
                }
            }
        });

        // Command to open sync view
        this.addCommand({
            id: "open-sync-view",
            name: "Open sync view",
            callback: () => {
                this.activateView();
            }
        });

        // Listen to sync status updates
        this.registerEvent(
            this.syncEvents.on("sync:status", updateStatusBar)
        );

        // Settings tab
        this.addSettingTab(new WebDAVSettingTab(this.app, this));

        // Auto sync interval
        if (this.settings.syncIntervalMinutes > 0) {
            const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
            this.autoRunIntervalID = window.setInterval(() => this.sync(), intervalMs);
            this.registerInterval(this.autoRunIntervalID); // still register for cleanup
        }

        // Sync on startup
        if (this.settings.syncOnStartup) {
            this.app.workspace.onLayoutReady(() => {
                this.sync();
            });
        }

        // Sync on file save – delay activation to avoid sync lot of things since obsidian is just initializing
        if (this.settings.syncOnSave) {
            this.app.workspace.onLayoutReady(() => {
                const delayMs = this.settings.startupDelaySeconds * 1000;
                if (delayMs > 0) {
                    setTimeout(() => {
                        logger.debug("Enabling sync-on-save event listeners");
                        this.setupSyncOnSave();
                    }, delayMs);
                } else {
                    logger.debug("Enabling sync-on-save event listeners immediately");
                    this.setupSyncOnSave();
                }
            });
        }
    }

    onunload() {
        if (this.syncOnSaveTimeout) {
            clearTimeout(this.syncOnSaveTimeout);
            this.syncOnSaveTimeout = null;
        }
        this.syncOnSaveUnregister.forEach(fn => fn());
        this.syncOnSaveUnregister = [];
        this.app.workspace.detachLeavesOfType(SYNC_VIEW_TYPE);
    }

    async loadSettings() {
        const data = await this.loadData();
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
        logger.setLevel(this.settings.logLevel);
        // Generate a persistent random ID for this vault if not present
        if (!this.settings.vaultRandomID) {
            this.settings.vaultRandomID = crypto.randomUUID();
            await this.saveSettings(); // Save immediately so it persists
        }
        // Handle password: if present, try to decrypt using the random ID.
        if (this.settings.webdav.password) {
            try {
                // Assume stored password is encrypted -– attempt decryption
                const plain = await decryptPassword(this.settings.webdav.password, this.settings.vaultRandomID);
                this.settings.webdav.password = plain;
            } catch (e) {
                // if decryption failed could be that the password is plaintext, if so, will be encrypted on next saveSettings().
                logger.debug("Password decryption failed, assuming plaintext", e);
            }
        }
    }

    async saveSettings() {
        // Create a deep copy to avoid modifying the in‑memory plaintext
        const settingsToSave = JSON.parse(JSON.stringify(this.settings));
        if (settingsToSave.webdav.password) {
            settingsToSave.webdav.password = await encryptPassword(settingsToSave.webdav.password, this.settings.vaultRandomID);
        }
        // In‑memory password remains plaintext for subsequent operations
        await this.saveData(settingsToSave);
        logger.setLevel(this.settings.logLevel);
        this.refreshDynamicFeatures();
    }

    private refreshDynamicFeatures() {
        // Re‑set up auto‑sync interval
        if (this.autoRunIntervalID) {
            window.clearInterval(this.autoRunIntervalID);
            this.autoRunIntervalID = null;
        }
        if (this.settings.syncIntervalMinutes > 0) {
            const intervalMs = this.settings.syncIntervalMinutes * 60 * 1000;
            this.autoRunIntervalID = window.setInterval(() => this.sync(), intervalMs);
            this.registerInterval(this.autoRunIntervalID); // still register for cleanup
        }
        this.setupSyncOnSave();
    }

    async sync() {
        if (this.syncInProgress) {
            new Notice("Sync already in progress");
            return;
        }
        this.syncInProgress = true;
        this.syncStatus = 'syncing';
        this.syncProgressCurrent = 0;
        this.syncProgressTotal = 0;
        this.syncEvents.trigger("sync:status");
        this.syncEvents.trigger("sync:progress"); // update view

        // Cancel any pending sync-on-save timer
        if (this.syncOnSaveTimeout) {
            logger.debug("Cancelling pending sync-on-save timer due to manual sync");
            clearTimeout(this.syncOnSaveTimeout);
            this.syncOnSaveTimeout = null;
        }

        // Clear pending paths from previous sync
        this.pendingPaths.clear();

        logger.debug("========== SYNC START ==========");
        const startTime = Date.now();

        try {
            new Notice("Starting WebDAV sync...");

            const vaultID = this.app.vault.getName();
            const profileID = "webdav-default";

            // Use the in-memory last synced map if available, otherwise load from DB
            const prevSyncMap = this.lastSyncedEntities || new Map();
            logger.debug(`Prev sync map size: ${prevSyncMap.size}`);

            const localFs = new LocalFS(
                this.app.vault,
                this.settings.syncConfigDir,
                this.settings.syncUnderscoreItems
            );

            const remoteFs = new RemoteWebDAV(
                this.settings.webdav,
                vaultID,
                this.settings.concurrency
            );

            await remoteFs.init();

            // Determine batch size based on platform
            const batchSize = Platform.isMobile ? 1 : 20;

            // Perform the three‑way sync and get the set of changed keys
            const { changedKeys, actionCount } = await performSync({
                local: localFs,
                remote: remoteFs,
                settings: this.settings,
                vaultID,
                profileID,
                prevSyncMap,
                onProgress: (msg) => logger.debug(msg),
                onProgressUpdate: (current, total) => {
                    this.syncProgressCurrent = current;
                    this.syncProgressTotal = total;
                    this.syncEvents.trigger("sync:progress");
                },
                remoteBaseCreated: remoteFs.wasRemoteBaseCreated,
                batchSize,
            });

            // Mark all changed keys as pending (so we ignore their events)
            changedKeys.forEach(key => this.pendingPaths.add(key));

            if (changedKeys.size > 0) {
                // After sync, we need to build the new previous sync state.
                // This merged state contains the remote metadata (ETag, mtimeSvr) for files that exist remotely,
                // and the local mtimeCli for files that exist locally.
                // Use async iteration to walk both sides without freezing the UI.
                const newLocal: Entity[] = [];
                for await (const entity of localFs.walk()) {
                    newLocal.push(entity);
                }
                const newRemote: Entity[] = [];
                for await (const entity of remoteFs.walk()) {
                    newRemote.push(entity);
                }

                const localMap = new Map(newLocal.map(e => [e.key, e]));
                const remoteMap = new Map(newRemote.map(e => [e.key, e]));
                const allKeysAfter = new Set([...localMap.keys(), ...remoteMap.keys()]);
                const newPrevEntities: Entity[] = [];

                for (const key of allKeysAfter) {
                    const localEnt = localMap.get(key);
                    const remoteEnt = remoteMap.get(key);
                    const newEntity: Entity = {
                        key: key,
                        keyRaw: key,
                        sizeRaw: localEnt?.sizeRaw ?? remoteEnt?.sizeRaw ?? 0,
                    };
                    if (remoteEnt) {
                        // Store remote metadata if available
                        newEntity.etag = remoteEnt.etag;
                        newEntity.mtimeSvr = remoteEnt.mtimeSvr;
                    }
                    if (localEnt) {
                        // Store local modification and creation time if the file exists locally
                        newEntity.mtimeCli = localEnt.mtimeCli;
                        newEntity.ctimeCli = localEnt.ctimeCli;
                        newEntity.size = localEnt.size;
                    }
                    // If the file only exists remotely, we intentionally leave mtimeCli undefined.
                    newPrevEntities.push(newEntity);
                }

                // Free large maps to help garbage collector
                localMap.clear();
                remoteMap.clear();

                await savePrevSyncEntities(vaultID, profileID, newPrevEntities);
                await setMetadata(vaultID, "lastSyncTime", Date.now());
                // Update in-memory cache with the merged entities
                this.lastSyncedEntities = new Map(newPrevEntities.map(e => [e.key, e]));
                new Notice(`Sync completed with ${actionCount} file(s) changed`);
                this.lastSyncChanges = actionCount;
            } else {
                new Notice("Sync completed (no changes)");
                logger.debug("No changes detected by sync algorithm");
                this.lastSyncChanges = 0;
            }
            this.lastSyncTime = Date.now();
            this.syncStatus = 'success';
            this.lastError = undefined;
            this.syncEvents.trigger("sync:status");
            this.syncEvents.trigger("sync:progress");
        } catch (err) {
            logger.error("Sync error:", err);
            const message = err instanceof Error ? err.message : String(err);
            new Notice(`Sync failed: ${message}`);
            this.syncStatus = 'failed';
            this.lastError = message;
            this.syncEvents.trigger("sync:status");
            this.syncEvents.trigger("sync:progress");
        } finally {
            const duration = Date.now() - startTime;
            logger.debug(`========== SYNC END (duration: ${duration}ms) ==========`);
            this.syncInProgress = false;
            // Clear pending paths after a short delay to catch any remaining events
            setTimeout(() => this.pendingPaths.clear(), 3000);
        }
    }

    async syncWithDirection(direction: SyncDirection) {
        const originalDirection = this.settings.syncDirection;
        this.settings.syncDirection = direction;
        await this.sync();
        this.settings.syncDirection = originalDirection;
        await this.saveSettings(); // optional – saves the original direction back
    }

    async activateView() {
        const { workspace } = this.app;

        // Mobile: reveal or create the view (opens slide‑over panel)
        if (Platform.isMobile) {
            const leaf = workspace.getLeavesOfType(SYNC_VIEW_TYPE)[0];
            if (!leaf) {
                const newLeaf = workspace.getRightLeaf(false) || workspace.getLeaf('tab');
                await newLeaf.setViewState({ type: SYNC_VIEW_TYPE, active: true });
            } else {
                workspace.revealLeaf(leaf);
            }
            return;
        }

        // Desktop: toggle right sidebar
        const rightSplit = workspace.rightSplit;
        if (rightSplit.collapsed) {
            // Expand and show our view
            rightSplit.expand();
            const leaf = workspace.getLeavesOfType(SYNC_VIEW_TYPE)[0];
            if (!leaf) {
                const newLeaf = workspace.getRightLeaf(false);
                if (newLeaf) {
                    await newLeaf.setViewState({ type: SYNC_VIEW_TYPE, active: true });
                }
            } else {
                workspace.revealLeaf(leaf);
            }
        } else {
            // Collapse the sidebar (close it)
            rightSplit.collapse();
        }
    }

    /**
     * Clears the IndexedDB sync database and resets in‑memory state.
     * Use with caution – this forces a fresh sync on next run.
     */
    async clearSyncDB() {
        const vaultID = this.app.vault.getName();
        const profileID = "webdav-default";
        try {
            await clearPrevSyncEntities(vaultID, profileID);
            await setMetadata(vaultID, "lastSyncTime", null);
            this.lastSyncedEntities = null;
            logger.debug("Sync database cleared.");
        } catch (err) {
            logger.error("Failed to clear sync DB:", err);
            new Notice("Error clearing database. See console.");
        }
    }

    /**
     * Checks if the remote configuration (server URL + base directory) has changed.
     * If it has, the sync history is cleared to prevent accidental deletions.
     */
    private async checkRemoteConfigChange() {
        if (this.syncInProgress) {
            logger.debug("Sync in progress, skipping remote config change check");
            return;
        }
        const vaultID = this.app.vault.getName();
        const currentConfig = `${this.settings.webdav.address}|${this.settings.webdav.remoteBaseDir || ''}`;
        const storedHash = await getMetadata<string>(vaultID, "remoteConfigHash");
        if (storedHash && storedHash !== currentConfig) {
            logger.debug("Remote configuration changed, clearing sync history");
            await this.clearSyncDB();
            new Notice("Remote configuration changed. Sync history reset to prevent accidental deletions.");
            // Save new hash
            await setMetadata(vaultID, "remoteConfigHash", currentConfig);
        } else if (!storedHash) {
            // First time, save hash
            await setMetadata(vaultID, "remoteConfigHash", currentConfig);
        }
    }

    private setupSyncOnSave() {
        if (!this.settings.syncOnSave) return;

        // Unregister any previous listeners
        this.syncOnSaveUnregister.forEach(fn => fn());
        this.syncOnSaveUnregister = [];

        const debounceMs = 3000; // 3 seconds

        const hasFileChanged = (filePath: string): boolean => {
            const file = this.app.vault.getAbstractFileByPath(filePath);
            if (!file) {
                logger.debug(`hasFileChanged: file not found: ${filePath}`);
                return false;
            }

            const currentStat = (file as unknown as HasStat).stat;
            const lastSynced = this.lastSyncedEntities?.get(filePath);

            logger.debug(`Checking file: ${filePath}`);
            logger.debug(`  Current mtime: ${currentStat.mtime}, size: ${currentStat.size}`);
            if (lastSynced) {
                logger.debug(`  Last synced mtime: ${lastSynced.mtimeCli}, size: ${lastSynced.size}`);
                const changed = lastSynced.mtimeCli !== currentStat.mtime || lastSynced.size !== currentStat.size;
                logger.debug(`  Changed: ${changed}`);
                return changed;
            } else {
                logger.debug(`  No last synced record (new file)`);
                return true;
            }
        };

        const scheduleSync = () => {
            if (this.syncInProgress || !this.settings.syncOnSave) {
                logger.debug("Sync in progress or sync-on-save disabled, ignoring schedule");
                return;
            }
            logger.debug("Scheduling sync in", debounceMs, "ms");
            if (this.syncOnSaveTimeout) clearTimeout(this.syncOnSaveTimeout);
            this.syncOnSaveTimeout = setTimeout(() => {
                logger.debug("Executing scheduled sync");
                this.sync();
            }, debounceMs);
        };

        // Modify event
        const modifyRef = this.app.vault.on("modify", (file) => {
            const path = file.path;
            if (this.pendingPaths.has(path)) {
                logger.debug(`Modify event for ${path} ignored (pending)`);
                this.pendingPaths.delete(path);
                return;
            }
            logger.debug(`Modify event for: ${path}`);
            if (hasFileChanged(path)) {
                scheduleSync();
            } else {
                logger.debug("Modify ignored: file unchanged according to last sync");
            }
        });
        this.syncOnSaveUnregister.push(() => this.app.vault.offref(modifyRef));
        this.registerEvent(modifyRef);

        // Create event
        const createRef = this.app.vault.on("create", (file) => {
            const path = file.path;
            const likelyFolder = path.endsWith("/") ? path : path + "/";
            if (this.pendingPaths.has(path) || this.pendingPaths.has(likelyFolder)) {
                logger.debug(`Create event for ${path} ignored (pending)`);
                this.pendingPaths.delete(path);
                this.pendingPaths.delete(likelyFolder);
                return;
            }
            logger.debug(`Create event for: ${path}`);
            scheduleSync();
        });
        this.syncOnSaveUnregister.push(() => this.app.vault.offref(createRef));
        this.registerEvent(createRef);

        // Delete event
        const deleteRef = this.app.vault.on("delete", (file) => {
            const path = file.path;
            const keyWithSlash = path.endsWith("/") ? path : path + "/";
            if (this.pendingPaths.has(path) || this.pendingPaths.has(keyWithSlash)) {
                logger.debug(`Delete event for ${path} ignored (pending)`);
                this.pendingPaths.delete(path);
                this.pendingPaths.delete(keyWithSlash);
                return;
            }
            logger.debug(`Delete event for: ${path}`);
            scheduleSync();
        });
        this.syncOnSaveUnregister.push(() => this.app.vault.offref(deleteRef));
        this.registerEvent(deleteRef);

        // Rename event
        const renameRef = this.app.vault.on("rename", (file, oldPath) => {
            const newPath = file.path;
            const oldWithSlash = oldPath.endsWith("/") ? oldPath : oldPath + "/";
            const newWithSlash = newPath.endsWith("/") ? newPath : newPath + "/";
            if (this.pendingPaths.has(oldPath) || this.pendingPaths.has(newPath) ||
                this.pendingPaths.has(oldWithSlash) || this.pendingPaths.has(newWithSlash)) {
                logger.debug(`Rename event ignored (pending)`);
                this.pendingPaths.delete(oldPath);
                this.pendingPaths.delete(newPath);
                this.pendingPaths.delete(oldWithSlash);
                this.pendingPaths.delete(newWithSlash);
                return;
            }
            logger.debug(`Rename event: ${oldPath} -> ${newPath}`);
            scheduleSync();
        });
        this.syncOnSaveUnregister.push(() => this.app.vault.offref(renameRef));
        this.registerEvent(renameRef);

        logger.debug("Sync-on-save event listeners enabled");
    }
}