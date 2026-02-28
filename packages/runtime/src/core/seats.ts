/**
 * Seats — Contestable role assignments within a company.
 *
 * A seat is a function (PM, Dev, Growth, etc.) held by the agent
 * whose Judgment Layer is performing best, measured by APL.
 *
 * Key invariants:
 * - When a seat changes holder, Company Memory is unchanged
 * - The new agent reads the same Active Context and Decision Log
 * - Challenge eligibility is gated by APL track record + lockout period
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

export type SeatStatus = 'open' | 'held' | 'challenge_in_progress' | 'frozen';

export type ChallengeStatus =
    | 'pending'
    | 'approved'
    | 'running'
    | 'completed'
    | 'rejected'
    | 'cancelled';

export type ChallengeResult = 'challenger_wins' | 'holder_retains';

export interface Seat {
    id: string;
    companyId: string;
    role: string;
    scope: string;
    currentAgentId: string | null;
    currentExpertId: string | null;
    aplScore: number;
    performanceWindowDays: number;
    challengeThreshold: number;
    challengeEligibleAfter: string | null;
    status: SeatStatus;
    createdAt: string;
    updatedAt: string;
}

export interface SeatChallenge {
    id: string;
    seatId: string;
    challengerAgentId: string;
    challengerExpertId: string;
    holderAgentId: string;
    holderExpertId: string;
    status: ChallengeStatus;
    trialTaskCount: number;
    trialDurationDays: number;
    challengerApl: number | null;
    holderApl: number | null;
    result: ChallengeResult | null;
    lockoutUntil: string | null;
    createdAt: string;
    resolvedAt: string | null;
}

// ============================================================
// SeatManager
// ============================================================

export class SeatManager {
    private supabase: SupabaseClient;

    constructor(supabase: SupabaseClient) {
        this.supabase = supabase;
    }

    /**
     * Get all seats for a company.
     */
    async getCompanySeats(companyId: string): Promise<Seat[]> {
        const { data, error } = await this.supabase
            .from('seats')
            .select('*')
            .eq('company_id', companyId);

        if (error) {
            throw new Error(`[SeatManager] Failed to get seats: ${error.message}`);
        }

        return (data ?? []).map(this.mapSeat);
    }

    /**
     * Get the seat currently held by a specific agent.
     */
    async getAgentSeat(agentId: string): Promise<Seat | null> {
        const { data, error } = await this.supabase
            .from('seats')
            .select('*')
            .eq('current_agent_id', agentId)
            .single();

        if (error || !data) return null;
        return this.mapSeat(data);
    }

    /**
     * Assign an agent to an open seat.
     * Seat must be 'open' or have no current holder.
     */
    async assignSeat(
        seatId: string,
        agentId: string,
        expertId: string
    ): Promise<void> {
        const { error } = await this.supabase
            .from('seats')
            .update({
                current_agent_id: agentId,
                current_expert_id: expertId,
                status: 'held',
                updated_at: new Date().toISOString(),
            })
            .eq('id', seatId)
            .in('status', ['open']);

        if (error) {
            throw new Error(`[SeatManager] Failed to assign seat: ${error.message}`);
        }
    }

    /**
     * Create a new seat for a company.
     */
    async createSeat(
        companyId: string,
        role: string,
        scope: string,
        options?: {
            performanceWindowDays?: number;
            challengeThreshold?: number;
        }
    ): Promise<string> {
        const { data, error } = await this.supabase
            .from('seats')
            .insert({
                company_id: companyId,
                role,
                scope,
                performance_window_days: options?.performanceWindowDays ?? 21,
                challenge_threshold: options?.challengeThreshold ?? 0.1,
                status: 'open',
            })
            .select('id')
            .single();

        if (error || !data) {
            throw new Error(`[SeatManager] Failed to create seat: ${error?.message}`);
        }

        return data.id as string;
    }

    /**
     * Initiate a seat challenge.
     *
     * Preconditions checked:
     * - Seat must be in 'held' status
     * - Current time must be past challenge_eligible_after
     * - Challenger must not be the current holder
     * - No active challenge on this seat
     */
    async initiateChallenge(
        seatId: string,
        challengerAgentId: string,
        challengerExpertId: string,
        options?: {
            trialTaskCount?: number;
            trialDurationDays?: number;
        }
    ): Promise<string> {
        // Get current seat state
        const { data: seat, error: seatErr } = await this.supabase
            .from('seats')
            .select('*')
            .eq('id', seatId)
            .single();

        if (seatErr || !seat) {
            throw new Error(`[SeatManager] Seat not found: ${seatId}`);
        }

        if (seat.status !== 'held') {
            throw new Error(`[SeatManager] Seat ${seatId} is not in 'held' status`);
        }

        if (seat.current_agent_id === challengerAgentId) {
            throw new Error(`[SeatManager] Cannot challenge your own seat`);
        }

        // Check eligibility window
        if (seat.challenge_eligible_after) {
            const eligibleAfter = new Date(seat.challenge_eligible_after as string);
            if (new Date() < eligibleAfter) {
                throw new Error(
                    `[SeatManager] Seat not eligible for challenge until ${eligibleAfter.toISOString()}`
                );
            }
        }

        // Create challenge record
        const { data: challenge, error: challengeErr } = await this.supabase
            .from('seat_challenges')
            .insert({
                seat_id: seatId,
                challenger_agent_id: challengerAgentId,
                challenger_expert_id: challengerExpertId,
                holder_agent_id: seat.current_agent_id,
                holder_expert_id: seat.current_expert_id,
                trial_task_count: options?.trialTaskCount ?? 10,
                trial_duration_days: options?.trialDurationDays ?? 7,
                status: 'pending',
            })
            .select('id')
            .single();

        if (challengeErr || !challenge) {
            throw new Error(`[SeatManager] Failed to create challenge: ${challengeErr?.message}`);
        }

        // Mark seat as in challenge
        await this.supabase
            .from('seats')
            .update({ status: 'challenge_in_progress', updated_at: new Date().toISOString() })
            .eq('id', seatId);

        return challenge.id as string;
    }

    /**
     * Resolve a seat challenge.
     *
     * If challenger wins: swap agent on seat, set lockout on old holder.
     * If holder retains: set lockout on challenger.
     */
    async resolveChallenge(
        challengeId: string,
        challengerApl: number,
        holderApl: number,
        challengeThreshold: number
    ): Promise<ChallengeResult> {
        const result: ChallengeResult =
            challengerApl - holderApl > challengeThreshold
                ? 'challenger_wins'
                : 'holder_retains';

        const now = new Date();
        const lockoutDays = 30;
        const lockoutUntil = new Date(now.getTime() + lockoutDays * 24 * 60 * 60 * 1000);

        // Get the challenge
        const { data: challenge, error: fetchErr } = await this.supabase
            .from('seat_challenges')
            .select('*')
            .eq('id', challengeId)
            .single();

        if (fetchErr || !challenge) {
            throw new Error(`[SeatManager] Challenge not found: ${challengeId}`);
        }

        // Update challenge record
        await this.supabase
            .from('seat_challenges')
            .update({
                challenger_apl: challengerApl,
                holder_apl: holderApl,
                result,
                status: 'completed',
                lockout_until: lockoutUntil.toISOString(),
                resolved_at: now.toISOString(),
            })
            .eq('id', challengeId);

        if (result === 'challenger_wins') {
            // Swap the seat holder
            await this.supabase
                .from('seats')
                .update({
                    current_agent_id: challenge.challenger_agent_id,
                    current_expert_id: challenge.challenger_expert_id,
                    apl_score: challengerApl,
                    status: 'held',
                    challenge_eligible_after: lockoutUntil.toISOString(),
                    updated_at: now.toISOString(),
                })
                .eq('id', challenge.seat_id);

            console.log(
                `[SeatManager] Challenge ${challengeId}: challenger wins. ` +
                `Seat ${challenge.seat_id as string} transferred.`
            );
        } else {
            // Holder retains — restore seat status
            await this.supabase
                .from('seats')
                .update({
                    status: 'held',
                    updated_at: now.toISOString(),
                })
                .eq('id', challenge.seat_id);

            console.log(
                `[SeatManager] Challenge ${challengeId}: holder retains. ` +
                `Challenger locked out until ${lockoutUntil.toISOString()}.`
            );
        }

        return result;
    }

    // ============================================================
    // Helpers
    // ============================================================

    private mapSeat(row: Record<string, unknown>): Seat {
        return {
            id: row.id as string,
            companyId: row.company_id as string,
            role: row.role as string,
            scope: (row.scope as string) ?? '',
            currentAgentId: (row.current_agent_id as string) ?? null,
            currentExpertId: (row.current_expert_id as string) ?? null,
            aplScore: (row.apl_score as number) ?? 0,
            performanceWindowDays: (row.performance_window_days as number) ?? 21,
            challengeThreshold: (row.challenge_threshold as number) ?? 0.1,
            challengeEligibleAfter: (row.challenge_eligible_after as string) ?? null,
            status: row.status as SeatStatus,
            createdAt: row.created_at as string,
            updatedAt: row.updated_at as string,
        };
    }
}
