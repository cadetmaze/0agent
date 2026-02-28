/**
 * Settlement — Royalty calculation and payment settlement.
 *
 * Settlement is a capability adapter, consistent with Usage.md's principle:
 * "settlement is a capability, not an architecture."
 *
 * Three settlement methods, plug-and-play:
 * 1. Stripe (default) — fiat disbursement
 * 2. ACP (Agent Commerce Protocol) — cross-network agent commerce
 * 3. On-chain — escrow, x402 micropayments, Base L2
 *
 * The company chooses. The architecture doesn't change.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

export type SettlementMethod = 'stripe' | 'acp' | 'onchain';
export type RoyaltyStatus = 'pending' | 'settled' | 'failed';

export interface RoyaltyRecord {
    id: string;
    expertId: string;
    companyId: string;
    agentId: string;
    seatId: string | null;
    taskId: string | null;
    amountCents: number;
    currency: string;
    aplAtTime: number;
    settlementMethod: SettlementMethod;
    settlementRef: string | null;
    status: RoyaltyStatus;
    createdAt: string;
    settledAt: string | null;
}

export interface SettlementResult {
    success: boolean;
    settlementRef: string;
    error?: string;
}

// ============================================================
// Settlement Adapter Interface
// ============================================================

/**
 * Any settlement method implements this interface.
 * New settlement protocols can be added without touching
 * the core architecture.
 */
export interface SettlementAdapter {
    readonly method: SettlementMethod;

    /**
     * Process a royalty payment.
     */
    processRoyalty(royalty: RoyaltyRecord): Promise<SettlementResult>;

    /**
     * Get the balance for an expert.
     */
    getBalance(expertId: string): Promise<{ available: number; pending: number; currency: string }>;

    /**
     * Get settlement history for an expert.
     */
    getHistory(expertId: string, limit?: number): Promise<RoyaltyRecord[]>;

    /**
     * Health check for the settlement provider.
     */
    health(): Promise<boolean>;
}

// ============================================================
// Stripe Settlement (default)
// ============================================================

export class StripeSettlement implements SettlementAdapter {
    readonly method: SettlementMethod = 'stripe';

    async processRoyalty(royalty: RoyaltyRecord): Promise<SettlementResult> {
        // TODO: Integrate with Stripe Connect for expert payouts.
        // This requires:
        // - Stripe account for HIVE
        // - Connected accounts for each expert
        // - Transfer API for royalty disbursement
        console.log(
            `[StripeSettlement] Processing royalty ${royalty.id}: ` +
            `${royalty.amountCents} cents to expert ${royalty.expertId}`
        );

        return {
            success: true,
            settlementRef: `stripe_stub_${royalty.id}`,
        };
    }

    async getBalance(expertId: string): Promise<{ available: number; pending: number; currency: string }> {
        // TODO: Query Stripe Connect balance for expert
        console.log(`[StripeSettlement] Getting balance for expert ${expertId}`);
        return { available: 0, pending: 0, currency: 'USD' };
    }

    async getHistory(_expertId: string, _limit = 50): Promise<RoyaltyRecord[]> {
        // TODO: Query royalties table filtered by settlement_method = 'stripe'
        return [];
    }

    async health(): Promise<boolean> {
        // TODO: Ping Stripe API
        return true;
    }
}

// ============================================================
// ACP Settlement (Agent Commerce Protocol)
// ============================================================

export class ACPSettlement implements SettlementAdapter {
    readonly method: SettlementMethod = 'acp';

    async processRoyalty(royalty: RoyaltyRecord): Promise<SettlementResult> {
        // TODO: Implement ACP-compatible settlement
        // - Capability manifest exchange
        // - Cross-network agent commerce
        console.log(`[ACPSettlement] Processing royalty ${royalty.id} via ACP`);
        return { success: true, settlementRef: `acp_stub_${royalty.id}` };
    }

    async getBalance(expertId: string): Promise<{ available: number; pending: number; currency: string }> {
        console.log(`[ACPSettlement] Getting balance for expert ${expertId}`);
        return { available: 0, pending: 0, currency: 'USD' };
    }

    async getHistory(_expertId: string, _limit = 50): Promise<RoyaltyRecord[]> {
        return [];
    }

    async health(): Promise<boolean> {
        return true;
    }
}

// ============================================================
// On-Chain Settlement
// ============================================================

export class OnChainSettlement implements SettlementAdapter {
    readonly method: SettlementMethod = 'onchain';

