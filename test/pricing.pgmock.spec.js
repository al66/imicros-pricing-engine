/**
 * @license MIT, imicros.de (c) 2026 Andreas Leinen
 *
 * Integration test for the pricing engine using pgmock (https://github.com/stack-auth/pgmock)
 * as an in-memory PostgreSQL backend.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * Scenario: B2B Software License Distributor – Discount Pricing
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A software distributor configures discounts for its reseller partners.
 * Raw business facts (annual revenue, country) are first transformed into
 * pricing-relevant attributes by attribute derivation rules, and then matched
 * against pricing conditions to determine applicable discounts.
 *
 * Attribute Derivation Rules
 * ──────────────────────────
 *  Rule 1 "Premium Reseller"
 *    IF   customer.annual_revenue >= 1,000,000 EUR
 *    THEN customer.tier = "premium"
 *
 *  Rule 2 "EMEA Region"
 *    IF   customer.country_code IN ("DE","AT","CH","FR","GB")
 *    THEN sales.region = "EMEA"
 *
 * Pricing Conditions (DISCOUNT type)
 * ───────────────────────────────────
 *  Condition 1 – 5 % for premium tier            (priority 100)
 *    Requires:  customer.tier = "premium"
 *
 *  Condition 2 – 3 % for EMEA region             (priority 200)
 *    Requires:  sales.region = "EMEA"
 *
 *  Condition 3 – 10 % for premium tier + EMEA    (priority 50)
 *    Requires:  customer.tier = "premium"
 *            AND sales.region = "EMEA"
 *
 * Test Scenarios
 * ──────────────
 *  A) revenue=1,500,000  country="DE"  → tier=premium, region=EMEA
 *     → all 3 discounts apply (10 %, 5 %, 3 % ordered by priority)
 *
 *  B) revenue=500,000    country="US"  → no derived attributes
 *     → no discounts
 *
 *  C) revenue=2,000,000  country="US"  → tier=premium only
 *     → Condition 1 only (5 %)
 *
 *  D) revenue=50,000     country="FR"  → region=EMEA only
 *     → Condition 2 only (3 %)
 *
 *  E) Deactivate Condition 1 while Scenario A facts are priced
 *     → only 10 % and 3 % discounts apply
 *
 *  F) Remove Condition 2 permanently, then re-price Scenario A
 *     → only 10 % and 5 % discounts remain
 * ─────────────────────────────────────────────────────────────────────────────
 */
"use strict";

// Patch pg Connection to suppress ref()/unref() errors thrown by pgmock's in-memory
// socket (NetLikeSocket). The pg-pool calls these to manage the Node.js event loop
// reference count; since pgmock doesn't implement them, we silence the error so the
// pool can manage multiple sequential queries normally.
const _pgConnection = require("pg/lib/connection");
const _origRef = _pgConnection.prototype.ref;
const _origUnref = _pgConnection.prototype.unref;
_pgConnection.prototype.ref = function () {
    try { if (_origRef) _origRef.call(this); } catch (_e) { /* pgmock limitation */ }
};
_pgConnection.prototype.unref = function () {
    try { if (_origUnref) _origUnref.call(this); } catch (_e) { /* pgmock limitation */ }
};

const { PostgresMock } = require("pgmock");
const { DB } = require("../lib/db/postgresDB");

jest.setTimeout(120000);

