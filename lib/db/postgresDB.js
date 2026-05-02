/**
 * @license MIT, imicros.de (c) 2026 Andreas Leinen
 */
"use strict";

const { Pool } = require("pg");

class DB {
    constructor({ logger, options = {} }) {
        this.logger = logger;
        this.options = options;
    }

    async connect() {
        this.pool = new Pool({
            host: this.options.host || process.env.POSTGRES_HOST || "localhost",
            port: this.options.port || process.env.POSTGRES_PORT || 5432,
            database: this.options.database || process.env.POSTGRES_DATABASE || "postgres",
            user: this.options.user || process.env.POSTGRES_USER || "postgres",
            password: this.options.password || process.env.POSTGRES_PASSWORD || "postgres",
            ...(this.options.stream && { stream: this.options.stream })
        });
        await this.createSchema();
        this.logger.info("Connected to PostgreSQL");
    }

    async disconnect() {
        if (this.pool) {
            await this.pool.end();
            this.logger.info("Disconnected from PostgreSQL");
        }
    }

    async createSchema() {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            await client.query(`
                CREATE TABLE IF NOT EXISTS attribute_rule (
                    rule_id        BIGSERIAL PRIMARY KEY,
                    rule_name      TEXT NOT NULL,
                    target_key     TEXT NOT NULL,
                    target_text    TEXT,
                    target_number  NUMERIC,
                    target_date    DATE,
                    target_bool    BOOLEAN,
                    valid_from     DATE NOT NULL DEFAULT DATE '1900-01-01',
                    valid_to       DATE NOT NULL DEFAULT DATE '9999-12-31',
                    priority       INT NOT NULL DEFAULT 100,
                    active         BOOLEAN NOT NULL DEFAULT TRUE,
                    stop_processing BOOLEAN NOT NULL DEFAULT FALSE,
                    condition_count INT NOT NULL DEFAULT 0
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS attribute_rule_condition (
                    condition_id BIGSERIAL PRIMARY KEY,
                    rule_id      BIGINT NOT NULL REFERENCES attribute_rule(rule_id) ON DELETE CASCADE,
                    source_key   TEXT NOT NULL,
                    operator     TEXT NOT NULL CHECK (operator IN ('=','!=','IN','NOT_IN','>','>=','<','<=','BETWEEN','EXISTS','NOT_EXISTS')),
                    value_type   TEXT NOT NULL CHECK (value_type IN ('TEXT','NUMBER','DATE','BOOLEAN','NONE'))
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS attribute_rule_condition_value (
                    condition_id BIGINT NOT NULL REFERENCES attribute_rule_condition(condition_id) ON DELETE CASCADE,
                    value_text   TEXT,
                    value_number NUMERIC,
                    value_date   DATE,
                    value_bool   BOOLEAN
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS attribute_rule_condition_range (
                    condition_id BIGINT NOT NULL REFERENCES attribute_rule_condition(condition_id) ON DELETE CASCADE,
                    from_number  NUMERIC,
                    to_number    NUMERIC,
                    from_date    DATE,
                    to_date      DATE
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS pricing_condition (
                    condition_id     BIGSERIAL PRIMARY KEY,
                    condition_type   TEXT NOT NULL,
                    value_type       TEXT NOT NULL,
                    value_number     NUMERIC NOT NULL,
                    currency         TEXT,
                    priority         INT NOT NULL DEFAULT 100,
                    exclusive        BOOLEAN NOT NULL DEFAULT FALSE,
                    valid_from       DATE NOT NULL DEFAULT DATE '1900-01-01',
                    valid_to         DATE NOT NULL DEFAULT DATE '9999-12-31',
                    active           BOOLEAN NOT NULL DEFAULT TRUE,
                    requirement_count INT NOT NULL DEFAULT 0
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS pricing_condition_requirement (
                    requirement_id BIGSERIAL PRIMARY KEY,
                    condition_id   BIGINT NOT NULL REFERENCES pricing_condition(condition_id) ON DELETE CASCADE,
                    attribute_key  TEXT NOT NULL,
                    operator       TEXT NOT NULL CHECK (operator IN ('=','!=','IN','NOT_IN','>','>=','<','<=','BETWEEN','EXISTS','NOT_EXISTS')),
                    value_type     TEXT NOT NULL CHECK (value_type IN ('TEXT','NUMBER','DATE','BOOLEAN','NONE'))
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS pricing_condition_requirement_value (
                    requirement_id BIGINT NOT NULL REFERENCES pricing_condition_requirement(requirement_id) ON DELETE CASCADE,
                    value_text     TEXT,
                    value_number   NUMERIC,
                    value_date     DATE,
                    value_bool     BOOLEAN
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS pricing_condition_requirement_range (
                    requirement_id BIGINT NOT NULL REFERENCES pricing_condition_requirement(requirement_id) ON DELETE CASCADE,
                    from_number    NUMERIC,
                    to_number      NUMERIC,
                    from_date      DATE,
                    to_date        DATE
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS pricing_context (
                    pricing_context_id BIGSERIAL PRIMARY KEY,
                    article_id         BIGINT,
                    customer_id        BIGINT,
                    sales_org          TEXT,
                    pricing_date       DATE NOT NULL,
                    created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS pricing_context_fact (
                    pricing_context_id BIGINT NOT NULL REFERENCES pricing_context(pricing_context_id) ON DELETE CASCADE,
                    fact_key           TEXT NOT NULL,
                    value_text         TEXT,
                    value_number       NUMERIC,
                    value_date         DATE,
                    value_bool         BOOLEAN,
                    source             TEXT,
                    valid_from         DATE,
                    valid_to           DATE,
                    PRIMARY KEY (pricing_context_id, fact_key)
                )
            `);
            await client.query(`
                CREATE TABLE IF NOT EXISTS pricing_context_attribute (
                    pricing_context_id BIGINT NOT NULL REFERENCES pricing_context(pricing_context_id) ON DELETE CASCADE,
                    attribute_key      TEXT NOT NULL,
                    value_text         TEXT,
                    value_number       NUMERIC,
                    value_date         DATE,
                    value_bool         BOOLEAN,
                    source_rule_id     BIGINT,
                    derivation_level   INT NOT NULL DEFAULT 0,
                    value_hash         TEXT GENERATED ALWAYS AS (
                        md5(
                            coalesce(value_text, '') || '|' ||
                            coalesce(value_number::text, '') || '|' ||
                            coalesce((value_date - DATE '1900-01-01')::text, '') || '|' ||
                            coalesce(value_bool::text, '')
                        )
                    ) STORED
                )
            `);
            // Create unique index for pricing_context_attribute
            await client.query(`
                CREATE UNIQUE INDEX IF NOT EXISTS ux_pricing_context_attribute
                ON pricing_context_attribute (pricing_context_id, attribute_key, value_hash)
            `);
            // Create the view
            await client.query(`
                CREATE OR REPLACE VIEW pricing_context_input AS
                SELECT pricing_context_id, fact_key AS input_key, value_text, value_number, value_date, value_bool
                FROM pricing_context_fact
                UNION ALL
                SELECT pricing_context_id, attribute_key AS input_key, value_text, value_number, value_date, value_bool
                FROM pricing_context_attribute
            `);
            // Create indexes
            await client.query(`CREATE INDEX IF NOT EXISTS idx_rule_condition_source ON attribute_rule_condition (rule_id, source_key, operator, value_type)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_rule_value_text ON attribute_rule_condition_value (value_text, condition_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_rule_value_number ON attribute_rule_condition_value (value_number, condition_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_condition_active ON pricing_condition (active, condition_type, valid_from, valid_to, priority)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_req_key_operator ON pricing_condition_requirement (attribute_key, operator, value_type, condition_id, requirement_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_req_value_text ON pricing_condition_requirement_value (value_text, requirement_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_req_value_number ON pricing_condition_requirement_value (value_number, requirement_id)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_attr_ctx_key ON pricing_context_attribute (pricing_context_id, attribute_key)`);
            await client.query(`CREATE INDEX IF NOT EXISTS idx_fact_ctx_key ON pricing_context_fact (pricing_context_id, fact_key)`);
            await client.query("COMMIT");
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
    }

