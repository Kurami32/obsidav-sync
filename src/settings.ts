import { App, PluginSettingTab, Setting, Notice, setIcon } from "obsidian";
import WebDAVSyncPlugin from "./main";
import { wrapTextWithPasswordHide } from "./utils";
import { SyncDirection } from "./types";
import { logger, LogLevel } from "./logger";

export class WebDAVSettingTab extends PluginSettingTab {
    plugin: WebDAVSyncPlugin;

    constructor(app: App, plugin: WebDAVSyncPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        // ========== WebDAV SYNC ==========
        containerEl.createEl("h2", { text: "WebDAV Sync" });

        const connWarningFrag = new DocumentFragment();
        const connWarningSpan = connWarningFrag.createSpan({ cls: "setting-warning-description" });
        setIcon(connWarningSpan, "alert-triangle");
        connWarningSpan.appendText("Use this plugin at your own risk -- MAKE SURE that you've done a backup of your Vault before starting to sync. All the info here is stored locally.");

        new Setting(containerEl)
            .setDesc(connWarningFrag);

        new Setting(containerEl)
            .setName("Server URL")
            .setDesc("Full WebDAV endpoint (e.g: https://example.com/dav/)")
            .addText(text =>
                text
                    .setPlaceholder("https://...")
                    .setValue(this.plugin.settings.webdav.address)
                    .onChange(async val => {
                        this.plugin.settings.webdav.address = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Username")
            .setDesc("Your WebDAV username.")
            .addText(text => {
                wrapTextWithPasswordHide(text);
                text
                    .setPlaceholder("username")
                    .setValue(this.plugin.settings.webdav.username)
                    .onChange(async val => {
                        this.plugin.settings.webdav.username = val;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Password")
            .setDesc("Your WebDAV password. It will be encrypted before save to storage.")
            .addText(text => {
                wrapTextWithPasswordHide(text);
                text
                    .setPlaceholder("password")
                    .setValue(this.plugin.settings.webdav.password)
                    .onChange(async val => {
                        this.plugin.settings.webdav.password = val;
                        await this.plugin.saveSettings();
                    });
            });

        new Setting(containerEl)
            .setName("Authentication type")
            .addDropdown(dropdown =>
                dropdown
                    .addOption("basic", "Basic")
                    .addOption("digest", "Digest")
                    .setValue(this.plugin.settings.webdav.authType)
                    .onChange(async val => {
                        this.plugin.settings.webdav.authType = val as "basic" | "digest";
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Depth mode")
            .setDesc(
                "manual_1 (BFS, works everywhere) or manual_infinity (faster if your server supports depth:infinity) -- Leave default if you don't know what it is."
            )
            .addDropdown(dropdown =>
                dropdown
                    .addOption("manual_1", "manual_1 (BFS)")
                    .addOption("manual_infinity", "manual_infinity")
                    .setValue(this.plugin.settings.webdav.depth || "manual_1")
                    .onChange(async val => {
                        this.plugin.settings.webdav.depth = val as "manual_1" | "manual_infinity";
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Remote base directory")
            .setDesc("Subfolder on the server. If empty, will create a folder with your vault name and use that. -- Will append whatever your add in this field, for example: 'https://example.com/dav/data/' + '/obsidian' = 'https://example.com/dav/data/obsidian'")
            .addText(text =>
                text
                    .setPlaceholder("MyVault")
                    .setValue(this.plugin.settings.webdav.remoteBaseDir || "")
                    .onChange(async val => {
                        this.plugin.settings.webdav.remoteBaseDir = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Custom headers")
            .setDesc("One header per line, format: Header: value -- Leave this in blank if you don't know what it is")
            .addTextArea(textarea => {
                textarea
                    .setPlaceholder("X-My-Header: myvalue")
                    .setValue(this.plugin.settings.webdav.customHeaders || "")
                    .onChange(async val => {
                        this.plugin.settings.webdav.customHeaders = val;
                        await this.plugin.saveSettings();
                    });
                textarea.inputEl.rows = 4;
            });

        new Setting(containerEl)
            .setName("Test connection")
            .addButton(button =>
                button
                    .setButtonText("Ping WebDAV")
                    .onClick(async () => {
                        const remoteFs = new (await import("./fsWebdav")).RemoteWebDAV(
                            this.plugin.settings.webdav,
                            this.app.vault.getName(),
                            this.plugin.settings.concurrency
                        );
                        const ok = await remoteFs.checkConnect();
                        new Notice(ok ? "Connection successful" : "Connection failed");
                    })
            );

        // ========== SYNC OPTIONS ==========
        containerEl.createEl("h2", { text: "Sync Options" });

        new Setting(containerEl)
            .setName("Sync interval (minutes)")
            .setDesc("0 = manual only -- automatic sync every X minutes regardless if the vault has changes or not (default: 0)")
            .addSlider(slider =>
                slider
                    .setLimits(0, 60, 5)
                    .setValue(this.plugin.settings.syncIntervalMinutes)
                    .setDynamicTooltip()
                    .onChange(async val => {
                        this.plugin.settings.syncIntervalMinutes = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Sync on file save")
            .setDesc("Automatically sync after saving a file (debounced) -- will sync almost immediately when detects a change.")
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.syncOnSave)
                    .onChange(async val => {
                        this.plugin.settings.syncOnSave = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Sync on startup")
            .setDesc("Run a sync automatically when Obsidian starts")
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.syncOnStartup)
                    .onChange(async val => {
                        this.plugin.settings.syncOnStartup = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Startup delay (seconds)")
            .setDesc("Wait this many seconds after Obsidian starts before enabling sync, 0 = immediately (default: 10)")
            .addSlider(slider =>
                slider
                    .setLimits(0, 60, 1)
                    .setValue(this.plugin.settings.startupDelaySeconds)
                    .setDynamicTooltip()
                    .onChange(async val => {
                        this.plugin.settings.startupDelaySeconds = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Sync direction")
            .setDesc("Choose how files are synchronised (default: bidirectional)")
            .addDropdown(dropdown =>
                dropdown
                    .addOption("bidirectional", "Bidirectional (two‑way sync)")
                    .addOption("incremental_push", "Incremental push (backup mode)")
                    .addOption("incremental_pull", "Incremental pull (restore mode)")
                    .addOption("incremental_push_delete", "Incremental push + delete")
                    .addOption("incremental_pull_delete", "Incremental pull + delete")
                    .setValue(this.plugin.settings.syncDirection)
                    .onChange(async val => {
                        this.plugin.settings.syncDirection = val as SyncDirection;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Conflict resolution")
            .addDropdown(dropdown =>
                dropdown
                    .addOption("keepNewer", "Keep newer")
                    .addOption("keepLarger", "Keep larger")
                    .addOption("smart", "Smart (rename local)")
                    .setValue(this.plugin.settings.conflictResolution)
                    .onChange(async val => {
                        this.plugin.settings.conflictResolution = val as "keepNewer" | "keepLarger" | "smart";
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Delete to")
            .addDropdown(dropdown =>
                dropdown
                    .addOption("system", "System trash")
                    .addOption("obsidian", "Obsidian trash (.trash)")
                    .setValue(this.plugin.settings.deleteToWhere)
                    .onChange(async val => {
                        this.plugin.settings.deleteToWhere = val as "system" | "obsidian";
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Ignore paths")
            .setDesc("One path per line (prefix match). Eg: 'private/', 'uni/math', etc.")
            .addTextArea(textarea => {
                textarea
                    .setValue(this.plugin.settings.ignorePaths.join("\n"))
                    .onChange(async val => {
                        this.plugin.settings.ignorePaths = val.split("\n").map(s => s.trim()).filter(s => s);
                        await this.plugin.saveSettings();
                    });
                textarea.inputEl.rows = 4;
            });

        // Sync obsidian folder
        const descFrag = new DocumentFragment();
        descFrag.createSpan({ text: "Include the whole obsidian configuration folder." });
        descFrag.createEl("br");
        const warningSpan = descFrag.createSpan({ cls: "setting-warning-description" });
        setIcon(warningSpan, "alert-triangle");
        warningSpan.appendText("Syncing this folder may expose sensitive data like plugin settings, themes, etc.");

        new Setting(containerEl)
            .setName("Sync .obsidian folder")
            .setDesc(descFrag)
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.syncConfigDir)
                    .onChange(async val => {
                        this.plugin.settings.syncConfigDir = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Sync underscore items")
            .setDesc("Include files and folders whose names start with '_', by default they aren't included")
            .addToggle(toggle =>
                toggle
                    .setValue(this.plugin.settings.syncUnderscoreItems)
                    .onChange(async val => {
                        this.plugin.settings.syncUnderscoreItems = val;
                        await this.plugin.saveSettings();
                    })
            );

        // ========== ADVANCED ==========
        containerEl.createEl("h2", { text: "Advanced" });

        new Setting(containerEl)
            .setName("Concurrency")
            .setDesc("How many files to process in parallel (upload and download). Can be useful if you hit rate limits. (default 5)")
            .addSlider(slider =>
                slider
                    .setLimits(1, 20, 1)
                    .setValue(this.plugin.settings.concurrency)
                    .setDynamicTooltip()
                    .onChange(async val => {
                        this.plugin.settings.concurrency = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Max file size (MB)")
            .setDesc("Files larger than this will be skipped. 0 = no limit. (default: 0)")
            .addText(text => text
                .setPlaceholder("0")
                .setValue(String(this.plugin.settings.maxFileSizeMB))
                .onChange(async val => {
                    const num = parseInt(val);
                    if (!isNaN(num) && num >= 0) {
                        this.plugin.settings.maxFileSizeMB = num;
                        await this.plugin.saveSettings();
                    }
                })
            );

        const abortDescFrag = new DocumentFragment();
        abortDescFrag.createSpan({ text: "Abort if more than this % of files would be deleted/modified. 100 = disable, 0 = always block (default: 50%)" });
        abortDescFrag.createEl("br");
        const abortWarningSpan = abortDescFrag.createSpan({ cls: "setting-warning-description" });
        setIcon(abortWarningSpan, "alert-triangle");
        abortWarningSpan.appendText("Setting this too low may block legitimate syncs");

        new Setting(containerEl)
            .setName("Abort sync if modification above percentage")
            .setDesc(abortDescFrag)
            .addSlider(slider =>
                slider
                    .setLimits(0, 100, 5)
                    .setValue(this.plugin.settings.abortPercentage)
                    .setDynamicTooltip()
                    .onChange(async val => {
                        this.plugin.settings.abortPercentage = val;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Log level")
            .setDesc("Log verbosity in console (CRTL+SHIFT+I), useful when debugging")
            .addDropdown(dropdown =>
                dropdown
                    .addOption("debug", "Debug")
                    .addOption("info", "Info")
                    .addOption("error", "Error")
                    .setValue(this.plugin.settings.logLevel)
                    .onChange(async val => {
                        this.plugin.settings.logLevel = val as LogLevel;
                        await this.plugin.saveSettings();
                        logger.setLevel(val as LogLevel);
                    })
            );

        // ========== DATA MANAGEMENT ==========
        containerEl.createEl("h2", { text: "Data Management" });

        const clearDescFrag = new DocumentFragment();
        clearDescFrag.createSpan({ text: "Clear all stored sync history. This will force a fresh sync on next run." });
        clearDescFrag.createEl("br");
        const clearWarningSpan = clearDescFrag.createSpan({ cls: "setting-warning-description" });
        setIcon(clearWarningSpan, "alert-triangle");
        clearWarningSpan.appendText("If you clear it, in the next sync will re-download all remote files to local (even if they already exist), but it also depends in your sync configuration above.");

        new Setting(containerEl)
            .setName("Reset sync state")
            .setDesc(clearDescFrag)
            .addButton(button => button
                .setButtonText("Clear database")
                .setWarning()
                .onClick(async () => {
                    if (confirm("Are you sure? This will delete all sync history and you may lose pending changes if not synced.")) {
                        await this.plugin.clearSyncDB();
                        new Notice("Sync database cleared. Next sync will be fresh.");
                    }
                })
            );
    }
}