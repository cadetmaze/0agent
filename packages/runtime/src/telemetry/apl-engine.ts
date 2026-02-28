/**
 * APL Engine — Agent Performance Lift calculation.
 *
 * APL is NOT computed in real-time. It is a scheduled job that runs
 * after the business outcome window closes. The telemetry events
 * are the input — they are not aggregated in real time.
 *
 * This engine:
 * 1. Manages company APL baselines (pre-agent KPI snapshots)
 * 2. Reads telemetry events and outcome pointers
 * 3. Compares baseline business metrics to observed metrics
 * 4. Computes the lift (delta) with a confidence score
 * 5. Writes results to the apl_measurements table
 * 6. Triggers royalty settlement when a measurement window closes
 * 7. Provides portable expert track records across companies
 */

import type { SupabaseClient } from '@supabase/supabase-js';

// ============================================================
// Types
// ============================================================

export interface APLBaseline {
    companyId: string;
    kpiName: string;
    baselineValue: number;
    measuredAt: string;
    measuredBy: string | null;
    notes: string;
}

export interface APLMeasurement {
    companyId: string;
    agentId: string;
    kpiName: string;
    baselineValue: number;
    observedValue: number;
    delta: number;
    confidence: number;
    windowStart: string;
    windowEnd: string;
}

export interface APLSummary {
    agentId: string;
    overallAPL: number;
    measurementCount: number;
    kpis: Record<string, number>;
    lastMeasured: string;
}

/** Expert's portable track record — APL aggregated across all companies */
export interface ExpertTrackRecord {
    expertId: string;
    totalCompanies: number;
    totalMeasurements: number;
    averageAPL: number;
    bestAPL: number;
    kpiBreakdown: Record<string, { measurements: number; averageDelta: number }>;
    lastMeasured: string;
}

// ============================================================
// APL Engine
// ============================================================

export class APLEngine {
    private supabase: SupabaseClient;

    constructor(supabase: SupabaseClient) {
        this.supabase = supabase;
    }

    // ============================================================
    // Baseline Management
    // ============================================================

    /**
     * Set the APL baseline for a company KPI.
     * This is the pre-agent measurement that all future APL deltas
     * are compared against. Belongs to the company.
     */
    async setBaseline(
        companyId: string,
        kpiName: string,
        baselineValue: number,
        measuredBy?: string,
        notes?: string
    ): Promise<void> {
        const { error } = await this.supabase
            .from('apl_baselines')
            .upsert(
                {
                    company_id: companyId,
                    kpi_name: kpiName,
                    baseline_value: baselineValue,
                    measured_at: new Date().toISOString(),
                    measured_by: measuredBy ?? null,
                    notes: notes ?? '',
                },
                { onConflict: 'company_id,kpi_name' }
            );

        if (error) {
            throw new Error(`[APLEngine] Failed to set baseline: ${error.message}`);
        }

        console.log(
            `[APLEngine] Baseline set for ${companyId}/${kpiName}: ${baselineValue}`
        );
    }

    /**
     * Get all baselines for a company.
     */
    async getBaselines(companyId: string): Promise<APLBaseline[]> {
        const { data, error } = await this.supabase
            .from('apl_baselines')
            .select('*')
            .eq('company_id', companyId);

        if (error) {
            throw new Error(`[APLEngine] Failed to fetch baselines: ${error.message}`);
        }

        return (data ?? []).map((row) => ({
            companyId: row.company_id as string,
            kpiName: row.kpi_name as string,
            baselineValue: row.baseline_value as number,
            measuredAt: row.measured_at as string,
            measuredBy: (row.measured_by as string) ?? null,
            notes: (row.notes as string) ?? '',
        }));
    }

    /**
     * Get a specific baseline value for a company/KPI pair.
     */
    async getBaseline(companyId: string, kpiName: string): Promise<number | null> {
        const { data, error } = await this.supabase
            .from('apl_baselines')
            .select('baseline_value')
            .eq('company_id', companyId)
            .eq('kpi_name', kpiName)
            .single();

        if (error || !data) return null;
        return data.baseline_value as number;
    }

    // ============================================================
    // APL Computation
    // ============================================================

    /**
     * Compute APL for an agent over a given time window.
     * This is a SCHEDULED operation — not real-time.
     *
     * Steps:
     * 1. Fetch baselines for the company
     * 2. Fetch completed tasks with outcome pointers in the window
     * 3. For each KPI, compare baseline to observed
     * 4. Compute delta and confidence
     * 5. Write to apl_measurements table
     */
    async computeAPL(
        agentId: string,
        companyId: string,
        windowStart: string,
        windowEnd: string
    ): Promise<APLMeasurement[]> {
        console.log(
            `[APLEngine] Computing APL for agent ${agentId} ` +
            `window: ${windowStart} to ${windowEnd}`
        );

        // Fetch baselines
        const baselines = await this.getBaselines(companyId);
        if (baselines.length === 0) {
            console.warn(`[APLEngine] No baselines set for company ${companyId}. Skipping.`);
            return [];
        }

        // TODO: Implement actual APL calculation.
        // This requires:
        // 1. An observed measurement system (post-agent KPI values)
        // 2. A statistical test (e.g., t-test, Mann-Whitney) for confidence
        // 3. A mapping from outcome_pointer to actual business metrics
        //
        // For the scaffold, we generate stub measurements from baselines.

        const measurements: APLMeasurement[] = baselines.map((b) => ({
            companyId,
            agentId,
            kpiName: b.kpiName,
            baselineValue: b.baselineValue,
            observedValue: b.baselineValue, // TODO: replace with actual observed
            delta: 0,
            confidence: 0,
            windowStart,
            windowEnd,
        }));

        // Write all measurements to database
        for (const m of measurements) {
            await this.recordMeasurement(m);
        }

        return measurements;
    }

