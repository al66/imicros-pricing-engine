/**
 * @license MIT, imicros.de (c) 2026 Andreas Leinen
 *
 * Performance test for the pricing engine using a real PostgreSQL instance.
 *
 * Prerequisites
 * ─────────────
 * Set PERF_TEST=1 and configure the database connection via environment variables:
 *   POSTGRES_HOST     (default: localhost)
 *   POSTGRES_PORT     (default: 5432)
 *   POSTGRES_DATABASE (default: postgres)
 *   POSTGRES_USER     (default: postgres)
 *   POSTGRES_PASSWORD (default: postgres)
 *
 * Run with:
 *   PERF_TEST=1 npm run test:perf
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Scenario: B2B Software License Distributor – Discount Pricing
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Attribute Derivation Rules
 *  Rule 1 "Premium Reseller"
 *    IF   customer.annual_revenue >= 1,000,000 EUR
 *    THEN customer.tier = "premium"
 *
 *  Rule 2 "EMEA Region"
 *    IF   customer.country_code IN ("DE","AT","CH","FR","GB")
 *    THEN sales.region = "EMEA"
 *
 * Pricing Conditions (DISCOUNT type)
 *  Condition 1 – 5 %  for premium tier            (priority 100)
 *  Condition 2 – 3 %  for EMEA region             (priority 200)
 *  Condition 3 – 10 % for premium tier + EMEA     (priority 50)
 */
"use strict";

const { DB } = require("../lib/db/postgresDB");

// Allow at most 120 s for the whole suite (1000+ sequential DB round-trips)
jest.setTimeout(120000);

const PERF_TEST_ENABLED = process.env.PERF_TEST === "1";
const WARMUP_ITERATIONS = 10;
const SEQUENTIAL_ITERATIONS = 1000;
const CONCURRENT_BATCH_SIZE = 50;
// Minimum acceptable throughput for the regression guard
const MIN_SEQUENTIAL_OPS_PER_SEC = 10;

const describeOrSkip = PERF_TEST_ENABLED ? describe : describe.skip;

