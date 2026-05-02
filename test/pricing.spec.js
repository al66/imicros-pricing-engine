/**
 * @license MIT, imicros.de (c) 2026 Andreas Leinen
 */
"use strict";

const { ServiceBroker } = require("moleculer");
const PricingService = require("../lib/services/pricing");
const { DB } = require("../lib/db/postgresDB");

// Mock the DB class
jest.mock("../lib/db/postgresDB");

describe("PricingService", () => {
    let broker;
    let mockDbInstance;

    beforeAll(async () => {
        // Create mock DB instance
        mockDbInstance = {
            connect: jest.fn().mockResolvedValue(),
            disconnect: jest.fn().mockResolvedValue(),
            addCondition: jest.fn().mockResolvedValue({ conditionId: "1001" }),
            removeCondition: jest.fn().mockResolvedValue({ removed: true }),
            deactivateCondition: jest.fn().mockResolvedValue({ deactivated: true }),
            activateCondition: jest.fn().mockResolvedValue({ activated: true }),
            runPricing: jest.fn().mockResolvedValue({
                contextId: "1",
                attributes: [
                    { attribute_key: "customer.segment", value_text: "grosskunde", derivation_level: 0 },
                    { attribute_key: "sales.region", value_text: "rheinmain-taunus", derivation_level: 0 }
                ],
                conditions: [
                    { condition_id: "1001", condition_type: "DISCOUNT", value_type: "PERCENT", value_number: "5.00", priority: 100 }
                ]
            }),
            addRule: jest.fn().mockResolvedValue({ ruleId: "2001" })
        };
        DB.mockImplementation(() => mockDbInstance);

        broker = new ServiceBroker({ logger: false });
        broker.createService(PricingService);
        await broker.start();
    });

    afterAll(async () => {
        await broker.stop();
    });

    describe("addCondition", () => {
        it("should add a condition and return conditionId", async () => {
            const result = await broker.call("pricing.addCondition", {
                conditionType: "DISCOUNT",
                valueType: "PERCENT",
                valueNumber: 5,
                priority: 100,
                validFrom: "2026-01-01",
                validTo: "2027-01-01",
                requirements: [
                    {
                        attributeKey: "customer.segment",
                        operator: "=",
                        valueType: "TEXT",
                        values: [{ valueText: "grosskunde" }]
                    },
                    {
                        attributeKey: "sales.region",
                        operator: "=",
                        valueType: "TEXT",
                        values: [{ valueText: "rheinmain-taunus" }]
                    }
                ]
            });
            expect(result).toEqual({ conditionId: "1001" });
            expect(mockDbInstance.addCondition).toHaveBeenCalledWith(expect.objectContaining({
                conditionType: "DISCOUNT",
                valueType: "PERCENT",
                valueNumber: 5
            }));
        });
    });

    describe("removeCondition", () => {
        it("should remove a condition", async () => {
            const result = await broker.call("pricing.removeCondition", { conditionId: "1001" });
            expect(result).toEqual({ removed: true });
            expect(mockDbInstance.removeCondition).toHaveBeenCalledWith({ conditionId: "1001" });
        });
    });

    describe("deactivateCondition", () => {
        it("should deactivate a condition", async () => {
            const result = await broker.call("pricing.deactivateCondition", { conditionId: "1001" });
            expect(result).toEqual({ deactivated: true });
            expect(mockDbInstance.deactivateCondition).toHaveBeenCalledWith({ conditionId: "1001" });
        });
    });

    describe("activateCondition", () => {
        it("should activate a condition", async () => {
            const result = await broker.call("pricing.activateCondition", { conditionId: "1001" });
            expect(result).toEqual({ activated: true });
            expect(mockDbInstance.activateCondition).toHaveBeenCalledWith({ conditionId: "1001" });
        });
    });

    describe("addRule", () => {
        it("should add an attribute rule and return ruleId", async () => {
            const result = await broker.call("pricing.addRule", {
                ruleName: "Großkunde aus Umsatz und Vertrag",
                targetKey: "customer.segment",
                targetText: "grosskunde",
                validFrom: "2026-01-01",
                validTo: "2027-01-01",
                priority: 100,
                conditions: [
                    {
                        sourceKey: "customer.revenue",
                        operator: ">=",
                        valueType: "NUMBER",
                        values: [{ valueNumber: 1000000 }]
                    },
                    {
                        sourceKey: "customer.contract_type",
                        operator: "=",
                        valueType: "TEXT",
                        values: [{ valueText: "framework" }]
                    }
                ]
            });
            expect(result).toEqual({ ruleId: "2001" });
            expect(mockDbInstance.addRule).toHaveBeenCalledWith(expect.objectContaining({
                ruleName: "Großkunde aus Umsatz und Vertrag",
                targetKey: "customer.segment",
                targetText: "grosskunde"
            }));
        });
    });

    describe("runPricing", () => {
        it("should run pricing and return derived attributes and matched conditions", async () => {
            const result = await broker.call("pricing.runPricing", {
                facts: {
                    "customer.revenue": { valueNumber: 1500000 },
                    "customer.contract_type": { valueText: "framework" },
                    "customer.postal_code": { valueNumber: 65203 },
                    "product.type": { valueText: "regenschirm" }
                },
                pricingDate: "2026-06-01",
                conditionTypes: ["DISCOUNT"]
            });
            expect(result).toHaveProperty("contextId");
            expect(result).toHaveProperty("attributes");
            expect(result).toHaveProperty("conditions");
            expect(Array.isArray(result.attributes)).toBe(true);
            expect(Array.isArray(result.conditions)).toBe(true);
            // Verify derived attributes
            expect(result.attributes).toEqual(expect.arrayContaining([
                expect.objectContaining({ attribute_key: "customer.segment", value_text: "grosskunde" })
            ]));
            // Verify matched conditions
            expect(result.conditions).toEqual(expect.arrayContaining([
                expect.objectContaining({ condition_type: "DISCOUNT", value_type: "PERCENT" })
            ]));
        });

        it("should call runPricing with correct params", async () => {
            const params = {
                facts: { "customer.revenue": { valueNumber: 1500000 } },
                pricingDate: "2026-06-01",
                conditionTypes: ["DISCOUNT"],
                customerId: 42,
                articleId: 100,
                salesOrg: "DE01"
            };
            await broker.call("pricing.runPricing", params);
            expect(mockDbInstance.runPricing).toHaveBeenCalledWith(expect.objectContaining({
                pricingDate: "2026-06-01",
                conditionTypes: ["DISCOUNT"],
                customerId: 42,
                articleId: 100,
                salesOrg: "DE01"
            }));
        });
    });
});
