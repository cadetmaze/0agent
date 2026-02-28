/**
 * OrgGraph — Organization knowledge graph.
 *
 * Stores and retrieves organizational context: people, projects,
 * decisions, and relationships. Used when building TaskEnvelopes.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Decision, Person } from '../core/envelope.js';

// ============================================================
// Types
// ============================================================

export type EntityType = 'person' | 'project' | 'decision' | 'relationship';

export interface OrgEntity {
    id: string;
    companyId: string;
    entityType: EntityType;
    entityData: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
}

export interface CompanyContext {
    goal: string;
    activeDecisions: Decision[];
    keyPeople: Person[];
    budgetRemaining: number;
    constraints: string[];
}

// ============================================================
// OrgGraph
// ============================================================

export class OrgGraph {
    private supabase: SupabaseClient;

    constructor(supabase: SupabaseClient) {
        this.supabase = supabase;
    }

    /**
     * Get the full company context for building TaskEnvelopes.
     */
    async getCompanyContext(companyId: string): Promise<CompanyContext> {
        // Fetch all entities for this company
        const { data, error } = await this.supabase
            .from('org_knowledge_graph')
            .select('*')
            .eq('company_id', companyId);

        if (error) {
            console.error(`[OrgGraph] Failed to fetch org context: ${error.message}`);
            return this.emptyContext();
        }

        const entities = (data ?? []) as Array<{
            id: string;
            company_id: string;
            entity_type: string;
            entity_data: Record<string, unknown>;
            created_at: string;
            updated_at: string;
        }>;

        // Extract decisions
        const activeDecisions: Decision[] = entities
            .filter((e) => e.entity_type === 'decision')
            .map((e) => ({
                id: e.id,
                title: (e.entity_data['title'] as string) ?? 'Untitled',
                description: (e.entity_data['description'] as string) ?? '',
                status: (e.entity_data['status'] as Decision['status']) ?? 'proposed',
                stakeholders: (e.entity_data['stakeholders'] as string[]) ?? [],
                deadline: e.entity_data['deadline'] as string | undefined,
            }));

        // Extract people
        const keyPeople: Person[] = entities
            .filter((e) => e.entity_type === 'person')
            .map((e) => ({
                id: e.id,
                name: (e.entity_data['name'] as string) ?? 'Unknown',
                role: (e.entity_data['role'] as string) ?? '',
                relevance: (e.entity_data['relevance'] as string) ?? '',
                contactPreference: e.entity_data['contactPreference'] as string | undefined,
            }));

        // Extract goal and constraints from project entities
        const projects = entities.filter((e) => e.entity_type === 'project');
        const primaryProject = projects[0];
        const goal = (primaryProject?.entity_data['goal'] as string) ?? '';
        const constraints = (primaryProject?.entity_data['constraints'] as string[]) ?? [];
        const budgetRemaining = (primaryProject?.entity_data['budgetRemaining'] as number) ?? 0;

        return {
            goal,
            activeDecisions,
            keyPeople,
            budgetRemaining,
            constraints,
        };
    }

    /**
     * Add an entity to the org knowledge graph.
     */
    async addEntity(
        companyId: string,
        entityType: EntityType,
        entityData: Record<string, unknown>
    ): Promise<string> {
        const { data, error } = await this.supabase
            .from('org_knowledge_graph')
            .insert({
                company_id: companyId,
                entity_type: entityType,
                entity_data: entityData,
            })
            .select('id')
            .single();

        if (error || !data) {
            throw new Error(`[OrgGraph] Failed to add entity: ${error?.message ?? 'No data'}`);
        }

        return data.id as string;
    }

    /**
     * Update an entity in the org knowledge graph.
     */
    async updateEntity(
        entityId: string,
        entityData: Record<string, unknown>
    ): Promise<void> {
        const { error } = await this.supabase
            .from('org_knowledge_graph')
            .update({
                entity_data: entityData,
                updated_at: new Date().toISOString(),
            })
            .eq('id', entityId);

        if (error) {
            throw new Error(`[OrgGraph] Failed to update entity: ${error.message}`);
        }
    }

    /**
     * Get entities by type for a company.
     */
    async getEntitiesByType(
        companyId: string,
        entityType: EntityType
    ): Promise<OrgEntity[]> {
        const { data, error } = await this.supabase
            .from('org_knowledge_graph')
            .select('*')
            .eq('company_id', companyId)
            .eq('entity_type', entityType);

        if (error) {
            throw new Error(`[OrgGraph] Failed to fetch entities: ${error.message}`);
        }

        return (data ?? []).map((row) => ({
            id: row.id as string,
            companyId: row.company_id as string,
            entityType: row.entity_type as EntityType,
            entityData: row.entity_data as Record<string, unknown>,
            createdAt: row.created_at as string,
            updatedAt: row.updated_at as string,
        }));
    }

    private emptyContext(): CompanyContext {
        return {
            goal: '',
            activeDecisions: [],
            keyPeople: [],
            budgetRemaining: 0,
            constraints: [],
        };
    }
}