describeOrSkip("Pricing Engine – Performance Test (real PostgreSQL)", () => {
    let db;
    // Track inserted IDs so we can clean up precisely
    let ruleIds = [];
    let conditionIds = [];

    const logger = {
        info: () => {},
        error: console.error,
        warn: console.warn,
        debug: () => {}
    };

    // ─── Helper: run a single pricing call ────────────────────────────────────
    const price = () =>
        db.runPricing({
            facts: {
                "customer.annual_revenue": { valueNumber: 1500000 },
                "customer.country_code":   { valueText: "DE" }
            },
            pricingDate: "2026-06-01",
            conditionTypes: ["DISCOUNT"]
        });

    // ─── Setup ────────────────────────────────────────────────────────────────
    beforeAll(async () => {
        db = new DB({ logger, options: {} });
        await db.connect();

        // Attribute Derivation Rule 1: Premium Reseller
        const rule1 = await db.addRule({
            ruleName: "Perf – Premium Reseller",
            targetKey: "customer.tier",
            targetText: "premium",
            validFrom: "2025-01-01",
            validTo: "2030-12-31",
            priority: 100,
            conditions: [
                {
                    sourceKey: "customer.annual_revenue",
                    operator: ">=",
                    valueType: "NUMBER",
                    values: [{ valueNumber: 1000000 }]
                }
            ]
        });
        ruleIds.push(rule1.ruleId);

        // Attribute Derivation Rule 2: EMEA Region
        const rule2 = await db.addRule({
            ruleName: "Perf – EMEA Region",
            targetKey: "sales.region",
            targetText: "EMEA",
            validFrom: "2025-01-01",
            validTo: "2030-12-31",
            priority: 100,
            conditions: [
                {
                    sourceKey: "customer.country_code",
                    operator: "IN",
                    valueType: "TEXT",
                    values: [
                        { valueText: "DE" },
                        { valueText: "AT" },
                        { valueText: "CH" },
                        { valueText: "FR" },
                        { valueText: "GB" }
                    ]
                }
            ]
        });
        ruleIds.push(rule2.ruleId);

        // Pricing Condition 1: 5 % discount – premium tier
        const cond1 = await db.addCondition({
            conditionType: "DISCOUNT",
            valueType: "PERCENT",
            valueNumber: 5,
            priority: 100,
            validFrom: "2025-01-01",
            validTo: "2030-12-31",
            requirements: [
                {
                    attributeKey: "customer.tier",
                    operator: "=",
                    valueType: "TEXT",
                    values: [{ valueText: "premium" }]
                }
            ]
        });
        conditionIds.push(cond1.conditionId);

        // Pricing Condition 2: 3 % discount – EMEA region
        const cond2 = await db.addCondition({
            conditionType: "DISCOUNT",
            valueType: "PERCENT",
            valueNumber: 3,
            priority: 200,
            validFrom: "2025-01-01",
            validTo: "2030-12-31",
            requirements: [
                {
                    attributeKey: "sales.region",
                    operator: "=",
                    valueType: "TEXT",
                    values: [{ valueText: "EMEA" }]
                }
            ]
        });
        conditionIds.push(cond2.conditionId);

        // Pricing Condition 3: 10 % discount – premium + EMEA combined
        const cond3 = await db.addCondition({
            conditionType: "DISCOUNT",
            valueType: "PERCENT",
            valueNumber: 10,
            priority: 50,
            validFrom: "2025-01-01",
            validTo: "2030-12-31",
            requirements: [
                {
                    attributeKey: "customer.tier",
                    operator: "=",
                    valueType: "TEXT",
                    values: [{ valueText: "premium" }]
                },
                {
                    attributeKey: "sales.region",
                    operator: "=",
                    valueType: "TEXT",
                    values: [{ valueText: "EMEA" }]
                }
            ]
        });
        conditionIds.push(cond3.conditionId);
    });

    // ─── Teardown ─────────────────────────────────────────────────────────────
    afterAll(async () => {
        if (!db) return;
        // Remove the conditions and rules inserted by this test
        for (const conditionId of conditionIds) {
            await db.removeCondition({ conditionId });
        }
        for (const ruleId of ruleIds) {
            await db.pool.query("DELETE FROM attribute_rule WHERE rule_id = $1", [ruleId]);
        }
        await db.disconnect();
    });

    // ─── Sanity check ─────────────────────────────────────────────────────────
    it("returns the expected discounts for the test scenario", async () => {
        const result = await price();
        expect(result).toHaveProperty("contextId");
        expect(result.conditions).toHaveLength(3);
        const discounts = result.conditions.map(c => Number(c.value_number));
        expect(discounts).toEqual(expect.arrayContaining([10, 5, 3]));
    });

    // ─── Warm-up ──────────────────────────────────────────────────────────────
    it(`warms up the connection pool with ${WARMUP_ITERATIONS} runs`, async () => {
        for (let i = 0; i < WARMUP_ITERATIONS; i++) {
            await price();
        }
    });

    // ─── Sequential throughput measurement ────────────────────────────────────
    it(`measures sequential throughput over ${SEQUENTIAL_ITERATIONS} runs`, async () => {
        const start = Date.now();
        for (let i = 0; i < SEQUENTIAL_ITERATIONS; i++) {
            await price();
        }
        const totalMs = Date.now() - start;
        const opsPerSec = (SEQUENTIAL_ITERATIONS / totalMs) * 1000;
        const avgLatencyMs = totalMs / SEQUENTIAL_ITERATIONS;

        console.log("\n─── Sequential Throughput ───────────────────────────────────────");
        console.log(`  Iterations : ${SEQUENTIAL_ITERATIONS}`);
        console.log(`  Total time : ${totalMs} ms`);
        console.log(`  Throughput : ${opsPerSec.toFixed(2)} executions/sec`);
        console.log(`  Avg latency: ${avgLatencyMs.toFixed(2)} ms/execution`);
        console.log("─────────────────────────────────────────────────────────────────\n");

        // Regression guard: must sustain at least MIN_SEQUENTIAL_OPS_PER_SEC
        expect(opsPerSec).toBeGreaterThan(MIN_SEQUENTIAL_OPS_PER_SEC);
    });

    // ─── Concurrent throughput measurement ────────────────────────────────────
    it(`measures concurrent throughput with ${CONCURRENT_BATCH_SIZE} parallel runs`, async () => {
        const calls = Array.from({ length: CONCURRENT_BATCH_SIZE }, () => price());
        const start = Date.now();
        const results = await Promise.all(calls);
        const totalMs = Date.now() - start;
        const opsPerSec = (CONCURRENT_BATCH_SIZE / totalMs) * 1000;
        const avgLatencyMs = totalMs / CONCURRENT_BATCH_SIZE;

        console.log("\n─── Concurrent Throughput ───────────────────────────────────────");
        console.log(`  Batch size : ${CONCURRENT_BATCH_SIZE} parallel calls`);
        console.log(`  Total time : ${totalMs} ms (wall clock)`);
        console.log(`  Throughput : ${opsPerSec.toFixed(2)} executions/sec`);
        console.log(`  Avg latency: ${avgLatencyMs.toFixed(2)} ms/execution (wall clock / batch)`);
        console.log("─────────────────────────────────────────────────────────────────\n");

        // Every call should still return valid results
        for (const result of results) {
            expect(result).toHaveProperty("contextId");
            expect(result.conditions.length).toBeGreaterThan(0);
        }
    });
});
