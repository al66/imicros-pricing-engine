/**
 * @license MIT, imicros.de (c) 2026 Andreas Leinen
 */
"use strict";

const { DB } = require("../db/postgresDB");

module.exports = {
    name: "pricing",

    settings: {},
    metadata: {},
    dependencies: [],

    actions: {
        /**
         * Add a pricing condition
         * @param {string} conditionType - DISCOUNT, SURCHARGE, PRICE, FREIGHT
         * @param {string} valueType - PERCENT, ABSOLUTE, FIXED_PRICE
         * @param {number} valueNumber
         * @param {string} [currency]
         * @param {number} [priority=100]
         * @param {boolean} [exclusive=false]
         * @param {string} [validFrom]
         * @param {string} [validTo]
         * @param {object[]} [requirements=[]]
         * @returns {object} { conditionId }
         */
        addCondition: {
            params: {
                conditionType: { type: "string" },
                valueType: { type: "string" },
                valueNumber: { type: "number" },
                currency: { type: "string", optional: true },
                priority: { type: "number", optional: true },
                exclusive: { type: "boolean", optional: true },
                validFrom: { type: "string", optional: true },
                validTo: { type: "string", optional: true },
                requirements: { type: "array", optional: true }
            },
            async handler(ctx) {
                return this.db.addCondition(ctx.params);
            }
        },

        /**
         * Remove a pricing condition
         * @param {string} conditionId
         * @returns {object} { removed }
         */
        removeCondition: {
            params: {
                conditionId: { type: "string" }
            },
            async handler(ctx) {
                return this.db.removeCondition(ctx.params);
            }
        },

        /**
         * Deactivate a pricing condition
         * @param {string} conditionId
         * @returns {object} { deactivated }
         */
        deactivateCondition: {
            params: {
                conditionId: { type: "string" }
            },
            async handler(ctx) {
                return this.db.deactivateCondition(ctx.params);
            }
        },

        /**
         * Activate a pricing condition
         * @param {string} conditionId
         * @returns {object} { activated }
         */
        activateCondition: {
            params: {
                conditionId: { type: "string" }
            },
            async handler(ctx) {
                return this.db.activateCondition(ctx.params);
            }
        },

        /**
         * Run the pricing engine
         * @param {object} facts - key-value facts
         * @param {string} [pricingDate]
         * @param {string[]} [conditionTypes]
         * @param {number} [articleId]
         * @param {number} [customerId]
         * @param {string} [salesOrg]
         * @returns {object} { contextId, attributes, conditions }
         */
        runPricing: {
            params: {
                facts: { type: "object" },
                pricingDate: { type: "string", optional: true },
                conditionTypes: { type: "array", optional: true },
                articleId: { type: "number", optional: true },
                customerId: { type: "number", optional: true },
                salesOrg: { type: "string", optional: true }
            },
            async handler(ctx) {
                return this.db.runPricing(ctx.params);
            }
        },

        /**
         * Add an attribute rule (for deriving pricing attributes from facts)
         * @param {string} ruleName
         * @param {string} targetKey
         * @param {string} [targetText]
         * @param {number} [targetNumber]
         * @param {string} [targetDate]
         * @param {boolean} [targetBool]
         * @param {string} [validFrom]
         * @param {string} [validTo]
         * @param {number} [priority=100]
         * @param {object[]} [conditions=[]]
         * @returns {object} { ruleId }
         */
        addRule: {
            params: {
                ruleName: { type: "string" },
                targetKey: { type: "string" },
                targetText: { type: "string", optional: true },
                targetNumber: { type: "number", optional: true },
                targetDate: { type: "string", optional: true },
                targetBool: { type: "boolean", optional: true },
                validFrom: { type: "string", optional: true },
                validTo: { type: "string", optional: true },
                priority: { type: "number", optional: true },
                conditions: { type: "array", optional: true }
            },
            async handler(ctx) {
                return this.db.addRule(ctx.params);
            }
        },

        /**
         * Get all attribute rules
         * @param {string} [targetKey] - optional filter by target key
         * @returns {object[]} array of rules
         */
        getRules: {
            params: {
                targetKey: { type: "string", optional: true }
            },
            async handler(ctx) {
                return this.db.getRules(ctx.params);
            }
        },

        /**
         * Remove an attribute rule
         * @param {string} ruleId
         * @returns {object} { removed }
         */
        removeRule: {
            params: {
                ruleId: { type: "string" }
            },
            async handler(ctx) {
                return this.db.removeRule(ctx.params);
            }
        }
    },

    events: {},
    methods: {},

    created() {
        this.db = new DB({ logger: this.broker.logger, options: this.settings?.db });
    },

    async started() {
        await this.db.connect();
    },

    async stopped() {
        await this.db.disconnect();
    }
};
