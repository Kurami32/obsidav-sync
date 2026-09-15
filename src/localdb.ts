import { Entity } from './types';

const DB_NAME = 'obsidav-sync-db';
const DB_VERSION = 1;
const STORE_PREV_SYNC = 'prevSync';
const STORE_METADATA = 'metadata';

function openDB(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        request.onupgradeneeded = (_event) => {
            const db = request.result;
            if (!db.objectStoreNames.contains(STORE_PREV_SYNC)) {
                db.createObjectStore(STORE_PREV_SYNC); // keyPath not used, we'll set keys manually
            }
            if (!db.objectStoreNames.contains(STORE_METADATA)) {
                db.createObjectStore(STORE_METADATA);
            }
        };
    });
}

export async function savePrevSyncEntities(
    vaultID: string,
    profileID: string,
    entities: Entity[]
): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_PREV_SYNC, 'readwrite');
    const store = tx.objectStore(STORE_PREV_SYNC);
    for (const entity of entities) {
        const key = `${vaultID}/${profileID}/${entity.key}`;
        store.put(entity, key);
    }
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadPrevSyncEntities(
    vaultID: string,
    profileID: string
): Promise<Entity[]> {
    const db = await openDB();
    const tx = db.transaction(STORE_PREV_SYNC, 'readonly');
    const store = tx.objectStore(STORE_PREV_SYNC);
    return new Promise((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => {
            const keys = request.result as string[];
            const prefix = `${vaultID}/${profileID}/`;
            const matchingKeys = keys.filter(k => k.startsWith(prefix));
            if (matchingKeys.length === 0) {
                resolve([]);
                return;
            }
            const entities: Entity[] = [];
            let remaining = matchingKeys.length;
            matchingKeys.forEach((key, index) => {
                const getReq = store.get(key);
                getReq.onsuccess = () => {
                    entities[index] = getReq.result;
                    remaining--;
                    if (remaining === 0) {
                        resolve(entities);
                    }
                };
                getReq.onerror = () => reject(getReq.error);
            });
        };
        request.onerror = () => reject(request.error);
    });
}

export async function clearPrevSyncEntities(
    vaultID: string,
    profileID: string
): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_PREV_SYNC, 'readwrite');
    const store = tx.objectStore(STORE_PREV_SYNC);
    return new Promise((resolve, reject) => {
        const request = store.getAllKeys();
        request.onsuccess = () => {
            const keys = request.result as string[];
            const prefix = `${vaultID}/${profileID}/`;
            const matchingKeys = keys.filter(k => k.startsWith(prefix));
            let remaining = matchingKeys.length;
            if (remaining === 0) {
                resolve();
                return;
            }
            matchingKeys.forEach(key => {
                const delReq = store.delete(key);
                delReq.onsuccess = () => {
                    remaining--;
                    if (remaining === 0) resolve();
                };
                delReq.onerror = () => reject(delReq.error);
            });
        };
        request.onerror = () => reject(request.error);
    });
}

export async function getMetadata<T>(vaultID: string, key: string): Promise<T | null> {
    const db = await openDB();
    const tx = db.transaction(STORE_METADATA, 'readonly');
    const store = tx.objectStore(STORE_METADATA);
    return new Promise((resolve, reject) => {
        const request = store.get(`${vaultID}/meta/${key}`);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
    });
}

export async function setMetadata<T>(vaultID: string, key: string, value: T): Promise<void> {
    const db = await openDB();
    const tx = db.transaction(STORE_METADATA, 'readwrite');
    const store = tx.objectStore(STORE_METADATA);
    return new Promise((resolve, reject) => {
        const request = store.put(value, `${vaultID}/meta/${key}`);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}