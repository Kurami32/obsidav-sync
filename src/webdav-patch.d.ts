declare module 'webdav/dist/web/index.js' {
    interface WebDAVRequestOptions {
        url: string;
        method: string;
        headers: Record<string, string>;
        data?: string | ArrayBuffer | Buffer | Uint8Array;
    }

    export function getPatcher(): {
        patch(operation: string, handler: (options: WebDAVRequestOptions) => Promise<Response>): void;
    };
}