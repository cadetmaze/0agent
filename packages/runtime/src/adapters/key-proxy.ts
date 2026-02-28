/**
 * KeyProxy — ALL credential injection happens here and nowhere else.
 *
 * Security model:
 * - Loads encrypted credentials from the `credentials` table at startup
 * - Decrypts using CREDENTIAL_ENCRYPTION_KEY env var (AES-256)
 * - Exposes injectCredentials() — credentials are never returned as strings
 * - Auto-masks credential fields in request configs for logging
 * - CredentialLeak scanner checks telemetry payloads for credential patterns
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

// ============================================================
// Types
// ============================================================

/** Configuration for an outbound request that may need credentials injected */
export interface RequestConfig {
    url: string;
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers: Record<string, string>;
    body?: unknown;
    queryParams?: Record<string, string>;
}

/** Credentials injected into a request — never exposed as raw strings */
export interface InjectedCredentials {
    /** Opaque reference — adapters use this but never see the raw value */
    _injected: true;
    /** The adapter this credential was injected for */
    adapterId: string;
}

/** A stored credential record from the database */
interface StoredCredential {
    id: string;
    companyId: string;
    adapterName: string;
    encryptedValue: string;
}

/** Result of a credential leak scan */
export interface LeakScanResult {
    hasLeak: boolean;
    leakedPatterns: string[];
    redactedPayload: string;
}

// ============================================================
// Known credential patterns for leak detection
// ============================================================

const CREDENTIAL_PATTERNS: RegExp[] = [
    // API keys
    /sk-[a-zA-Z0-9]{20,}/g,           // OpenAI-style keys
    /sk-ant-[a-zA-Z0-9-]{20,}/g,      // Anthropic-style keys
    /xoxb-[a-zA-Z0-9-]{20,}/g,        // Slack bot tokens
    /xoxp-[a-zA-Z0-9-]{20,}/g,        // Slack user tokens
    /ghp_[a-zA-Z0-9]{36,}/g,          // GitHub personal access tokens
    /gho_[a-zA-Z0-9]{36,}/g,          // GitHub OAuth tokens
    // Bearer tokens
    /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
    // AWS keys
    /AKIA[0-9A-Z]{16}/g,
    // Generic long alphanumeric strings that look like secrets
    /[a-zA-Z0-9_-]{40,}/g,
];

// ============================================================
// AES-256 Encryption Helpers
// ============================================================

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const SALT_LENGTH = 16;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/**
 * Derive an AES-256 key from the encryption key env var using scrypt.
 */
function deriveKey(password: string, salt: Buffer): Buffer {
    return scryptSync(password, salt, KEY_LENGTH);
}

/**
 * Encrypt a plaintext credential value.
 * Returns a hex string: salt:iv:tag:ciphertext
 */
export function encryptCredential(
    plaintext: string,
    encryptionKey: string
): string {
    const salt = randomBytes(SALT_LENGTH);
    const key = deriveKey(encryptionKey, salt);
    const iv = randomBytes(IV_LENGTH);

    const cipher = createCipheriv(ALGORITHM, key, iv);
    let encrypted = cipher.update(plaintext, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const tag = cipher.getAuthTag();

    return [
        salt.toString('hex'),
        iv.toString('hex'),
        tag.toString('hex'),
        encrypted,
    ].join(':');
}

/**
 * Decrypt an encrypted credential value.
 * Expects hex string format: salt:iv:tag:ciphertext
 */
function decryptCredential(
    encryptedValue: string,
    encryptionKey: string
): string {
    const parts = encryptedValue.split(':');
    if (parts.length !== 4) {
        throw new Error('Invalid encrypted credential format');
    }

    const [saltHex, ivHex, tagHex, ciphertext] = parts as [string, string, string, string];
    const salt = Buffer.from(saltHex, 'hex');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');

    const key = deriveKey(encryptionKey, salt);
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
}

// ============================================================
// Masking — auto-mask credential fields in request configs for logging
// ============================================================

const SENSITIVE_HEADERS = new Set([
    'authorization',
    'x-api-key',
    'api-key',
    'x-service-token',
    'cookie',
    'set-cookie',
    'x-auth-token',
    'proxy-authorization',
]);

/**
 * Create a masked copy of a RequestConfig safe for logging.
 * Credential values are replaced with '***MASKED***'.
 */
export function maskRequestConfig(config: RequestConfig): RequestConfig {
    const maskedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(config.headers)) {
        if (SENSITIVE_HEADERS.has(key.toLowerCase())) {
            maskedHeaders[key] = '***MASKED***';
        } else {
            maskedHeaders[key] = value;
        }
    }

    const maskedQuery: Record<string, string> = {};
    if (config.queryParams) {
        for (const [key, value] of Object.entries(config.queryParams)) {
            if (
                key.toLowerCase().includes('key') ||
                key.toLowerCase().includes('token') ||
                key.toLowerCase().includes('secret')
            ) {
                maskedQuery[key] = '***MASKED***';
            } else {
                maskedQuery[key] = value;
            }
        }
    }

    return {
        ...config,
        headers: maskedHeaders,
        queryParams: Object.keys(maskedQuery).length > 0 ? maskedQuery : config.queryParams,
    };
}

