import { ItemView, WorkspaceLeaf } from "obsidian";
import WebDAVSyncPlugin from "./main";

export const SYNC_VIEW_TYPE = "webdav-sync-view";

export class SyncView extends ItemView {
    plugin: WebDAVSyncPlugin;
    statusEl!: HTMLElement;
    lastSyncEl!: HTMLElement;
    changesEl!: HTMLElement;
    syncButton!: HTMLButtonElement;
    errorEl!: HTMLElement;
    progressEl!: HTMLElement; // new element for progress

    constructor(leaf: WorkspaceLeaf, plugin: WebDAVSyncPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType(): string {
        return SYNC_VIEW_TYPE;
    }

    getDisplayText(): string {
        return "ObsiDAV Sync";
    }

    getIcon(): string {
        return "cloud";
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();

        container.createEl("h3", { text: "WebDAV Sync" });

        this.errorEl = container.createDiv({ cls: "sync-error" });
        this.statusEl = container.createDiv({ cls: "sync-status" });
        this.lastSyncEl = container.createDiv({ cls: "sync-last" });
        this.changesEl = container.createDiv({ cls: "sync-changes" });
        this.progressEl = container.createDiv({ cls: "sync-progress" }); // new element
        this.syncButton = container.createEl("button", { text: "Sync Now" });
        this.syncButton.addEventListener("click", () => {
            this.plugin.sync();
        });

        // Cast to any to allow custom event name
        this.registerEvent(
            this.plugin.syncEvents.on("sync:status", this.updateStatus.bind(this))
        );
        this.registerEvent(
            this.plugin.syncEvents.on("sync:progress", this.updateProgress.bind(this))
        );
        this.updateStatus();
        this.updateProgress();
    }

    updateStatus() {
        const status = this.plugin.syncStatus;
        if (status === 'syncing') {
            this.statusEl.setText("Syncing...");
            this.syncButton.disabled = true;
        } else if (status === 'failed') {
            this.statusEl.setText("Sync failed");
            this.syncButton.disabled = false;
        } else if (status === 'success') {
            this.statusEl.setText("All synced");
            this.syncButton.disabled = false;
        } else {
            this.statusEl.setText("Idle");
            this.syncButton.disabled = false;
        }

        // Show error message if failed
        if (status === 'failed' && this.plugin.lastError) {
            this.errorEl.setText(`Error: ${this.plugin.lastError}`);
        } else {
            this.errorEl.setText("");
        }

        const lastSync = this.plugin.lastSyncTime;
        if (lastSync) {
            this.lastSyncEl.setText(`Last sync: ${new Date(lastSync).toLocaleString()}`);
        } else {
            this.lastSyncEl.setText("Last sync: never");
        }

        const changes = this.plugin.lastSyncChanges;
        if (changes !== undefined) {
            if (changes === 0) {
                this.changesEl.setText("No changes");
            } else {
                this.changesEl.setText(`Last sync: ${changes} file(s) changed`);
            }
        } else {
            this.changesEl.setText("");
        }
    }

    updateProgress() {
        const current = this.plugin.syncProgressCurrent;
        const total = this.plugin.syncProgressTotal;
        if (total > 0) {
            this.progressEl.setText(`Progress: ${current}/${total}`);
        } else {
            this.progressEl.setText("");
        }
    }
}