describe("DB with pgmock – B2B Software License Pricing", () => {
    let mock;
    let db;

    let condIdPremiumDiscount;   // 5 %  – premium tier only
    let condIdEmeaDiscount;      // 3 %  – EMEA region only
    let condIdPremiumEmeaDiscount; // 10 % – premium + EMEA combined

    const logger = {
        info: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn()
    };

    // ─── Helper: run pricing and return result ────────────────────────────────
    const price = (annualRevenue, countryCode) =>
        db.runPricing({
            facts: {
                "customer.annual_revenue": { valueNumber: annualRevenue },
                "customer.country_code":   { valueText: countryCode }
            },
            pricingDate: "2026-06-01",
            conditionTypes: ["DISCOUNT"]
        });

    // ─── Setup ────────────────────────────────────────────────────────────────
    beforeAll(async () => {
        // Start the in-memory PostgreSQL instance
        mock = await PostgresMock.create();
        const pgConfig = mock.getNodePostgresConfig();

        db = new DB({ logger, options: pgConfig });
        await db.connect();

        // ── Attribute Derivation Rule 1: Premium Reseller ──
        await db.addRule({
            ruleName: "Premium Reseller",
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

        // ── Attribute Derivation Rule 2: EMEA Region ──
        await db.addRule({
            ruleName: "EMEA Region",
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

        // ── Pricing Condition 1: 5 % discount – premium tier ──
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
        condIdPremiumDiscount = cond1.conditionId;

        // ── Pricing Condition 2: 3 % discount – EMEA region ──
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
        condIdEmeaDiscount = cond2.conditionId;

        // ── Pricing Condition 3: 10 % discount – premium + EMEA combined ──
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
        condIdPremiumEmeaDiscount = cond3.conditionId;
    });

    afterAll(async () => {
        await db.disconnect();
        // mock.destroy() calls the emulator's async destroy() without awaiting it,
        // so the CPU simulation timer loop keeps running. Awaiting it here first
        // stops that loop before handing off to the mock's synchronous cleanup.
        await mock.subtle.v86.destroy();
        mock.destroy();
    });

    // ─── Scenario A: Premium reseller in EMEA ────────────────────────────────
    describe("Scenario A – premium reseller in EMEA (revenue=1,500,000, country=DE)", () => {
        it("derives customer.tier=premium and sales.region=EMEA", async () => {
            const result = await price(1500000, "DE");

            expect(result).toHaveProperty("contextId");
            expect(result.attributes).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ attribute_key: "customer.tier", value_text: "premium" }),
                    expect.objectContaining({ attribute_key: "sales.region", value_text: "EMEA" })
                ])
            );
        });

        it("matches all three discount conditions ordered by priority", async () => {
            const result = await price(1500000, "DE");

            expect(result.conditions).toHaveLength(3);

            // Priority 50 → 10 %, Priority 100 → 5 %, Priority 200 → 3 %
            expect(Number(result.conditions[0].value_number)).toBe(10);
            expect(Number(result.conditions[1].value_number)).toBe(5);
            expect(Number(result.conditions[2].value_number)).toBe(3);

            expect(result.conditions[0].condition_type).toBe("DISCOUNT");
            expect(result.conditions[0].value_type).toBe("PERCENT");
        });
    });

    // ─── Scenario B: Standard reseller outside EMEA ──────────────────────────
    describe("Scenario B – standard reseller outside EMEA (revenue=500,000, country=US)", () => {
        it("derives no attributes and matches no discount conditions", async () => {
            const result = await price(500000, "US");

            expect(result.attributes).toHaveLength(0);
            expect(result.conditions).toHaveLength(0);
        });
    });

    // ─── Scenario C: Premium reseller outside EMEA ───────────────────────────
    describe("Scenario C – premium reseller outside EMEA (revenue=2,000,000, country=US)", () => {
        it("derives customer.tier=premium but not sales.region", async () => {
            const result = await price(2000000, "US");

            expect(result.attributes).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ attribute_key: "customer.tier", value_text: "premium" })
                ])
            );
            expect(result.attributes.map(a => a.attribute_key)).not.toContain("sales.region");
        });

        it("matches only the 5 % premium discount", async () => {
            const result = await price(2000000, "US");

            expect(result.conditions).toHaveLength(1);
            expect(Number(result.conditions[0].value_number)).toBe(5);
        });
    });

    // ─── Scenario D: Standard reseller in EMEA ───────────────────────────────
    describe("Scenario D – standard reseller in EMEA (revenue=50,000, country=FR)", () => {
        it("derives sales.region=EMEA but not customer.tier", async () => {
            const result = await price(50000, "FR");

            expect(result.attributes).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ attribute_key: "sales.region", value_text: "EMEA" })
                ])
            );
            expect(result.attributes.map(a => a.attribute_key)).not.toContain("customer.tier");
        });

        it("matches only the 3 % EMEA discount", async () => {
            const result = await price(50000, "FR");

            expect(result.conditions).toHaveLength(1);
            expect(Number(result.conditions[0].value_number)).toBe(3);
        });
    });

    // ─── Scenario E: Deactivate Condition 1 (5 % premium discount) ──────────
    describe("Scenario E – deactivate the 5 % premium discount", () => {
        it("deactivates Condition 1 and the 5 % discount no longer appears for a premium EMEA reseller", async () => {
            const { deactivated } = await db.deactivateCondition({ conditionId: condIdPremiumDiscount });
            expect(deactivated).toBe(true);

            const result = await price(1500000, "DE");

            const discounts = result.conditions.map(c => Number(c.value_number));
            expect(discounts).not.toContain(5);
            // 10 % (premium+EMEA) and 3 % (EMEA) still apply
            expect(discounts).toEqual(expect.arrayContaining([10, 3]));
        });

        it("reactivates Condition 1 and the 5 % discount reappears", async () => {
            const { activated } = await db.activateCondition({ conditionId: condIdPremiumDiscount });
            expect(activated).toBe(true);

            const result = await price(1500000, "DE");

            const discounts = result.conditions.map(c => Number(c.value_number));
            expect(discounts).toContain(5);
        });
    });

    // ─── Scenario F: Remove Condition 2 (3 % EMEA discount) permanently ─────
    describe("Scenario F – permanently remove the 3 % EMEA discount", () => {
        it("removes Condition 2 and confirms removal", async () => {
            const { removed } = await db.removeCondition({ conditionId: condIdEmeaDiscount });
            expect(removed).toBe(true);
        });

        it("no longer returns the 3 % discount after removal", async () => {
            const result = await price(1500000, "DE");

            const discounts = result.conditions.map(c => Number(c.value_number));
            expect(discounts).not.toContain(3);
            // 10 % (premium+EMEA) and 5 % (premium) still apply
            expect(discounts).toEqual(expect.arrayContaining([10, 5]));
            expect(result.conditions).toHaveLength(2);
        });

        it("the combined 10 % condition still matches (EMEA attribute is still derived)", async () => {
            const result = await price(1500000, "DE");

            expect(result.attributes).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ attribute_key: "sales.region", value_text: "EMEA" })
                ])
            );
            expect(result.conditions.some(c => Number(c.value_number) === 10)).toBe(true);
        });
    });
});
