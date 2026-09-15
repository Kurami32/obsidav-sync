import { LocalFS } from "./fsLocal";
import { RemoteWebDAV } from "./fsWebdav";
import { Entity } from "./types";

export async function copyFolder(
    key: string,
    source: LocalFS | RemoteWebDAV,
    dest: LocalFS | RemoteWebDAV
): Promise<Entity> {
    if (!key.endsWith("/")) throw new Error(`copyFolder called on non-folder: ${key}`);
    return await dest.mkdir(key);
}

export async function copyFile(
    key: string,
    source: LocalFS | RemoteWebDAV,
    dest: LocalFS | RemoteWebDAV
): Promise<{ entity: Entity; content: ArrayBuffer }> {
    if (key.endsWith("/")) throw new Error(`copyFile called on folder: ${key}`);
    const srcStat = await source.stat(key);
    const content = await source.readFile(key);
    // Optionally verify size
    if (srcStat.size !== undefined && srcStat.size !== content.byteLength) {
        throw new Error(`Size mismatch for ${key}`);
    }
    const destEntity = await dest.writeFile(key, content, srcStat.mtimeCli || Date.now());
    return { entity: destEntity, content };
}

export async function copyFileOrFolder(
    key: string,
    source: LocalFS | RemoteWebDAV,
    dest: LocalFS | RemoteWebDAV
): Promise<{ entity: Entity; content?: ArrayBuffer }> {
    if (key.endsWith("/")) {
        return { entity: await copyFolder(key, source, dest) };
    } else {
        return await copyFile(key, source, dest);
    }
}