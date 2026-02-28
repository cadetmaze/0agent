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
        // Fetch all entities for this company from unified kg_nodes store
        const { data, error } = await this.supabase
            .from('kg_nodes')
            .select('*')
            .eq('company_id', companyId)
            .eq('owner', 'company')
            .eq('archived', false);

        if (error) {
            console.error(`[OrgGraph] Failed to fetch org context: ${error.message}`);
            return this.emptyContext();
        }

        const entities = (data ?? []) as Array<{
            id: string;
            company_id: string;
            node_type: string;
            properties: Record<string, unknown>;
            created_at: string;
            updated_at: string;
        }>;

        // Extract decisions
        const activeDecisions: Decision[] = entities
            .filter((e) => e.node_type === 'decision')
            .map((e) => ({
                id: e.id,
                title: (e.properties['title'] as string) ?? 'Untitled',
                description: (e.properties['description'] as string) ?? '',
                status: (e.properties['status'] as Decision['status']) ?? 'proposed',
                stakeholders: (e.properties['stakeholders'] as string[]) ?? [],
                deadline: e.properties['deadline'] as string | undefined,
            }));

        // Extract people
        const keyPeople: Person[] = entities
            .filter((e) => e.node_type === 'person')
            .map((e) => ({
                id: e.id,
                name: (e.properties['name'] as string) ?? 'Unknown',
                role: (e.properties['role'] as string) ?? '',
                relevance: (e.properties['relevance'] as string) ?? '',
                contactPreference: e.properties['contactPreference'] as string | undefined,
            }));

        // Extract goal and constraints from project entities
        const projects = entities.filter((e) => e.node_type === 'project');
        const primaryProject = projects[0];
        const goal = (primaryProject?.properties['goal'] as string) ?? '';
        const constraints = (primaryProject?.properties['constraints'] as string[]) ?? [];
        const budgetRemaining = (primaryProject?.properties['budgetRemaining'] as number) ?? 0;

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
            .from('kg_nodes')
            .insert({
                company_id: companyId,
                node_type: entityType,
                properties: entityData,
                owner: 'company',
                title: (entityData['title'] as string) ?? (entityData['name'] as string) ?? `${entityType} Entity`,
                content: (entityData['description'] as string) ?? '',
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
            .from('kg_nodes')
            .update({
                properties: entityData,
                title: (entityData['title'] as string) ?? (entityData['name'] as string) ?? undefined,
                content: (entityData['description'] as string) ?? undefined,
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
            .from('kg_nodes')
            .select('*')
            .eq('company_id', companyId)
            .eq('node_type', entityType)
            .eq('owner', 'company')
            .eq('archived', false);

        if (error) {
            throw new Error(`[OrgGraph] Failed to fetch entities: ${error.message}`);
        }

        return (data ?? []).map((row) => ({
            id: row.id as string,
            companyId: row.company_id as string,
            entityType: row.node_type as EntityType,
            entityData: row.properties as Record<string, unknown>,
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
