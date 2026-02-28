/**
 * ApprovalGate — Pause/resume for human review.
 *
 * When the policy engine determines a task requires approval,
 * the approval gate writes to the approval_queue table and pauses
 * execution until a human approves or rejects the task.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface ApprovalRequest {
    id: string;
    taskId: string;
    agentId: string;
    reason: string;
    status: ApprovalStatus;
    createdAt: string;
    resolvedAt?: string;
    resolvedBy?: string;
}

export interface ApprovalResult {
    approved: boolean;
    resolvedBy?: string;
    resolvedAt?: string;
    reason?: string;
    /** Correction content from the human reviewer — forwarded as training signal */
    correctionContent?: string;
    /** Whether this result came from an auto-timeout, not a human decision */
    autoResolved?: boolean;
}

/** What to do when an approval request times out */
export type ApprovalTimeoutAction = 'reject' | 'auto_approve_low_risk';

export interface ApprovalGateConfig {
    /** Max wait time for approval in ms. Default: 4 hours */
    timeoutMs: number;
    /** What happens on timeout. Default: 'reject' */
    timeoutAction: ApprovalTimeoutAction;
    /** Poll interval in ms. Default: 5000 */
    pollIntervalMs: number;
}

// ============================================================
// ApprovalGate Class
// ============================================================

export class ApprovalGate {
    private supabase: SupabaseClient;
    private config: ApprovalGateConfig;

    constructor(
        supabase: SupabaseClient,
        config?: Partial<ApprovalGateConfig>
    ) {
        this.supabase = supabase;
        this.config = {
            timeoutMs: config?.timeoutMs ?? 4 * 60 * 60 * 1000,  // 4 hours
            timeoutAction: config?.timeoutAction ?? 'reject',
            pollIntervalMs: config?.pollIntervalMs ?? 5000,
        };
    }

    /**
     * Request approval for a task. Writes to the approval_queue table
     * and blocks until the request is approved or rejected.
     *
     * @param taskId - The task requiring approval
     * @param agentId - The agent that needs approval
     * @param reason - Why approval is required
     * @returns ApprovalResult with the resolution
     */
    async requestApproval(
        taskId: string,
        agentId: string,
        reason: string
    ): Promise<ApprovalResult> {
        // Write the approval request to the queue
        const { data, error } = await this.supabase
            .from('approval_queue')
            .insert({
                task_id: taskId,
                agent_id: agentId,
                reason,
                status: 'pending' as ApprovalStatus,
            })
            .select('id')
            .single();

        if (error || !data) {
            throw new Error(
                `[ApprovalGate] Failed to create approval request: ${error?.message ?? 'No data returned'}`
            );
        }

        const approvalId = data.id as string;
        console.log(
            `[ApprovalGate] Approval requested for task ${taskId}: ${reason} (approval_id: ${approvalId})`
        );

        // Update the task status to halted_for_approval
        await this.supabase
            .from('tasks')
            .update({ status: 'halted_for_approval', updated_at: new Date().toISOString() })
            .eq('id', taskId);

        // Poll until resolved
        const result = await this.waitForResolution(approvalId);

        // If correction content was provided, forward it as a training signal
        if (result.correctionContent) {
            await this.forwardCorrectionToTraining(agentId, taskId, result.correctionContent);
        }

        return result;
    }

    /**
     * Approve a pending request. Called by the human review interface.
     */
    async approve(approvalId: string, resolvedBy: string): Promise<void> {
        const { error } = await this.supabase
            .from('approval_queue')
            .update({
                status: 'approved' as ApprovalStatus,
                resolved_at: new Date().toISOString(),
                resolved_by: resolvedBy,
            })
            .eq('id', approvalId);

        if (error) {
            throw new Error(`[ApprovalGate] Failed to approve: ${error.message}`);
        }

        console.log(`[ApprovalGate] Approval ${approvalId} approved by ${resolvedBy}`);
    }

    /**
     * Reject a pending request. Called by the human review interface.
     */
    async reject(
        approvalId: string,
        resolvedBy: string,
        reason?: string
    ): Promise<void> {
        const { error } = await this.supabase
            .from('approval_queue')
            .update({
                status: 'rejected' as ApprovalStatus,
                resolved_at: new Date().toISOString(),
                resolved_by: resolvedBy,
            })
            .eq('id', approvalId);

        if (error) {
            throw new Error(`[ApprovalGate] Failed to reject: ${error.message}`);
        }

        console.log(
            `[ApprovalGate] Approval ${approvalId} rejected by ${resolvedBy}${reason ? `: ${reason}` : ''}`
        );
    }

    /**
     * Get all pending approvals for an agent.
     */
    async getPendingApprovals(agentId: string): Promise<ApprovalRequest[]> {
        const { data, error } = await this.supabase
            .from('approval_queue')
            .select('*')
            .eq('agent_id', agentId)
            .eq('status', 'pending')
            .order('created_at', { ascending: true });

        if (error) {
            throw new Error(
                `[ApprovalGate] Failed to fetch pending approvals: ${error.message}`
            );
        }

        return (data ?? []).map(this.mapRow);
    }