    /**
     * Record an APL measurement to the database.
     */
    async recordMeasurement(measurement: APLMeasurement): Promise<void> {
        const { error } = await this.supabase.from('apl_measurements').insert({
            company_id: measurement.companyId,
            agent_id: measurement.agentId,
            kpi_name: measurement.kpiName,
            baseline_value: measurement.baselineValue,
            observed_value: measurement.observedValue,
            delta: measurement.delta,
            confidence: measurement.confidence,
            window_start: measurement.windowStart,
            window_end: measurement.windowEnd,
        });

        if (error) {
            throw new Error(`[APLEngine] Failed to record measurement: ${error.message}`);
        }
    }

    // ============================================================
    // Summaries & Track Records
    // ============================================================

    /**
     * Get the APL summary for an agent.
     */
    async getAPLSummary(agentId: string): Promise<APLSummary> {
        const { data, error } = await this.supabase
            .from('apl_measurements')
            .select('*')
            .eq('agent_id', agentId)
            .order('created_at', { ascending: false });

        if (error) {
            throw new Error(`[APLEngine] Failed to fetch APL summary: ${error.message}`);
        }

        const measurements = data ?? [];

        if (measurements.length === 0) {
            return {
                agentId,
                overallAPL: 0,
                measurementCount: 0,
                kpis: {},
                lastMeasured: '',
            };
        }

        // Aggregate by KPI
        const kpis: Record<string, number> = {};
        let totalDelta = 0;

        for (const m of measurements) {
            const kpi = m.kpi_name as string;
            const delta = m.delta as number;
            kpis[kpi] = (kpis[kpi] ?? 0) + delta;
            totalDelta += delta;
        }

        const overallAPL = measurements.length > 0 ? totalDelta / measurements.length : 0;

        return {
            agentId,
            overallAPL,
            measurementCount: measurements.length,
            kpis,
            lastMeasured: (measurements[0]?.created_at as string) ?? '',
        };
    }

    /**
     * Get an expert's portable track record across all companies.
     *
     * This is the "credit score for judgment" — an expert whose
     * Judgment Layer has held seats in multiple companies, maintained
     * APL above benchmark, and survived seat challenges has a
     * verified track record that prospective companies can inspect.
     */
    async getExpertTrackRecord(expertId: string): Promise<ExpertTrackRecord> {
        // Find all agents belonging to this expert
        const { data: agents, error: agentsErr } = await this.supabase
            .from('agents')
            .select('id, company_id')
            .eq('expert_id', expertId);

        if (agentsErr || !agents || agents.length === 0) {
            return {
                expertId,
                totalCompanies: 0,
                totalMeasurements: 0,
                averageAPL: 0,
                bestAPL: 0,
                kpiBreakdown: {},
                lastMeasured: '',
            };
        }

        const agentIds = agents.map((a) => a.id as string);
        const companyIds = new Set(agents.map((a) => a.company_id as string));

        // Fetch all APL measurements for these agents
        const { data: measurements, error: measErr } = await this.supabase
            .from('apl_measurements')
            .select('*')
            .in('agent_id', agentIds)
            .order('created_at', { ascending: false });

        if (measErr || !measurements || measurements.length === 0) {
            return {
                expertId,
                totalCompanies: companyIds.size,
                totalMeasurements: 0,
                averageAPL: 0,
                bestAPL: 0,
                kpiBreakdown: {},
                lastMeasured: '',
            };
        }

        // Aggregate
        let totalDelta = 0;
        let bestAPL = -Infinity;
        const kpiBreakdown: Record<string, { measurements: number; totalDelta: number }> = {};

        for (const m of measurements) {
            const delta = m.delta as number;
            totalDelta += delta;
            if (delta > bestAPL) bestAPL = delta;

            const kpi = m.kpi_name as string;
            if (!kpiBreakdown[kpi]) {
                kpiBreakdown[kpi] = { measurements: 0, totalDelta: 0 };
            }
            kpiBreakdown[kpi].measurements++;
            kpiBreakdown[kpi].totalDelta += delta;
        }

        const formatted: Record<string, { measurements: number; averageDelta: number }> = {};
        for (const [kpi, data] of Object.entries(kpiBreakdown)) {
            formatted[kpi] = {
                measurements: data.measurements,
                averageDelta: data.measurements > 0 ? data.totalDelta / data.measurements : 0,
            };
        }

        return {
            expertId,
            totalCompanies: companyIds.size,
            totalMeasurements: measurements.length,
            averageAPL: measurements.length > 0 ? totalDelta / measurements.length : 0,
            bestAPL: bestAPL === -Infinity ? 0 : bestAPL,
            kpiBreakdown: formatted,
            lastMeasured: (measurements[0]?.created_at as string) ?? '',
        };
    }
}

