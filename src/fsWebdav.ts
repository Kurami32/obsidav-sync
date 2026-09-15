import { Buffer } from "buffer";
import { createClient, AuthType, FileStat, BufferLike } from "webdav";
import { getPatcher } from "webdav/dist/web/index.js";
import { requestUrl, RequestUrlParam } from "obsidian";
import { getReasonPhrase } from "http-status-codes";
import { WebdavConfig, Entity } from "./types";
import { logger } from "./logger";

interface WebDAVRequestOptions {
    url: string;
    method: string;
    headers: Record<string, string>;
    data?: string | ArrayBuffer | Buffer | Uint8Array;
}

// Patch webdav to use Obsidian's requestUrl (to bypass CORS)
getPatcher().patch("request", async (options: WebDAVRequestOptions): Promise<Response> => {
    // Clean headers that might cause issues
    const headers: Record<string, string> = {};
    // Copy all headers, but convert keys to lowercase for consistency
    for (const key in options.headers) {
        headers[key.toLowerCase()] = options.headers[key];
    }
    delete headers["host"];
    delete headers["content-length"];

    // Determine content type: use original header (lowercased) or default for PUT/POST
    let contentType = headers["accept"] ?? headers["content-type"];
    if (!contentType && (options.method.toUpperCase() === "PUT" || options.method.toUpperCase() === "POST")) {
        contentType = "application/octet-stream";
    }

    // Remove content-type from headers (we'll set it via contentType param)
    delete headers["content-type"];

    // Convert body to ArrayBuffer if necessary
    let body: string | ArrayBuffer | undefined;
    if (options.data === undefined) {
        body = undefined;
    } else if (typeof options.data === 'string' || options.data instanceof ArrayBuffer) {
        body = options.data;
    } else {
        // Convert Buffer, Uint8Array, etc. to ArrayBuffer
        body = Buffer.from(options.data).buffer;
    }

    const params: RequestUrlParam = {
        url: options.url,
        method: options.method,
        body: body,
        headers: headers,
        contentType: contentType,
        throw: false,
    };

    logger.debug("WebDAV request:", { url: options.url, method: options.method, headers, contentType });

    try {
        const response = await requestUrl(params);
        logger.debug("WebDAV response status:", response.status);

        const responseHeaders = new Headers();
        for (const key in response.headers) {
            responseHeaders.set(key, response.headers[key]);
        }

        if (response.status === 204) {
            return new Response(null, {
                status: response.status,
                statusText: getReasonPhrase(response.status),
                headers: responseHeaders,
            });
        }

        return new Response(response.arrayBuffer, {
            status: response.status,
            statusText: getReasonPhrase(response.status),
            headers: responseHeaders,
        });
    } catch (err) {
        logger.error("WebDAV request failed:", err, params);
        throw err;
    }
});

function flatten<T>(array: T[][]): T[] {
    return ([] as T[]).concat(...array);
}

function tryEncodeURI(x: string): string {
    if (x.includes("%")) return x;
    return encodeURI(x);
}

function tryEncodeUsernamePassword(x: string): string {
    return x; // webdav library handles UTF‑8
}

function parseCustomHeaders(x: string): Record<string, string> {
    const trimmed = x.trim();
    if (!trimmed) return {};
    return trimmed.split("\n").reduce((acc, line) => {
        const idx = line.indexOf(":");
        if (idx === -1) return acc;
        const key = line.slice(0, idx).trim();
        const value = line.slice(idx + 1).trim();
        acc[key] = value;
        return acc;
    }, {} as Record<string, string>);
}

export class RemoteWebDAV {
    kind = "webdav";
    private client: ReturnType<typeof createClient> | undefined;
    private _wasRemoteBaseCreated = false; // track if we created the folder this session

    public get wasRemoteBaseCreated(): boolean {
        return this._wasRemoteBaseCreated;
    }

    constructor(
        private config: WebdavConfig,
        private vaultName: string,
        private concurrency: number,
    ) {
        this.config.address = tryEncodeURI(this.config.address);
    }

    public async init() {
        if (this.client) return;

        const headers = {
            "Cache-Control": "no-cache",
            ...parseCustomHeaders(this.config.customHeaders || ""),
        };

        // This is a type that extends the official webdav options to avoid linter errors
        type WebDAVClientOptions = NonNullable<Parameters<typeof createClient>[1]>;
        interface ExtendedOptions extends WebDAVClientOptions {
            maxConcurrentRequests?: number;
        }

        if (this.config.username && this.config.password) {
            const baseOptions: WebDAVClientOptions = {
                username: tryEncodeUsernamePassword(this.config.username),
                password: tryEncodeUsernamePassword(this.config.password),
                headers,
                authType: this.config.authType === "digest" ? AuthType.Digest : AuthType.Password,
            };
            const extendedOptions: ExtendedOptions = {
                ...baseOptions,
                maxConcurrentRequests: this.concurrency,
            };
            this.client = createClient(this.config.address, extendedOptions);
        } else {
            const baseOptions: WebDAVClientOptions = {
                headers,
            };
            const extendedOptions: ExtendedOptions = {
                ...baseOptions,
                maxConcurrentRequests: this.concurrency,
            };
            this.client = createClient(this.config.address, extendedOptions);
        }

        const remoteBase = this.getRemoteBasePath();
        const exists = await this.client.exists(remoteBase);
        if (!exists) {
            logger.debug(`Remote base folder ${remoteBase} does not exist, creating...`);
            await this.client.createDirectory(remoteBase);
            this._wasRemoteBaseCreated = true; // mark that we created it
        }
    }

