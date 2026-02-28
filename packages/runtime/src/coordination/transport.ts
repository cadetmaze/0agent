/**
 * Transport — Language channel for agent-to-agent communication.
 *
 * Today: agents communicate by exchanging language (text messages).
 * Future: swap for latent space vector transfer when trust > threshold.
 *
 * The seam for latent space coordination lives here.
 */

// ============================================================
// Transport Types
// ============================================================

export type MessageChannel = 'language' | 'latent';

export interface TransportMessage {
    /** Unique message ID */
    id: string;
    /** Sender agent ID */
    fromAgentId: string;
    /** Receiver agent ID */
    toAgentId: string;
    /** The channel used */
    channel: MessageChannel;
    /** Message content (text for language channel) */
    content: string;
    /** Metadata */
    metadata: Record<string, unknown>;
    /** Timestamp */
    timestamp: string;
}

export interface TransportConfig {
    /** Which channel to use */
    channel: MessageChannel;
    /** Trust threshold for switching to latent channel */
    latentTrustThreshold: number;
}

const DEFAULT_CONFIG: TransportConfig = {
    channel: 'language',
    latentTrustThreshold: 0.95,
};

// ============================================================
// Transport Class
// ============================================================

export class Transport {
    private config: TransportConfig;
    private messageLog: TransportMessage[] = [];

    constructor(config?: Partial<TransportConfig>) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Send a message from one agent to another.
     * Uses the language channel (text). In the future, agents with
     * high mutual trust will use the latent channel for direct
     * vector-space context transfer.
     */
    async send(
        fromAgentId: string,
        toAgentId: string,
        content: string,
        metadata: Record<string, unknown> = {}
    ): Promise<TransportMessage> {
        const message: TransportMessage = {
            id: crypto.randomUUID(),
            fromAgentId,
            toAgentId,
            channel: this.config.channel,
            content,
            metadata,
            timestamp: new Date().toISOString(),
        };

        // FUTURE: swap language channel for vector transfer when trust > threshold.
        // The latent channel would encode the message as a context vector and
        // inject it directly into the receiving agent's working memory,
        // bypassing the language encoding/decoding bottleneck.
        //
        // if (this.config.channel === 'latent') {
        //   return this.sendLatent(message);
        // }

        this.messageLog.push(message);
        console.log(
            `[Transport] Message ${message.id}: ${fromAgentId} → ${toAgentId} (${message.channel})`
        );

        return message;
    }

    /**
     * Receive all pending messages for an agent.
     */
    getMessagesForAgent(agentId: string): TransportMessage[] {
        return this.messageLog.filter((m) => m.toAgentId === agentId);
    }

    /**
     * Get the message log (for audit).
     */
    getMessageLog(): ReadonlyArray<TransportMessage> {
        return this.messageLog;
    }

    /**
     * Determine the appropriate channel based on trust score.
     * FUTURE: When trust is high enough, switch to latent channel.
     */
    selectChannel(trustScore: number): MessageChannel {
        // FUTURE: swap language channel for vector transfer when trust > threshold
        if (trustScore >= this.config.latentTrustThreshold) {
            // return 'latent';  // Enable when latent transport is implemented
            return 'language';
        }
        return 'language';
    }
}
