/**
 * TaskContract — Typed agent-to-agent handoffs.
 *
 * When one agent delegates work to another, the handoff is defined
 * by a TaskContract that specifies input/output schemas, acceptance
 * criteria, and the trust score at the time of delegation.
 */

import type { JSONSchema } from '../adapters/base.js';

// ============================================================
// Contract Types
// ============================================================

/** Status of a task contract */
export type ContractStatus =
    | 'proposed'
    | 'accepted'
    | 'in_progress'
    | 'completed'
    | 'failed'
    | 'rejected';

/** A criterion that must be met for the contract to be fulfilled */
export interface AcceptanceCriterion {
    id: string;
    description: string;
    verificationMethod: 'automated' | 'human_review' | 'llm_judge';
    met: boolean;
}

/** The contract between two agents for a task handoff */
export interface TaskContract {
    /** Unique ID for this contract */
    id: string;
    /** Agent delegating the work */
    sourceAgentId: string;
    /** Agent receiving the work */
    targetAgentId: string;
    /** Schema for the input the target agent will receive */
    inputSchema: JSONSchema;
    /** Schema for the output the target agent must produce */
    outputSchema: JSONSchema;
    /** Criteria that must be met for the contract to be fulfilled */
    acceptanceCriteria: AcceptanceCriterion[];
    /** Trust score of the target agent at the time of delegation */
    trustScoreAtTime: number;
    /** Current status of the contract */
    status: ContractStatus;
    /** The actual input data sent to the target agent */
    input?: Record<string, unknown>;
    /** The actual output data produced by the target agent */
    output?: Record<string, unknown>;
    /** Timestamps */
    createdAt: string;
    completedAt?: string;
}

// ============================================================
// Contract Manager
// ============================================================

export class ContractManager {
    private contracts: Map<string, TaskContract> = new Map();

    /**
     * Create a new contract between two agents.
     */
    createContract(
        sourceAgentId: string,
        targetAgentId: string,
        inputSchema: JSONSchema,
        outputSchema: JSONSchema,
        acceptanceCriteria: AcceptanceCriterion[],
        trustScore: number
    ): TaskContract {
        const contract: TaskContract = {
            id: crypto.randomUUID(),
            sourceAgentId,
            targetAgentId,
            inputSchema,
            outputSchema,
            acceptanceCriteria,
            trustScoreAtTime: trustScore,
            status: 'proposed',
            createdAt: new Date().toISOString(),
        };

        this.contracts.set(contract.id, contract);
        console.log(
            `[ContractManager] Contract ${contract.id} created: ${sourceAgentId} → ${targetAgentId}`
        );

        return contract;
    }

    /**
     * Accept a contract and attach input data.
     */
    acceptContract(contractId: string, input: Record<string, unknown>): void {
        const contract = this.getContract(contractId);
        contract.status = 'accepted';
        contract.input = input;
        // TODO: Validate input against inputSchema.
    }

    /**
     * Mark a contract as in progress.
     */
    startContract(contractId: string): void {
        const contract = this.getContract(contractId);
        contract.status = 'in_progress';
    }

    /**
     * Complete a contract with output data.
     */
    completeContract(
        contractId: string,
        output: Record<string, unknown>
    ): void {
        const contract = this.getContract(contractId);
        // TODO: Validate output against outputSchema.
        contract.output = output;
        contract.status = 'completed';
        contract.completedAt = new Date().toISOString();
    }

    /**
     * Fail a contract with an error.
     */
    failContract(contractId: string, reason: string): void {
        const contract = this.getContract(contractId);
        contract.status = 'failed';
        contract.completedAt = new Date().toISOString();
        console.error(
            `[ContractManager] Contract ${contractId} failed: ${reason}`
        );
    }

    /**
     * Get a contract by ID.
     */
    getContract(contractId: string): TaskContract {
        const contract = this.contracts.get(contractId);
        if (!contract) {
            throw new Error(
                `[ContractManager] Contract ${contractId} not found`
            );
        }
        return contract;
    }

    /**
     * Get all contracts for a source agent.
     */
    getContractsForSource(agentId: string): TaskContract[] {
        return Array.from(this.contracts.values()).filter(
            (c) => c.sourceAgentId === agentId
        );
    }

    /**
     * Get all contracts targeting a specific agent.
     */
    getContractsForTarget(agentId: string): TaskContract[] {
        return Array.from(this.contracts.values()).filter(
            (c) => c.targetAgentId === agentId
        );
    }
}
