import { TextComponent, setIcon } from "obsidian";

/**
 * Converts an ArrayBuffer to a Base64 string.
 */
function arrayBufferToBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Converts a Base64 string to an ArrayBuffer.
 */
function base64ToArrayBuffer(base64: string): ArrayBuffer {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

/**
 * Derives a 256-bit AES key from the vault's random ID using PBKDF2.
 */
async function deriveKey(keyMaterial: string, salt: Uint8Array): Promise<CryptoKey> {
    const enc = new TextEncoder();
    // Cast the Uint8Array to the expected type (ArrayBufferView<ArrayBuffer>) to satisfy TypeScript
    const keyMaterialBuffer = enc.encode(keyMaterial) as unknown as Uint8Array<ArrayBuffer>;
    const baseKey = await crypto.subtle.importKey(
        'raw',
        keyMaterialBuffer,
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
    );
    const saltView = salt as unknown as Uint8Array<ArrayBuffer>;
    return crypto.subtle.deriveKey(
        {
            name: 'PBKDF2',
            salt: saltView,
            iterations: 100000,
            hash: 'SHA-256'
        },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypts a plaintext password using AES-256-GCM with a key derived from the vault's random ID.
 * @param plain - The plaintext password.
 * @param keyMaterial - The vault's random ID (used as key material).
 * @returns A base64 string containing: salt (16 bytes) + iv (12 bytes) + ciphertext + authTag (16 bytes).
 */
export async function encryptPassword(plain: string, keyMaterial: string): Promise<string> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(keyMaterial, salt);

    const enc = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        enc.encode(plain)
    );

    // Concatenate salt + iv + ciphertext (ciphertext already includes auth tag at the end)
    const result = new Uint8Array(salt.length + iv.length + ciphertext.byteLength);
    result.set(salt, 0);
    result.set(iv, salt.length);
    result.set(new Uint8Array(ciphertext), salt.length + iv.length);

    return arrayBufferToBase64(result.buffer);
}

/**
 * Decrypts a password that was encrypted with encryptPassword.
 * @param encryptedBase64 - The stored base64 string.
 * @param keyMaterial - The vault's random ID (same as used for encryption).
 * @returns The plaintext password.
 */
export async function decryptPassword(encryptedBase64: string, keyMaterial: string): Promise<string> {
    const combined = new Uint8Array(base64ToArrayBuffer(encryptedBase64));
    const salt = combined.slice(0, 16);
    const iv = combined.slice(16, 28);
    const ciphertext = combined.slice(28);

    const key = await deriveKey(keyMaterial, salt);

    const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv },
        key,
        ciphertext
    );

    return new TextDecoder().decode(decrypted);
}

export function wrapTextWithPasswordHide(text: TextComponent) {
    const inputEl = text.inputEl;
    const wrapper = inputEl.parentElement!;
    const toggle = wrapper.createEl("span", { cls: "password-toggle" });
    setIcon(toggle, "eye");
    toggle.addEventListener("click", () => {
        const type = inputEl.getAttribute("type");
        if (type === "password") {
            inputEl.setAttribute("type", "text");
            setIcon(toggle, "eye-off");
        } else {
            inputEl.setAttribute("type", "password");
            setIcon(toggle, "eye");
        }
    });
    inputEl.setAttribute("type", "password");
}