import { LocalFS } from "./fsLocal";
import { RemoteWebDAV } from "./fsWebdav";
import { Entity, PluginSettings } from "./types";
import { copyFileOrFolder } from "./copyLogic";
import { logger } from "./logger";

interface SyncContext {
    local: LocalFS;
    remote: RemoteWebDAV;
    settings: PluginSettings;
    vaultID: string;
    profileID: string;
    prevSyncMap: Map<string, Entity>; // previous sync state (stores remote metadata + last known local mtime)
    onProgress?: (msg: string) => void;
    onProgressUpdate?: (current: number, total: number) => void; // callback for progress count
    remoteBaseCreated?: boolean; // true if the remote base folder was just created in this sync
    batchSize?: number; // number of actions to process before yielding
}

interface PendingAction {
    key: string;
    type: 'upload' | 'download' | 'deleteLocal' | 'deleteRemote' | 'rename' | 'move';
    newKey?: string;
    isFolder?: boolean;
}

/**
 * Below is the main sync function, it returns a set of keys that were changed (uploaded/downloaded/deleted).
 * While respecting the syncDirection settings:
 * - bidirectional: all operations allowed
 * - incremental_push: uploads only, no downloads, no deletions
 * - incremental_pull: downloads only, no uploads, no deletions
 * - incremental_push_delete: uploads + delete remote when local deleted
 * - incremental_pull_delete: downloads + delete local when remote deleted
 * 
 * Also respects abortPercentage: if the estimated number of changed files exceeds the threshold,
 * the sync aborts before modifications are made.
 */
