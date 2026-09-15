import { Vault, TFile, TFolder } from "obsidian";
import { Entity } from "./types";
import { logger } from "./logger";

interface HasStat {
    stat: {
        mtime: number;
        size?: number;
        ctime?: number;
    };
}

export class LocalFS {
    kind = "local";

    constructor(
        private vault: Vault,
        private syncConfigDir: boolean,
        private syncUnderscoreItems: boolean
    ) {}

    // Get metadata for a single file or folder.
    async stat(key: string): Promise<Entity> {
        // Remove trailing slash for vault lookup
        const path = key.endsWith("/") ? key.slice(0, -1) : key;
        const abs = this.vault.getAbstractFileByPath(path);
        if (!abs) throw new Error(`File not found: ${key}`);

        // Use double assertion: first to unknown, then to HasStat to avoid linter errors
        const stat = (abs as unknown as HasStat).stat;
        const isFolder = abs instanceof TFolder;
        return {
            key: key,
            keyRaw: key,
            mtimeCli: stat.mtime,
            ctimeCli: stat.ctime,
            size: isFolder ? 0 : (abs as TFile).stat.size,
            sizeRaw: isFolder ? 0 : (abs as TFile).stat.size,
        };
    }

    /**
     * Walks the vault and yields entities in chunks, yielding to the UI thread after each chunk.
     * This prevents freezing on large vaults, especially on mobile.
     */
    async *walk(): AsyncGenerator<Entity> {
        let files = this.vault.getFiles();
        let folders = this.vault.getAllFolders();

        if (!this.syncConfigDir) {
            files = files.filter(f => !f.path.startsWith('.obsidian/'));
            folders = folders.filter(f => !f.path.startsWith('.obsidian/'));
        }

        if (!this.syncUnderscoreItems) {
            files = files.filter(f => !f.path.split('/').some(part => part.startsWith('_')));
            folders = folders.filter(f => !f.path.split('/').some(part => part.startsWith('_')));
        }

        // Yield files in chunks
        const fileChunkSize = 100;
        for (let i = 0; i < files.length; i += fileChunkSize) {
            const chunk = files.slice(i, i + fileChunkSize);
            for (const f of chunk) {
                yield {
                    key: f.path,
                    keyRaw: f.path,
                    mtimeCli: f.stat.mtime,
                    ctimeCli: f.stat.ctime,
                    size: f.stat.size,
                    sizeRaw: f.stat.size,
                };
            }
            // Yield control to the UI thread after each chunk
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        // Yield folders in chunks (usually much fewer)
        const folderChunkSize = 50;
        for (let i = 0; i < folders.length; i += folderChunkSize) {
            const chunk = folders.slice(i, i + folderChunkSize);
            for (const f of chunk) {
                yield {
                    key: f.path.endsWith("/") ? f.path : f.path + "/",
                    keyRaw: f.path,
                    // Use double assertion for folder stat as well
                    mtimeCli: (f as unknown as HasStat).stat?.mtime || 0,
                    ctimeCli: (f as unknown as HasStat).stat?.ctime,
                    size: 0,
                    sizeRaw: 0,
                };
            }
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        logger.debug(`local.walk() completed`);
    }

    async readFile(key: string): Promise<ArrayBuffer> {
        const path = key.endsWith("/") ? key.slice(0, -1) : key;
        const file = this.vault.getAbstractFileByPath(path);
        if (!(file instanceof TFile)) throw new Error(`Not a file: ${key}`);
        return await this.vault.readBinary(file);
    }

    async writeFile(key: string, content: ArrayBuffer, _mtime: number): Promise<Entity> {
        const path = key.endsWith("/") ? key.slice(0, -1) : key;
        const file = this.vault.getAbstractFileByPath(path);
        if (file instanceof TFile) {
            await this.vault.modifyBinary(file, content);
        } else {
            await this.vault.createBinary(path, content);
        }
        return this.stat(key);
    }

    async mkdir(key: string): Promise<Entity> {
        const folderPath = key.endsWith("/") ? key.slice(0, -1) : key;
        const folder = this.vault.getAbstractFileByPath(folderPath);
        if (!folder) {
            await this.vault.createFolder(folderPath);
        }
        // Return a synthetic entity without calling stat
        return {
            key: key,
            keyRaw: key,
            mtimeCli: Date.now(),
            size: 0,
            sizeRaw: 0,
        };
    }

    async rename(oldKey: string, newKey: string): Promise<void> {
        const oldPath = oldKey.endsWith("/") ? oldKey.slice(0, -1) : oldKey;
        const newPath = newKey.endsWith("/") ? newKey.slice(0, -1) : newKey;
        const file = this.vault.getAbstractFileByPath(oldPath);
        if (!file) throw new Error(`File not found: ${oldKey}`);
        await this.vault.rename(file, newPath);
    }

    async rm(key: string, deleteToWhere: "system" | "obsidian"): Promise<void> {
        const path = key.endsWith("/") ? key.slice(0, -1) : key;
        const file = this.vault.getAbstractFileByPath(path);
        if (!file) return;
        if (deleteToWhere === "system") {
            await this.vault.adapter.trashSystem(path);
        } else {
            await this.vault.trash(file, true);
        }
    }

    async exists(key: string): Promise<boolean> {
        const path = key.endsWith("/") ? key.slice(0, -1) : key;
        return this.vault.getAbstractFileByPath(path) != null;
    }
}