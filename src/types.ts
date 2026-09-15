/**
 * Shared types for the whole plugin.
 */

import type { LogLevel } from "./logger";

export type WebdavAuthType = "basic" | "digest";
export type WebdavDepthType = "manual_1" | "manual_infinity";
export type SyncDirection =
    | "bidirectional"
    | "incremental_push"
    | "incremental_pull"
    | "incremental_push_delete"
    | "incremental_pull_delete";

export interface WebdavConfig {
    address: string;
    username: string;
    password: string;
    authType: WebdavAuthType;
    depth?: WebdavDepthType;           // "manual_1" or "manual_infinity"
    remoteBaseDir?: string;            // subfolder on the server
    customHeaders?: string;            // newline-separated header: value pairs (I haven't tested this, may have bugs)
}

export const DEFAULT_WEBDAV_CONFIG: WebdavConfig = {
    address: "",
    username: "",
    password: "",
    authType: "basic",
    depth: "manual_1",
    remoteBaseDir: "",
    customHeaders: "",
};

/**
 * key: relative path within the vault (folders end with '/').
 * mtimeCli: client modification time (milliseconds).
 * mtimeSvr: server modification time (if available).
 * size: file size in bytes.
 * sizeRaw: raw file size.
 * etag: remote ETag at last sync.
 */
export interface Entity {
    key: string;          // e.g: "folder/file.md" or "folder/"
    keyRaw: string;       // original remote path (may differ if encryption used, but we keep same -- needs testing)
    mtimeCli?: number;    // last modified time on client (Obsidian)
    mtimeSvr?: number;    // last modified time on server (WebDAV)
    ctimeCli?: number;    // creation time on client
    size?: number;        // file size
    sizeRaw: number;      // raw file size
    etag?: string;        // remote ETag at last sync (for previous sync)
}

export interface PluginSettings {
    webdav: WebdavConfig;
    syncIntervalMinutes: number;          // 0 = manual only
    syncOnSave: boolean;                  // whether to sync after file save
    syncOnStartup: boolean;               // sync after plugin loads
    startupDelaySeconds: number;          // delay before enabling sync-on-save after startup
    syncDirection: SyncDirection;         // Sync mode, we have 5.
    lastSyncTime?: number;                // timestamp of last successful sync
    conflictResolution: "keepNewer" | "keepLarger" | "smart"; // smart -> rename local conflicting file
    deleteToWhere: "system" | "obsidian"; // where to move deleted files
    ignorePaths: string[];                // patterns to ignore (simple path prefixes)
    syncConfigDir: boolean;               // whether to sync .obsidian folder
    syncUnderscoreItems: boolean;         // whether to sync files/folders starting with '_'
    concurrency: number;                  // number of parallel operations
    abortPercentage: number;              // 0-100, abort if > this % files change
    maxFileSizeMB: number;                // 0 = no limit
    logLevel: LogLevel;                   // verbosity of logs in console
    vaultRandomID: string;                // persistent random ID for this vault
}

export const DEFAULT_SETTINGS: PluginSettings = {
    webdav: DEFAULT_WEBDAV_CONFIG,
    syncIntervalMinutes: 0,
    syncOnSave: false,
    syncOnStartup: false,
    startupDelaySeconds: 10,
    syncDirection: "bidirectional",
    conflictResolution: "keepNewer",
    deleteToWhere: "system",
    ignorePaths: [],
    syncConfigDir: false,
    syncUnderscoreItems: false,
    concurrency: 5,
    abortPercentage: 50,
    maxFileSizeMB: 0,
    logLevel: "info",
    vaultRandomID: "",
};