export async function performSync(context: SyncContext): Promise<{ changedKeys: Set<string>; actionCount: number }> {
    const { local, remote, settings, prevSyncMap, onProgress, onProgressUpdate } = context;
    const changedKeys = new Set<string>();

    // -----------------------------------------------------------------
    // 1. Gather current local and remote entities using incremental walking
    // -----------------------------------------------------------------
    onProgress?.("Listing local files...");
    const localMap = new Map<string, Entity>();
    for await (const entity of local.walk()) {
        localMap.set(entity.key, entity);
    }

    onProgress?.("Listing remote files...");
    const remoteMap = new Map<string, Entity>();
    for await (const entity of remote.walk()) {
        remoteMap.set(entity.key, entity);
    }

    const allKeys = new Set([...localMap.keys(), ...remoteMap.keys(), ...prevSyncMap.keys()]);

    // Helper to check if a file exceeds the configured size limit
    const isFileTooLarge = (sizeInBytes: number | undefined): boolean => {
        if (settings.maxFileSizeMB <= 0) return false; // 0 means no limit
        const size = sizeInBytes || 0;
        const maxBytes = settings.maxFileSizeMB * 1024 * 1024;
        return size > maxBytes;
    };

    // Initialize actions array (will be populated in two passes)
    const actions: PendingAction[] = [];

    // -----------------------------------------------------------------
    // 2. DETECT MOVES (local renames/moves) using creation time (ctime) and size
    // -----------------------------------------------------------------
    const movedPairs: { from: string; to: string }[] = [];
    const processedKeys = new Set<string>();

    // Collect keys that were in prevSync but are now missing locally
    const missingLocalKeys = new Set<string>();
    for (const [key, prev] of prevSyncMap) {
        if (!localMap.has(key) && prev.ctimeCli) {
            missingLocalKeys.add(key);
        }
    }

    // Collect new local keys not in prevSync
    const newLocalKeys = new Set<string>();
    for (const key of localMap.keys()) {
        if (!prevSyncMap.has(key)) {
            newLocalKeys.add(key);
        }
    }

    // Try to match missing local files with new local files by ctime and size
    for (const oldKey of missingLocalKeys) {
        const oldEnt = prevSyncMap.get(oldKey)!;
        for (const newKey of newLocalKeys) {
            const newEnt = localMap.get(newKey)!;
            // Compare creation time and size (if both have size info) to increase confidence
            if (oldEnt.ctimeCli && newEnt.ctimeCli && oldEnt.ctimeCli === newEnt.ctimeCli) {
                // If sizes are available and differ, it's probably not a move (content changed)
                if (oldEnt.size !== undefined && newEnt.size !== undefined && oldEnt.size !== newEnt.size) {
                    continue;
                }
                // Same creation time and (if sizes known) same size -> likely a move/rename
                movedPairs.push({ from: oldKey, to: newKey });
                processedKeys.add(oldKey);
                processedKeys.add(newKey);
                break;
            }
        }
    }

    // Add move actions to the list
    for (const { from, to } of movedPairs) {
        actions.push({ type: 'move', key: from, newKey: to, isFolder: from.endsWith('/') });
    }

    // -----------------------------------------------------------------
    // 3. ESTIMATION PASS – decide remaining actions without modifying anything
    // -----------------------------------------------------------------
    const remoteChanged = (remoteEnt: Entity | undefined, prevEnt: Entity | undefined): boolean => {
        if (!remoteEnt) return false;
        if (!prevEnt) return true; // no previous record means it's new
        return remoteEnt.etag !== prevEnt.etag;
    };

    const localChanged = (localEnt: Entity | undefined, prevEnt: Entity | undefined): boolean => {
        if (!localEnt) return false;
        if (!prevEnt) return true; // no previous record means it's new
        return localEnt.mtimeCli !== prevEnt.mtimeCli;
    };

    const dir = settings.syncDirection;

    for (const key of allKeys) {
        if (settings.ignorePaths.some(p => key.startsWith(p))) continue;
        if (processedKeys.has(key)) continue;

        const localEnt = localMap.get(key);
        const remoteEnt = remoteMap.get(key);
        const prevEnt = prevSyncMap.get(key);

        const isFolder = key.endsWith("/");
        const L = !!localEnt;
        const R = !!remoteEnt;
        const P = !!prevEnt;

        // Case: both sides exist
        if (L && R) {
            if (isFolder) continue; // folders always considered equal

            const remoteChg = remoteChanged(remoteEnt, prevEnt);
            const localChg = localChanged(localEnt, prevEnt);

            if (!remoteChg && !localChg) continue;

            if (remoteChg && !localChg) {
                // Remote changed, local unchanged - download
                if (dir === "bidirectional" || dir === "incremental_pull" || dir === "incremental_pull_delete") {
                    if (isFileTooLarge(remoteEnt?.size)) {
                        onProgress?.(`Skipping large file (download): ${key}`);
                    } else {
                        actions.push({ type: 'download', key, isFolder });
                    }
                } else {
                    onProgress?.(`Remote changed ignored (push mode): ${key}`);
                }
            } else if (localChg && !remoteChg) {
                // Local changed, remote unchanged - upload
                if (dir === "bidirectional" || dir === "incremental_push" || dir === "incremental_push_delete") {
                    if (isFileTooLarge(localEnt?.size)) {
                        onProgress?.(`Skipping large file (upload): ${key}`);
                    } else {
                        actions.push({ type: 'upload', key, isFolder });
                    }
                } else {
                    onProgress?.(`Local changed ignored (pull mode): ${key}`);
                }
            } else {
                // Both changed – conflict
                let shouldUpload = false, shouldDownload = false;
                switch (settings.conflictResolution) {
                    case "keepNewer": {
                        const localTime = localEnt!.mtimeCli || 0;
                        const remoteTime = remoteEnt!.mtimeSvr || 0;
                        if (localTime > remoteTime) shouldUpload = true;
                        else shouldDownload = true;
                        break;
                    }
                    case "keepLarger": {
                        const localSize = localEnt!.size || 0;
                        const remoteSize = remoteEnt!.size || 0;
                        if (localSize > remoteSize) shouldUpload = true;
                        else shouldDownload = true;
                        break;
                    }
                    case "smart": {
                        const newKey = key.replace(/(\.[^/.]+)?$/, "-conflict$1");
                        actions.push({ type: 'rename', key, newKey });
                        // After rename, will download the original from remote webdav (if allowed)
                        if (dir === "bidirectional" || dir === "incremental_pull" || dir === "incremental_pull_delete") {
                            if (isFileTooLarge(remoteEnt?.size)) {
                                onProgress?.(`Skipping large file (download after rename): ${key}`);
                            } else {
                                actions.push({ type: 'download', key, isFolder });
                            }
                        }
                        break;
                    }
                }
                if (shouldUpload) {
                    if (dir === "bidirectional" || dir === "incremental_push" || dir === "incremental_push_delete") {
                        if (isFileTooLarge(localEnt?.size)) {
                            onProgress?.(`Skipping large file (upload conflict): ${key}`);
                        } else {
                            actions.push({ type: 'upload', key, isFolder });
                        }
                    } else {
                        onProgress?.(`Conflict ignored (pull mode): ${key}`);
                    }
                } else if (shouldDownload) {
                    if (dir === "bidirectional" || dir === "incremental_pull" || dir === "incremental_pull_delete") {
                        if (isFileTooLarge(remoteEnt?.size)) {
                            onProgress?.(`Skipping large file (download conflict): ${key}`);
                        } else {
                            actions.push({ type: 'download', key, isFolder });
                        }
                    } else {
                        onProgress?.(`Conflict ignored (push mode): ${key}`);
                    }
                }
            }
        }
        // Case: only on local
        else if (L && !R) {
            if (!P) {
                // New local file/folder
                if (dir === "bidirectional" || dir === "incremental_push" || dir === "incremental_push_delete") {
                    if (isFolder || !isFileTooLarge(localEnt?.size)) {
                        onProgress?.(`New local folder detected: ${key}`);
                        actions.push({ type: 'upload', key, isFolder });
                    } else {
                        onProgress?.(`Skipping large file (upload): ${key}`);
                    }
                } else {
                    onProgress?.(`New local ignored (pull mode): ${key}`);
                }
            } else {
                // Previously existed, now missing on remote
                if (context.remoteBaseCreated) {
                    // Remote base was just created – upload instead of delete
                    if (dir === "bidirectional" || dir === "incremental_push" || dir === "incremental_push_delete") {
                        if (isFolder || !isFileTooLarge(localEnt?.size)) {
                            onProgress?.(`Remote base new, uploading folder: ${key}`);
                            actions.push({ type: 'upload', key, isFolder });
                        } else {
                            onProgress?.(`Skipping large file (upload after base creation): ${key}`);
                        }
                    } else {
                        onProgress?.(`Remote base new, upload ignored (pull mode): ${key}`);
                    }
                } else {
                    // Normal case: remote was deleted → delete local file
                    if (dir === "bidirectional" || dir === "incremental_push_delete") {
                        actions.push({ type: 'deleteLocal', key, isFolder });
                    } else {
                        onProgress?.(`Remote deleted ignored (non‑delete mode): ${key}`);
                    }
                }
            }
        }
        // Case: only on remote
        else if (!L && R) {
            if (!P) {
                // New remote file/folder
                if (dir === "bidirectional" || dir === "incremental_pull" || dir === "incremental_pull_delete") {
                    if (isFolder || !isFileTooLarge(remoteEnt?.size)) {
                        actions.push({ type: 'download', key, isFolder });
                    } else {
                        onProgress?.(`Skipping large file (download): ${key}`);
                    }
                } else {
                    onProgress?.(`New remote ignored (push mode): ${key}`);
                }
            } else {
                // Previously existed, now missing on local -> local was deleted -> delete remote file
                if (dir === "bidirectional" || dir === "incremental_pull_delete") {
                    actions.push({ type: 'deleteRemote', key, isFolder });
                } else {
                    onProgress?.(`Local deleted ignored (non delete mode): ${key}`);
                }
            }
        }
        // if neither side exists but previously existed - do nothing :p
    }

    // -----------------------------------------------------------------
    // 4. SORT ACTIONS – folders first
    // -----------------------------------------------------------------
    actions.sort((a, b) => {
        if (a.isFolder && !b.isFolder) return -1;
        if (!a.isFolder && b.isFolder) return 1;
        return 0;
    });

    // -----------------------------------------------------------------
    // 5. ABORT CHECK – if estimated changes exceed configured percentage
    // -----------------------------------------------------------------
    // Count only file actions (not folders)
    const fileActions = actions.filter(a => !a.isFolder).length;
    const totalFiles = [...allKeys].filter(key => !key.endsWith('/')).length;

    if (totalFiles > 0 && settings.abortPercentage < 100) {
        const percent = (fileActions / totalFiles) * 100;
        if (percent > settings.abortPercentage) {
            const msg = `Abort: ${fileActions} of ${totalFiles} files would change (${percent.toFixed(1)}% > ${settings.abortPercentage}%)`;
            onProgress?.(msg);
            logger.warn(msg);
            throw new Error(msg);
        }
    } else if (totalFiles === 0 && fileActions > 0) {
        // No files exist but we have file actions? That shouldn't happen, but log a warning.
        logger.warn(`Abort check: Files=0 but Folders=${fileActions} –- skipping abort check.`);
    }

    // -----------------------------------------------------------------
    // 6. EXECUTION PASS – apply all pending actions with progress updates
    // -----------------------------------------------------------------
    const batchSize = context.batchSize || 20; // default if not provided

    // Report initial progress with total count
    onProgressUpdate?.(0, actions.length);

    // Helper to process a single action
    const processAction = async (act: PendingAction): Promise<void> => {
        switch (act.type) {
            case 'upload':
                onProgress?.(`Uploading: ${act.key}`);
                if (act.isFolder) await remote.mkdir(act.key);
                else await copyFileOrFolder(act.key, local, remote);
                changedKeys.add(act.key);
                break;
            case 'download':
                onProgress?.(`Downloading: ${act.key}`);
                if (act.isFolder) await local.mkdir(act.key);
                else await copyFileOrFolder(act.key, remote, local);
                changedKeys.add(act.key);
                break;
            case 'deleteLocal':
                onProgress?.(`Deleting local: ${act.key}`);
                await local.rm(act.key, settings.deleteToWhere);
                changedKeys.add(act.key);
                break;
            case 'deleteRemote':
                onProgress?.(`Deleting remote: ${act.key}`);
                await remote.rm(act.key);
                changedKeys.add(act.key);
                break;
            case 'rename':
                onProgress?.(`Renaming local: ${act.key} -> ${act.newKey}`);
                await local.rename(act.key, act.newKey!);
                changedKeys.add(act.key);
                changedKeys.add(act.newKey!);
                break;
            case 'move':
                onProgress?.(`Moving remote: ${act.key} -> ${act.newKey}`);
                try {
                    await remote.rename(act.key, act.newKey!);
                    changedKeys.add(act.key);
                    changedKeys.add(act.newKey!);
                } catch (err) {
                    logger.error(`Move failed, falling back to delete+upload for ${act.key}`, err);
                    // Fallback: delete remote old, upload new local
                    await remote.rm(act.key);
                    await copyFileOrFolder(act.newKey!, local, remote);
                    changedKeys.add(act.key);
                    changedKeys.add(act.newKey!);
                }
                break;
        }
    };

    // Execute in batches with UI yielding
    for (let i = 0; i < actions.length; i += batchSize) {
        const batch = actions.slice(i, i + batchSize);
        await Promise.all(batch.map(processAction));

        // Report progress after each batch (using the index of the last processed item)
        onProgressUpdate?.(Math.min(i + batchSize, actions.length), actions.length);

        // Yield to the UI thread to prevent freezing
        await new Promise(resolve => setTimeout(resolve, 0));
    }

    return { changedKeys, actionCount: actions.length };
}