    /**
     * Add a pricing condition with its requirements
     * @param {object} params
     * @param {string} params.conditionType - DISCOUNT, SURCHARGE, PRICE, FREIGHT
     * @param {string} params.valueType - PERCENT, ABSOLUTE, FIXED_PRICE
     * @param {number} params.valueNumber
     * @param {string} [params.currency]
     * @param {number} [params.priority=100]
     * @param {boolean} [params.exclusive=false]
     * @param {string} [params.validFrom]
     * @param {string} [params.validTo]
     * @param {object[]} [params.requirements=[]] - array of requirement objects:
     *   { attributeKey, operator, valueType, values: [{valueText, valueNumber, valueDate, valueBool}], range: {fromNumber, toNumber, fromDate, toDate} }
     * @returns {object} { conditionId }
     */
    async addCondition({ conditionType, valueType, valueNumber, currency = null, priority = 100, exclusive = false, validFrom = "1900-01-01", validTo = "9999-12-31", requirements = [] }) {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const condRes = await client.query(
                `INSERT INTO pricing_condition (condition_type, value_type, value_number, currency, priority, exclusive, valid_from, valid_to, active, requirement_count)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9) RETURNING condition_id`,
                [conditionType, valueType, valueNumber, currency, priority, exclusive, validFrom, validTo, requirements.length]
            );
            const conditionId = condRes.rows[0].condition_id;
            for (const req of requirements) {
                const reqRes = await client.query(
                    `INSERT INTO pricing_condition_requirement (condition_id, attribute_key, operator, value_type)
                     VALUES ($1, $2, $3, $4) RETURNING requirement_id`,
                    [conditionId, req.attributeKey, req.operator, req.valueType]
                );
                const requirementId = reqRes.rows[0].requirement_id;
                if (req.values && req.values.length > 0) {
                    for (const val of req.values) {
                        await client.query(
                            `INSERT INTO pricing_condition_requirement_value (requirement_id, value_text, value_number, value_date, value_bool)
                             VALUES ($1, $2, $3, $4, $5)`,
                            [requirementId, val.valueText || null, val.valueNumber !== undefined ? val.valueNumber : null, val.valueDate || null, val.valueBool !== undefined ? val.valueBool : null]
                        );
                    }
                }
                if (req.range) {
                    await client.query(
                        `INSERT INTO pricing_condition_requirement_range (requirement_id, from_number, to_number, from_date, to_date)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [requirementId, req.range.fromNumber || null, req.range.toNumber || null, req.range.fromDate || null, req.range.toDate || null]
                    );
                }
            }
            await client.query("COMMIT");
            return { conditionId: conditionId.toString() };
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
    }

    /**
     * Remove a pricing condition and all related data
     */
    async removeCondition({ conditionId }) {
        const result = await this.pool.query(
            `DELETE FROM pricing_condition WHERE condition_id = $1 RETURNING condition_id`,
            [conditionId]
        );
        return { removed: result.rowCount > 0 };
    }

    /**
     * Deactivate a pricing condition
     */
    async deactivateCondition({ conditionId }) {
        const result = await this.pool.query(
            `UPDATE pricing_condition SET active = FALSE WHERE condition_id = $1 RETURNING condition_id`,
            [conditionId]
        );
        return { deactivated: result.rowCount > 0 };
    }

    /**
     * Activate a pricing condition
     */
    async activateCondition({ conditionId }) {
        const result = await this.pool.query(
            `UPDATE pricing_condition SET active = TRUE WHERE condition_id = $1 RETURNING condition_id`,
            [conditionId]
        );
        return { activated: result.rowCount > 0 };
    }

    /**
     * Add an attribute rule with its conditions
     * @param {object} params
     * @param {string} params.ruleName
     * @param {string} params.targetKey - attribute key to set
     * @param {string} [params.targetText]
     * @param {number} [params.targetNumber]
     * @param {string} [params.targetDate]
     * @param {boolean} [params.targetBool]
     * @param {string} [params.validFrom]
     * @param {string} [params.validTo]
     * @param {number} [params.priority=100]
     * @param {object[]} [params.conditions=[]] - array of conditions:
     *   { sourceKey, operator, valueType, values: [{valueText, valueNumber, valueDate, valueBool}], range: {fromNumber, toNumber, fromDate, toDate} }
     * @returns {object} { ruleId }
     */
    async addRule({ ruleName, targetKey, targetText = null, targetNumber = null, targetDate = null, targetBool = null, validFrom = "1900-01-01", validTo = "9999-12-31", priority = 100, conditions = [] }) {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const ruleRes = await client.query(
                `INSERT INTO attribute_rule (rule_name, target_key, target_text, target_number, target_date, target_bool, valid_from, valid_to, priority, active, stop_processing, condition_count)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, TRUE, FALSE, $10) RETURNING rule_id`,
                [ruleName, targetKey, targetText, targetNumber, targetDate, targetBool, validFrom, validTo, priority, conditions.length]
            );
            const ruleId = ruleRes.rows[0].rule_id;
            for (const cond of conditions) {
                const condRes = await client.query(
                    `INSERT INTO attribute_rule_condition (rule_id, source_key, operator, value_type)
                     VALUES ($1, $2, $3, $4) RETURNING condition_id`,
                    [ruleId, cond.sourceKey, cond.operator, cond.valueType]
                );
                const conditionId = condRes.rows[0].condition_id;
                if (cond.values && cond.values.length > 0) {
                    for (const val of cond.values) {
                        await client.query(
                            `INSERT INTO attribute_rule_condition_value (condition_id, value_text, value_number, value_date, value_bool)
                             VALUES ($1, $2, $3, $4, $5)`,
                            [conditionId, val.valueText || null, val.valueNumber !== undefined ? val.valueNumber : null, val.valueDate || null, val.valueBool !== undefined ? val.valueBool : null]
                        );
                    }
                }
                if (cond.range) {
                    await client.query(
                        `INSERT INTO attribute_rule_condition_range (condition_id, from_number, to_number, from_date, to_date)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [conditionId, cond.range.fromNumber || null, cond.range.toNumber || null, cond.range.fromDate || null, cond.range.toDate || null]
                    );
                }
            }
            await client.query("COMMIT");
            return { ruleId: ruleId.toString() };
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
    }

    /**
     * Get all attribute rules, optionally filtered by targetKey
     * @param {object} params
     * @param {string} [params.targetKey]
     * @returns {object[]} array of rule rows
     */
    async getRules({ targetKey = null } = {}) {
        const columns = "rule_id, rule_name, target_key, target_text, target_number, target_date, target_bool, valid_from, valid_to, priority, active, condition_count";
        const orderBy = "ORDER BY priority ASC, rule_id ASC";
        if (targetKey) {
            const result = await this.pool.query(
                `SELECT ${columns} FROM attribute_rule WHERE target_key = $1 ${orderBy}`,
                [targetKey]
            );
            return result.rows;
        }
        const result = await this.pool.query(
            `SELECT ${columns} FROM attribute_rule ${orderBy}`
        );
        return result.rows;
    }

    /**
     * Remove an attribute rule and all related data
     * @param {object} params
     * @param {string} params.ruleId
     * @returns {object} { removed }
     */
    async removeRule({ ruleId }) {
        const result = await this.pool.query(
            `DELETE FROM attribute_rule WHERE rule_id = $1 RETURNING rule_id`,
            [ruleId]
        );
        return { removed: result.rowCount > 0 };
    }

    /**
     * Run the pricing engine
     * @param {object} params
     * @param {object} params.facts - key-value facts (e.g. { "customer.revenue": { valueNumber: 1500000 }, ... })
     * @param {string} [params.pricingDate] - ISO date string, defaults to today
     * @param {string[]} [params.conditionTypes] - array of types to return, e.g. ["DISCOUNT", "SURCHARGE"]
     * @param {number|null} [params.articleId]
     * @param {number|null} [params.customerId]
     * @param {string|null} [params.salesOrg]
     * @returns {object} { contextId, attributes, conditions }
     */
    async runPricing({ facts = {}, pricingDate = null, conditionTypes = null, articleId = null, customerId = null, salesOrg = null }) {
        const client = await this.pool.connect();
        try {
            await client.query("BEGIN");
            const date = pricingDate || new Date().toISOString().split("T")[0];
            // Create context
            const ctxRes = await client.query(
                `INSERT INTO pricing_context (article_id, customer_id, sales_org, pricing_date) VALUES ($1, $2, $3, $4) RETURNING pricing_context_id`,
                [articleId, customerId, salesOrg, date]
            );
            const contextId = ctxRes.rows[0].pricing_context_id;
            // Insert facts
            for (const [factKey, factValue] of Object.entries(facts)) {
                await client.query(
                    `INSERT INTO pricing_context_fact (pricing_context_id, fact_key, value_text, value_number, value_date, value_bool, source)
                     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (pricing_context_id, fact_key) DO NOTHING`,
                    [contextId, factKey, factValue.valueText || null, factValue.valueNumber !== undefined ? factValue.valueNumber : null, factValue.valueDate || null, factValue.valueBool !== undefined ? factValue.valueBool : null, factValue.source || null]
                );
            }
            // Iteratively derive attributes via rules (up to 10 iterations)
            let maxIterations = 10;
            let derivationLevel = 0;
            while (maxIterations-- > 0) {
                const inserted = await this._deriveAttributes(client, contextId, date, derivationLevel);
                if (inserted === 0) break;
                derivationLevel++;
            }
            // Find matching pricing conditions
            const matchedConditions = await this._findMatchingConditions(client, contextId, date, conditionTypes);
            // Get derived attributes for result
            const attrRes = await client.query(
                `SELECT attribute_key, value_text, value_number, value_date, value_bool, source_rule_id, derivation_level FROM pricing_context_attribute WHERE pricing_context_id = $1 ORDER BY derivation_level, attribute_key`,
                [contextId]
            );
            await client.query("COMMIT");
            return {
                contextId: contextId.toString(),
                attributes: attrRes.rows,
                conditions: matchedConditions
            };
        } catch (e) {
            await client.query("ROLLBACK");
            throw e;
        } finally {
            client.release();
        }
    }

    async _deriveAttributes(client, contextId, pricingDate, derivationLevel) {
        // Match attribute rules against pricing_context_input (facts + attributes)
        const sql = `
            WITH matched_rule_conditions AS (
                -- TEXT =
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN attribute_rule_condition_value v ON v.condition_id = rc.condition_id
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key AND f.value_text = v.value_text
                WHERE rc.operator = '=' AND rc.value_type = 'TEXT'
                UNION ALL
                -- TEXT IN
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN attribute_rule_condition_value v ON v.condition_id = rc.condition_id
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key AND f.value_text = v.value_text
                WHERE rc.operator = 'IN' AND rc.value_type = 'TEXT'
                UNION ALL
                -- TEXT !=
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN pricing_context_input f ON f.pricing_context_id = $1 AND f.input_key = rc.source_key
                WHERE rc.operator = '!=' AND rc.value_type = 'TEXT'
                  AND NOT EXISTS (
                    SELECT 1 FROM attribute_rule_condition_value v2
                    WHERE v2.condition_id = rc.condition_id AND v2.value_text = f.value_text
                  )
                UNION ALL
                -- NUMBER =
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN attribute_rule_condition_value v ON v.condition_id = rc.condition_id
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key AND f.value_number = v.value_number
                WHERE rc.operator = '=' AND rc.value_type = 'NUMBER'
                UNION ALL
                -- NUMBER >
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN attribute_rule_condition_value v ON v.condition_id = rc.condition_id
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key AND f.value_number > v.value_number
                WHERE rc.operator = '>' AND rc.value_type = 'NUMBER'
                UNION ALL
                -- NUMBER >=
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN attribute_rule_condition_value v ON v.condition_id = rc.condition_id
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key AND f.value_number >= v.value_number
                WHERE rc.operator = '>=' AND rc.value_type = 'NUMBER'
                UNION ALL
                -- NUMBER <
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN attribute_rule_condition_value v ON v.condition_id = rc.condition_id
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key AND f.value_number < v.value_number
                WHERE rc.operator = '<' AND rc.value_type = 'NUMBER'
                UNION ALL
                -- NUMBER <=
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN attribute_rule_condition_value v ON v.condition_id = rc.condition_id
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key AND f.value_number <= v.value_number
                WHERE rc.operator = '<=' AND rc.value_type = 'NUMBER'
                UNION ALL
                -- NUMBER BETWEEN
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN attribute_rule_condition_range r ON r.condition_id = rc.condition_id
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key AND f.value_number BETWEEN r.from_number AND r.to_number
                WHERE rc.operator = 'BETWEEN' AND rc.value_type = 'NUMBER'
                UNION ALL
                -- DATE BETWEEN
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN attribute_rule_condition_range r ON r.condition_id = rc.condition_id
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key AND f.value_date BETWEEN r.from_date AND r.to_date
                WHERE rc.operator = 'BETWEEN' AND rc.value_type = 'DATE'
                UNION ALL
                -- BOOLEAN =
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN attribute_rule_condition_value v ON v.condition_id = rc.condition_id
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key AND f.value_bool = v.value_bool
                WHERE rc.operator = '=' AND rc.value_type = 'BOOLEAN'
                UNION ALL
                -- EXISTS
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN pricing_context_input f
                  ON f.pricing_context_id = $1 AND f.input_key = rc.source_key
                WHERE rc.operator = 'EXISTS'
                UNION ALL
                -- NOT_EXISTS
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                WHERE rc.operator = 'NOT_EXISTS'
                  AND NOT EXISTS (
                    SELECT 1 FROM pricing_context_input f
                    WHERE f.pricing_context_id = $1 AND f.input_key = rc.source_key
                  )
                UNION ALL
                -- NOT_IN TEXT
                SELECT rc.rule_id, rc.condition_id
                FROM attribute_rule_condition rc
                JOIN pricing_context_input f ON f.pricing_context_id = $1 AND f.input_key = rc.source_key
                WHERE rc.operator = 'NOT_IN' AND rc.value_type = 'TEXT'
                  AND NOT EXISTS (
                    SELECT 1 FROM attribute_rule_condition_value v WHERE v.condition_id = rc.condition_id AND v.value_text = f.value_text
                  )
            ),
            matched_rules AS (
                SELECT m.rule_id
                FROM matched_rule_conditions m
                JOIN attribute_rule r ON r.rule_id = m.rule_id
                WHERE r.active = TRUE AND r.valid_from <= $2 AND r.valid_to > $2
                GROUP BY m.rule_id, r.condition_count
                HAVING COUNT(DISTINCT m.condition_id) = r.condition_count
            )
            INSERT INTO pricing_context_attribute (pricing_context_id, attribute_key, value_text, value_number, value_date, value_bool, source_rule_id, derivation_level)
            SELECT $1, r.target_key, r.target_text, r.target_number, r.target_date, r.target_bool, r.rule_id, $3
            FROM attribute_rule r
            JOIN matched_rules mr ON mr.rule_id = r.rule_id
            ON CONFLICT DO NOTHING
        `;
        const result = await client.query(sql, [contextId, pricingDate, derivationLevel]);
        return result.rowCount;
    }

    async _findMatchingConditions(client, contextId, pricingDate, conditionTypes) {
        const typeFilter = conditionTypes && conditionTypes.length > 0
            ? `AND c.condition_type = ANY($3::text[])`
            : "";
        const params = conditionTypes && conditionTypes.length > 0
            ? [contextId, pricingDate, conditionTypes]
            : [contextId, pricingDate];
        const sql = `
            WITH matched_requirements AS (
                -- TEXT =
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_condition_requirement_value v ON v.requirement_id = req.requirement_id
                JOIN pricing_context_attribute a
                  ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key AND a.value_text = v.value_text
                WHERE req.operator = '=' AND req.value_type = 'TEXT'
                UNION ALL
                -- TEXT IN
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_condition_requirement_value v ON v.requirement_id = req.requirement_id
                JOIN pricing_context_attribute a
                  ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key AND a.value_text = v.value_text
                WHERE req.operator = 'IN' AND req.value_type = 'TEXT'
                UNION ALL
                -- NUMBER =
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_condition_requirement_value v ON v.requirement_id = req.requirement_id
                JOIN pricing_context_attribute a
                  ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key AND a.value_number = v.value_number
                WHERE req.operator = '=' AND req.value_type = 'NUMBER'
                UNION ALL
                -- NUMBER >
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_condition_requirement_value v ON v.requirement_id = req.requirement_id
                JOIN pricing_context_attribute a
                  ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key AND a.value_number > v.value_number
                WHERE req.operator = '>' AND req.value_type = 'NUMBER'
                UNION ALL
                -- NUMBER >=
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_condition_requirement_value v ON v.requirement_id = req.requirement_id
                JOIN pricing_context_attribute a
                  ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key AND a.value_number >= v.value_number
                WHERE req.operator = '>=' AND req.value_type = 'NUMBER'
                UNION ALL
                -- NUMBER <
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_condition_requirement_value v ON v.requirement_id = req.requirement_id
                JOIN pricing_context_attribute a
                  ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key AND a.value_number < v.value_number
                WHERE req.operator = '<' AND req.value_type = 'NUMBER'
                UNION ALL
                -- NUMBER <=
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_condition_requirement_value v ON v.requirement_id = req.requirement_id
                JOIN pricing_context_attribute a
                  ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key AND a.value_number <= v.value_number
                WHERE req.operator = '<=' AND req.value_type = 'NUMBER'
                UNION ALL
                -- NUMBER BETWEEN
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_condition_requirement_range r ON r.requirement_id = req.requirement_id
                JOIN pricing_context_attribute a
                  ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key AND a.value_number BETWEEN r.from_number AND r.to_number
                WHERE req.operator = 'BETWEEN' AND req.value_type = 'NUMBER'
                UNION ALL
                -- DATE BETWEEN
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_condition_requirement_range r ON r.requirement_id = req.requirement_id
                JOIN pricing_context_attribute a
                  ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key AND a.value_date BETWEEN r.from_date AND r.to_date
                WHERE req.operator = 'BETWEEN' AND req.value_type = 'DATE'
                UNION ALL
                -- EXISTS
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_context_attribute a ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key
                WHERE req.operator = 'EXISTS'
                UNION ALL
                -- NOT_EXISTS
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                WHERE req.operator = 'NOT_EXISTS'
                  AND NOT EXISTS (
                    SELECT 1 FROM pricing_context_attribute a2
                    WHERE a2.pricing_context_id = $1 AND a2.attribute_key = req.attribute_key
                  )
                UNION ALL
                -- TEXT !=
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_context_attribute a ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key
                WHERE req.operator = '!=' AND req.value_type = 'TEXT'
                  AND NOT EXISTS (
                    SELECT 1 FROM pricing_condition_requirement_value v WHERE v.requirement_id = req.requirement_id AND v.value_text = a.value_text
                  )
                UNION ALL
                -- NOT_IN TEXT
                SELECT req.condition_id, req.requirement_id
                FROM pricing_condition_requirement req
                JOIN pricing_context_attribute a ON a.pricing_context_id = $1 AND a.attribute_key = req.attribute_key
                WHERE req.operator = 'NOT_IN' AND req.value_type = 'TEXT'
                  AND NOT EXISTS (
                    SELECT 1 FROM pricing_condition_requirement_value v WHERE v.requirement_id = req.requirement_id AND v.value_text = a.value_text
                  )
            )
            SELECT DISTINCT c.condition_id, c.condition_type, c.value_type, c.value_number, c.currency, c.priority, c.exclusive, c.valid_from, c.valid_to
            FROM matched_requirements m
            JOIN pricing_condition c ON c.condition_id = m.condition_id
            WHERE c.active = TRUE AND c.valid_from <= $2 AND c.valid_to > $2
            ${typeFilter}
            GROUP BY c.condition_id, c.condition_type, c.value_type, c.value_number, c.currency, c.priority, c.exclusive, c.valid_from, c.valid_to, c.requirement_count
            HAVING COUNT(DISTINCT m.requirement_id) = c.requirement_count
            ORDER BY c.priority ASC, c.condition_id ASC
        `;
        const result = await client.query(sql, params);
        return result.rows;
    }
}

module.exports = { DB };