    // ============================================================
    // Private helpers
    // ============================================================

    /**
     * Poll the approval_queue until the request is resolved.
     */
    private async waitForResolution(approvalId: string): Promise<ApprovalResult> {
        // TODO: Replace polling with Supabase Realtime subscription for production.
        // Polling is acceptable for the scaffold but wastes resources at scale.

        const startTime = Date.now();

        while (Date.now() - startTime < this.config.timeoutMs) {
            const { data, error } = await this.supabase
                .from('approval_queue')
                .select('*')
                .eq('id', approvalId)
                .single();

            if (error) {
                throw new Error(
                    `[ApprovalGate] Failed to check approval status: ${error.message}`
                );
            }

            if (data && data.status !== 'pending') {
                return {
                    approved: data.status === 'approved',
                    resolvedBy: data.resolved_by as string | undefined,
                    resolvedAt: data.resolved_at as string | undefined,
                    reason: data.status === 'rejected' ? 'Rejected by reviewer' : undefined,
                    correctionContent: (data.correction_content as string) || undefined,
                };
            }

            // Wait before polling again
            await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
        }

        // --- Timeout reached ---
        const timeoutHours = (this.config.timeoutMs / (60 * 60 * 1000)).toFixed(1);
        console.warn(
            `[ApprovalGate] Approval ${approvalId} timed out after ${timeoutHours} hours`
        );

        if (this.config.timeoutAction === 'auto_approve_low_risk') {
            // Auto-approve: mark as approved with system as resolver
            await this.supabase
                .from('approval_queue')
                .update({
                    status: 'approved' as ApprovalStatus,
                    resolved_at: new Date().toISOString(),
                    resolved_by: 'system:timeout_auto_approve',
                })
                .eq('id', approvalId);

            console.log(
                `[ApprovalGate] Approval ${approvalId} auto-approved on timeout (low-risk mode)`
            );

            return {
                approved: true,
                resolvedBy: 'system:timeout_auto_approve',
                resolvedAt: new Date().toISOString(),
                reason: `Auto-approved after ${timeoutHours}h timeout`,
                autoResolved: true,
            };
        }

        // Default: reject on timeout
        await this.supabase
            .from('approval_queue')
            .update({
                status: 'rejected' as ApprovalStatus,
                resolved_at: new Date().toISOString(),
                resolved_by: 'system:timeout',
            })
            .eq('id', approvalId);

        return {
            approved: false,
            resolvedBy: 'system:timeout',
            resolvedAt: new Date().toISOString(),
            reason: `Approval timed out after ${timeoutHours} hours — no reviewer responded`,
            autoResolved: true,
        };
    }

    /**
     * Map a database row to an ApprovalRequest type.
     */
    private mapRow(row: Record<string, unknown>): ApprovalRequest {
        return {
            id: row.id as string,
            taskId: row.task_id as string,
            agentId: row.agent_id as string,
            reason: row.reason as string,
            status: row.status as ApprovalStatus,
            createdAt: row.created_at as string,
            resolvedAt: row.resolved_at as string | undefined,
            resolvedBy: row.resolved_by as string | undefined,
        };
    }

    // ============================================================
    // Training Signal — Corrections as feedback
    // ============================================================

    /**
     * Forward a human correction to the Python judgment service
     * as a training signal. This is the "every correction is a
     * training signal" mechanism from Usage.md.
     */
    private async forwardCorrectionToTraining(
        agentId: string,
        taskId: string,
        correctionContent: string
    ): Promise<void> {
        const serviceUrl = process.env.JUDGMENT_SERVICE_URL ?? 'http://localhost:8100';
        const serviceToken = process.env.SERVICE_TOKEN ?? '';

        try {
            const response = await fetch(`${serviceUrl}/training/correction`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Service-Token': serviceToken,
                },
                body: JSON.stringify({
                    agent_id: agentId,
                    task_id: taskId,
                    correction_content: correctionContent,
                    correction_type: 'approval_gate',
                    created_at: new Date().toISOString(),
                }),
            });

            if (!response.ok) {
                console.error(
                    `[ApprovalGate] Failed to forward correction: ${response.status}`
                );
            } else {
                console.log(
                    `[ApprovalGate] Correction forwarded to training service for agent ${agentId}`
                );
            }
        } catch (err) {
            // Non-fatal — log but don't block the approval flow
            console.error(
                `[ApprovalGate] Error forwarding correction: ${err instanceof Error ? err.message : String(err)}`
            );
        }

        // Mark correction as incorporated in the approval queue
        await this.supabase
            .from('approval_queue')
            .update({ correction_incorporated: true })
            .eq('agent_id', agentId)
            .eq('task_id', taskId);
    }
}