    async processRoyalty(royalty: RoyaltyRecord): Promise<SettlementResult> {
        // TODO: Implement on-chain settlement
        // - On-chain escrow
        // - x402 micropayments
        // - Base L2 settlement
        console.log(`[OnChainSettlement] Processing royalty ${royalty.id} on-chain`);
        return { success: true, settlementRef: `onchain_stub_${royalty.id}` };
    }

    async getBalance(expertId: string): Promise<{ available: number; pending: number; currency: string }> {
        console.log(`[OnChainSettlement] Getting balance for expert ${expertId}`);
        return { available: 0, pending: 0, currency: 'USD' };
    }

    async getHistory(_expertId: string, _limit = 50): Promise<RoyaltyRecord[]> {
        return [];
    }

    async health(): Promise<boolean> {
        return true;
    }
}

// ============================================================
// Settlement Router
// ============================================================

/**
 * Routes royalty payments to the correct settlement adapter
 * based on company configuration.
 */
export class SettlementRouter {
    private adapters: Map<SettlementMethod, SettlementAdapter> = new Map();
    private supabase: SupabaseClient;

    constructor(supabase: SupabaseClient) {
        this.supabase = supabase;

        // Register default adapters
        this.registerAdapter(new StripeSettlement());
        this.registerAdapter(new ACPSettlement());
        this.registerAdapter(new OnChainSettlement());
    }

    registerAdapter(adapter: SettlementAdapter): void {
        this.adapters.set(adapter.method, adapter);
    }

    /**
     * Calculate and record a royalty after task completion.
     *
     * Royalty amount is proportional to the agent's APL score.
     * Higher APL = higher per-task royalty.
     */
    async calculateAndRecordRoyalty(params: {
        expertId: string;
        companyId: string;
        agentId: string;
        seatId?: string;
        taskId: string;
        aplScore: number;
        settlementMethod: SettlementMethod;
    }): Promise<string> {
        // Royalty formula: base rate * APL multiplier
        // TODO: Make base rate configurable per company/seat
        const baseRateCents = 100; // $1.00 base rate per task
        const aplMultiplier = Math.max(0.1, params.aplScore);
        const amountCents = Math.round(baseRateCents * aplMultiplier);

        const { data, error } = await this.supabase
            .from('royalties')
            .insert({
                expert_id: params.expertId,
                company_id: params.companyId,
                agent_id: params.agentId,
                seat_id: params.seatId ?? null,
                task_id: params.taskId,
                amount_cents: amountCents,
                currency: 'USD',
                apl_at_time: params.aplScore,
                settlement_method: params.settlementMethod,
                status: 'pending',
            })
            .select('id')
            .single();

        if (error || !data) {
            throw new Error(`[SettlementRouter] Failed to record royalty: ${error?.message}`);
        }

        return data.id as string;
    }

    /**
     * Settle all pending royalties for an expert.
     * Called when an APL measurement window closes.
     */
    async settlePendingRoyalties(expertId: string): Promise<number> {
        const { data, error } = await this.supabase
            .from('royalties')
            .select('*')
            .eq('expert_id', expertId)
            .eq('status', 'pending');

        if (error || !data) return 0;

        let settled = 0;
        for (const row of data) {
            const method = row.settlement_method as SettlementMethod;
            const adapter = this.adapters.get(method);
            if (!adapter) {
                console.error(`[SettlementRouter] No adapter for method: ${method}`);
                continue;
            }

            const royalty: RoyaltyRecord = {
                id: row.id as string,
                expertId: row.expert_id as string,
                companyId: row.company_id as string,
                agentId: row.agent_id as string,
                seatId: (row.seat_id as string) ?? null,
                taskId: (row.task_id as string) ?? null,
                amountCents: row.amount_cents as number,
                currency: row.currency as string,
                aplAtTime: row.apl_at_time as number,
                settlementMethod: method,
                settlementRef: null,
                status: 'pending',
                createdAt: row.created_at as string,
                settledAt: null,
            };

            const result = await adapter.processRoyalty(royalty);

            await this.supabase
                .from('royalties')
                .update({
                    status: result.success ? 'settled' : 'failed',
                    settlement_ref: result.settlementRef,
                    settled_at: result.success ? new Date().toISOString() : null,
                })
                .eq('id', royalty.id);

            if (result.success) settled++;
        }

        return settled;
    }
}