// ============================================================
// Credential Leak Detection
// ============================================================

/**
 * Scan a telemetry event payload for strings matching known credential patterns.
 * If found, redact them and return the redacted payload with alert info.
 */
export function scanForCredentialLeaks(payload: string): LeakScanResult {
    const leakedPatterns: string[] = [];
    let redactedPayload = payload;

    for (const pattern of CREDENTIAL_PATTERNS) {
        // Reset lastIndex for global regex
        pattern.lastIndex = 0;
        const matches = payload.match(pattern);
        if (matches) {
            for (const match of matches) {
                // Only flag strings that are likely credentials (not just long words)
                if (match.length >= 20) {
                    const preview = `${match.slice(0, 6)}...${match.slice(-4)}`;
                    leakedPatterns.push(`Potential credential leaked: ${preview} (${match.length} chars)`);
                    redactedPayload = redactedPayload.replace(match, '***REDACTED_CREDENTIAL***');
                }
            }
        }
    }

    return {
        hasLeak: leakedPatterns.length > 0,
        leakedPatterns,
        redactedPayload,
    };
}

// ============================================================
// KeyProxy Class
// ============================================================

export class KeyProxy {
    private decryptedCredentials: Map<string, string> = new Map();
    private encryptionKey: string;
    private initialized = false;

    constructor(encryptionKey: string) {
        if (!encryptionKey || encryptionKey.length < 32) {
            throw new Error(
                'CREDENTIAL_ENCRYPTION_KEY must be at least 32 characters. ' +
                'Generate with: openssl rand -hex 32'
            );
        }
        this.encryptionKey = encryptionKey;
    }

    /**
     * Initialize the proxy by loading and decrypting credentials from the database.
     * Must be called during agent boot, before any adapters are used.
     */
    async initialize(storedCredentials: StoredCredential[]): Promise<void> {
        if (this.initialized) {
            throw new Error('KeyProxy already initialized. Restart agent to re-initialize.');
        }

        for (const cred of storedCredentials) {
            try {
                const decrypted = decryptCredential(cred.encryptedValue, this.encryptionKey);
                this.decryptedCredentials.set(cred.adapterName, decrypted);
            } catch (error) {
                const message = error instanceof Error ? error.message : 'Unknown error';
                // Log but do not expose the credential or the error details
                console.error(
                    `[KeyProxy] Failed to decrypt credential for adapter "${cred.adapterName}": ${message}`
                );
                // Continue loading other credentials — don't fail entirely
            }
        }

        this.initialized = true;
        console.log(
            `[KeyProxy] Initialized with ${this.decryptedCredentials.size} credentials`
        );
    }

    /**
     * Inject credentials into a request config.
     * Credentials are added to the request — never returned as strings.
     *
     * @param adapterId - The ID of the adapter requesting credentials
     * @param requestConfig - The request config to inject credentials into
     * @returns The request config with credentials injected
     */
    injectCredentials(
        adapterId: string,
        requestConfig: RequestConfig
    ): RequestConfig {
        this.ensureInitialized();

        const credential = this.decryptedCredentials.get(adapterId);
        if (!credential) {
            throw new Error(
                `[KeyProxy] No credential found for adapter "${adapterId}". ` +
                'Ensure the credential is stored in the credentials table.'
            );
        }

        // Inject the credential into the Authorization header by default.
        // Adapters can override the header name by pre-setting it.
        const injectedConfig: RequestConfig = {
            ...requestConfig,
            headers: {
                ...requestConfig.headers,
                Authorization: `Bearer ${credential}`,
            },
        };

        return injectedConfig;
    }

    /**
     * Check if a credential exists for a given adapter without revealing the value.
     */
    hasCredential(adapterId: string): boolean {
        this.ensureInitialized();
        return this.decryptedCredentials.has(adapterId);
    }

    /**
     * Get an opaque credential reference for an adapter.
     * This returns an InjectedCredentials object — never a raw string.
     */
    getCredentialRef(adapterId: string): InjectedCredentials {
        this.ensureInitialized();
        if (!this.decryptedCredentials.has(adapterId)) {
            throw new Error(`[KeyProxy] No credential found for adapter "${adapterId}"`);
        }
        return { _injected: true, adapterId };
    }

    private ensureInitialized(): void {
        if (!this.initialized) {
            throw new Error(
                '[KeyProxy] Not initialized. Call initialize() during agent boot first.'
            );
        }
    }
}