    private getRemoteBasePath(): string {
        const base = this.config.remoteBaseDir || this.vaultName;
        return `/${base}/`.replace(/\/+/g, "/");
    }

    private getFullPath(key: string): string {
        const base = this.getRemoteBasePath();
        if (key === "/" || key === "") return base;
        if (key.startsWith("/")) key = key.slice(1);
        return `${base}${key}`;
    }

    private fromWebdavItem(item: FileStat): Entity {
        const full = item.filename;
        const base = this.getRemoteBasePath(); // e.g., "/Test/"
        logger.debug(`fromWebdavItem: full=${full}, base=${base}`);
        let key = full;
        // If full starts with base, strip it
        if (key.startsWith(base)) {
            key = key.slice(base.length);
        } else if (key + "/" === base) {
            // Special case: full is "/Test" and base is "/Test/" -> root folder
            key = "/";
        } else {
            logger.warn(`Key does not start with base: ${key}`);
            // Keep as is, though this should be rare...
        }
        if (item.type === "directory" && !key.endsWith("/")) {
            key += "/";
        }
        logger.debug(`  -> key=${key}`);
        const mtimeSvr = Date.parse(item.lastmod);
        return {
            key,
            keyRaw: full,
            mtimeSvr: isNaN(mtimeSvr) ? undefined : mtimeSvr,
            size: item.size,
            sizeRaw: item.size,
            etag: item.etag ?? undefined,
        };
    }

    /**
     * Walks the remote directory and yields entities in chunks, yielding to the UI thread after each chunk.
     */
    async *walk(): AsyncGenerator<Entity> {
        await this.init();
        const base = this.getRemoteBasePath();
        let contents: FileStat[] = [];

        if (this.config.depth === "manual_1") {
            const queue = [base];
            const chunkSize = 10;
            while (queue.length) {
                const batch = queue.splice(0, chunkSize);
                const results = await Promise.all(
                    batch.map(async (dir) => {
                        const items = (await this.client!.getDirectoryContents(dir, { deep: false })) as FileStat[];
                        return items.filter(item => item.filename !== dir);
                    })
                );
                const flat = flatten(results);
                for (const item of flat) {
                    contents.push(item);
                    if (item.type === "directory") {
                        queue.push(item.filename);
                    }
                }
            }
        } else {
            contents = (await this.client!.getDirectoryContents(base, { deep: true })) as FileStat[];
        }

        logger.debug(`walk: received ${contents.length} items from server`);

        // Yield entities in chunks to keep UI responsive
        const chunkSize = 50; // moderate chunk size for remote items
        for (let i = 0; i < contents.length; i += chunkSize) {
            const chunk = contents.slice(i, i + chunkSize);
            for (const item of chunk) {
                const entity = this.fromWebdavItem(item);
                if (entity.key !== "") {
                    yield entity;
                }
            }
            // Yield control to the UI thread
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        logger.debug(`walk: after processing, all entities yielded`);
    }

    async stat(key: string): Promise<Entity> {
        await this.init();
        const full = this.getFullPath(key);
        const stat = (await this.client!.stat(full)) as FileStat;
        return this.fromWebdavItem(stat);
    }

    async readFile(key: string): Promise<ArrayBuffer> {
        if (key.endsWith("/")) throw new Error("Cannot read a folder");
        await this.init();
        const full = this.getFullPath(key);
        const data = (await this.client!.getFileContents(full)) as BufferLike;

        // If already ArrayBuffer, return directly
        if (data instanceof ArrayBuffer) {
            return data;
        }

        // Convert anything else (Buffer, Uint8Array, string, etc.) to ArrayBuffer
        return Buffer.from(data).buffer;
    }

    async writeFile(key: string, content: ArrayBuffer, _mtime: number): Promise<Entity> {
        if (key.endsWith("/")) throw new Error("Cannot write to a folder");
        await this.init();
        const full = this.getFullPath(key);
        await this.client!.putFileContents(full, content, { overwrite: true });
        return this.stat(key);
    }

    async mkdir(key: string): Promise<Entity> {
        if (!key.endsWith("/")) key += "/";
        await this.init();
        const full = this.getFullPath(key);
        await this.client!.createDirectory(full, { recursive: true });
        return this.stat(key);
    }

    async rename(oldKey: string, newKey: string): Promise<void> {
        await this.init();
        const oldFull = this.getFullPath(oldKey);
        const newFull = this.getFullPath(newKey);
        await this.client!.moveFile(oldFull, newFull);
    }

    async rm(key: string): Promise<void> {
        await this.init();
        const full = this.getFullPath(key);
        await this.client!.deleteFile(full);
    }

    async checkConnect(): Promise<boolean> {
        try {
            await this.init();
            await this.stat("/");
            return true;
        } catch (err) {
            logger.error("WebDAV connection failed:", err);
            return false;
        }
    }

    async exists(key: string): Promise<boolean> {
        await this.init();
        const full = this.getFullPath(key);
        return this.client!.exists(full);
    }
}