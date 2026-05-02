# Data Model

The pricing engine uses a PostgreSQL schema that separates **rule configuration**, **condition configuration**, and **per-request runtime data**.

## Overview

```
Raw Facts (input)
    ↓
Attribute Derivation Rules  →  Derived Pricing Attributes
    ↓
Pricing Condition Requirements  →  Matched Conditions (discounts / surcharges / prices …)
```

---

## Tables

### Rule Configuration

#### `attribute_rule`

Defines a rule that sets a target pricing attribute when all of its conditions match.

| Column | Type | Description |
|---|---|---|
| `rule_id` | `BIGSERIAL PK` | Auto-generated identifier |
| `rule_name` | `TEXT NOT NULL` | Human-readable name |
| `target_key` | `TEXT NOT NULL` | Attribute key to derive (e.g. `customer.tier`) |
| `target_text` | `TEXT` | Text value to assign |
| `target_number` | `NUMERIC` | Numeric value to assign |
| `target_date` | `DATE` | Date value to assign |
| `target_bool` | `BOOLEAN` | Boolean value to assign |
| `valid_from` | `DATE NOT NULL` | Start of validity (default `1900-01-01`) |
| `valid_to` | `DATE NOT NULL` | End of validity (default `9999-12-31`) |
| `priority` | `INT NOT NULL` | Evaluation priority (lower = first) |
| `active` | `BOOLEAN NOT NULL` | Whether the rule is active |
| `stop_processing` | `BOOLEAN NOT NULL` | Stop further rule evaluation after this rule fires |
| `condition_count` | `INT NOT NULL` | Cached count of conditions (used in HAVING clause) |

#### `attribute_rule_condition`

One row per condition that must be satisfied for the parent rule to fire.

| Column | Type | Description |
|---|---|---|
| `condition_id` | `BIGSERIAL PK` | Auto-generated identifier |
| `rule_id` | `BIGINT FK → attribute_rule` | Parent rule (CASCADE DELETE) |
| `source_key` | `TEXT NOT NULL` | Fact or attribute key to test (e.g. `customer.annual_revenue`) |
| `operator` | `TEXT NOT NULL` | Comparison operator (see [Operators](#operators)) |
| `value_type` | `TEXT NOT NULL` | Value type: `TEXT`, `NUMBER`, `DATE`, `BOOLEAN`, `NONE` |

#### `attribute_rule_condition_value`

Holds the comparison value(s) for `=`, `!=`, `IN`, `NOT_IN`, `>`, `>=`, `<`, `<=` operators.

| Column | Type | Description |
|---|---|---|
| `condition_id` | `BIGINT FK → attribute_rule_condition` | Parent condition (CASCADE DELETE) |
| `value_text` | `TEXT` | Text comparison value |
| `value_number` | `NUMERIC` | Numeric comparison value |
| `value_date` | `DATE` | Date comparison value |
| `value_bool` | `BOOLEAN` | Boolean comparison value |

#### `attribute_rule_condition_range`

Holds range bounds for `BETWEEN` operators.

| Column | Type | Description |
|---|---|---|
| `condition_id` | `BIGINT FK → attribute_rule_condition` | Parent condition (CASCADE DELETE) |
| `from_number` | `NUMERIC` | Lower numeric bound |
| `to_number` | `NUMERIC` | Upper numeric bound |
| `from_date` | `DATE` | Lower date bound |
| `to_date` | `DATE` | Upper date bound |

---

### Condition Configuration

#### `pricing_condition`

Defines a pricing condition (discount, surcharge, price, freight, …) and its value.

| Column | Type | Description |
|---|---|---|
| `condition_id` | `BIGSERIAL PK` | Auto-generated identifier |
| `condition_type` | `TEXT NOT NULL` | E.g. `DISCOUNT`, `SURCHARGE`, `PRICE`, `FREIGHT` |
| `value_type` | `TEXT NOT NULL` | E.g. `PERCENT`, `ABSOLUTE`, `FIXED_PRICE` |
| `value_number` | `NUMERIC NOT NULL` | The numeric value of the condition |
| `currency` | `TEXT` | ISO currency code (optional) |
| `priority` | `INT NOT NULL` | Sort order in results (lower = first) |
| `exclusive` | `BOOLEAN NOT NULL` | If `TRUE`, no other condition of the same type applies |
| `valid_from` | `DATE NOT NULL` | Start of validity (default `1900-01-01`) |
| `valid_to` | `DATE NOT NULL` | End of validity (default `9999-12-31`) |
| `active` | `BOOLEAN NOT NULL` | Whether the condition is active |
| `requirement_count` | `INT NOT NULL` | Cached count of requirements (used in HAVING clause) |

#### `pricing_condition_requirement`

One row per attribute requirement that must be satisfied for the condition to apply.

| Column | Type | Description |
|---|---|---|
| `requirement_id` | `BIGSERIAL PK` | Auto-generated identifier |
| `condition_id` | `BIGINT FK → pricing_condition` | Parent condition (CASCADE DELETE) |
| `attribute_key` | `TEXT NOT NULL` | Derived attribute key to test (e.g. `customer.tier`) |
| `operator` | `TEXT NOT NULL` | Comparison operator (see [Operators](#operators)) |
| `value_type` | `TEXT NOT NULL` | Value type: `TEXT`, `NUMBER`, `DATE`, `BOOLEAN`, `NONE` |

#### `pricing_condition_requirement_value`

Holds comparison value(s) for the requirement.

| Column | Type | Description |
|---|---|---|
| `requirement_id` | `BIGINT FK → pricing_condition_requirement` | Parent requirement (CASCADE DELETE) |
| `value_text` | `TEXT` | Text comparison value |
| `value_number` | `NUMERIC` | Numeric comparison value |
| `value_date` | `DATE` | Date comparison value |
| `value_bool` | `BOOLEAN` | Boolean comparison value |

#### `pricing_condition_requirement_range`

Holds range bounds for `BETWEEN` requirements.

| Column | Type | Description |
|---|---|---|
| `requirement_id` | `BIGINT FK → pricing_condition_requirement` | Parent requirement (CASCADE DELETE) |
| `from_number` | `NUMERIC` | Lower numeric bound |
| `to_number` | `NUMERIC` | Upper numeric bound |
| `from_date` | `DATE` | Lower date bound |
| `to_date` | `DATE` | Upper date bound |

---

### Runtime Data

Runtime tables are created for every pricing request and hold the input facts and the attributes derived during that request.

#### `pricing_context`

One row per pricing request.

| Column | Type | Description |
|---|---|---|
| `pricing_context_id` | `BIGSERIAL PK` | Auto-generated identifier |
| `article_id` | `BIGINT` | Optional article reference |
| `customer_id` | `BIGINT` | Optional customer reference |
| `sales_org` | `TEXT` | Optional sales organisation |
| `pricing_date` | `DATE NOT NULL` | The date used to evaluate rule and condition validity |
| `created_at` | `TIMESTAMPTZ NOT NULL` | Creation timestamp |

#### `pricing_context_fact`

Raw input facts for the pricing context. Each fact carries exactly one typed value column.

| Column | Type | Description |
|---|---|---|
| `pricing_context_id` | `BIGINT FK → pricing_context` | Parent context (CASCADE DELETE) |
| `fact_key` | `TEXT NOT NULL` | Fact name (e.g. `customer.annual_revenue`) |
| `value_text` | `TEXT` | Text value |
| `value_number` | `NUMERIC` | Numeric value |
| `value_date` | `DATE` | Date value |
| `value_bool` | `BOOLEAN` | Boolean value |
| `source` | `TEXT` | Optional label for the origin of the fact |
| `valid_from` | `DATE` | Optional start of fact validity |
| `valid_to` | `DATE` | Optional end of fact validity |

Primary key: `(pricing_context_id, fact_key)`.

#### `pricing_context_attribute`

Attributes derived by attribute rules during the pricing run.

| Column | Type | Description |
|---|---|---|
| `pricing_context_id` | `BIGINT FK → pricing_context` | Parent context (CASCADE DELETE) |
| `attribute_key` | `TEXT NOT NULL` | Derived attribute name (e.g. `customer.tier`) |
| `value_text` | `TEXT` | Text value |
| `value_number` | `NUMERIC` | Numeric value |
| `value_date` | `DATE` | Date value |
| `value_bool` | `BOOLEAN` | Boolean value |
| `source_rule_id` | `BIGINT` | The rule that produced this attribute |
| `derivation_level` | `INT NOT NULL` | Iteration depth at which the attribute was derived |
| `value_hash` | `TEXT` (generated, stored) | `md5` of the four value columns; used as the unique key |

Unique index: `(pricing_context_id, attribute_key, value_hash)`.

The `value_hash` column is computed as:

```sql
md5(
    coalesce(value_text, '')    || '|' ||
    coalesce(value_number::text, '') || '|' ||
    coalesce((value_date - DATE '1900-01-01')::text, '') || '|' ||
    coalesce(value_bool::text,  '')
)
```

> The date is converted to an integer day count (`value_date - DATE '1900-01-01'`) instead of a text cast to keep the expression fully IMMUTABLE (required by PostgreSQL for generated columns and compatible with PGlite/pgmock).

---

### View

#### `pricing_context_input`

A unified view over `pricing_context_fact` and `pricing_context_attribute`. Used during attribute derivation so that rules can reference both raw facts and previously derived attributes.

```sql
CREATE VIEW pricing_context_input AS
SELECT pricing_context_id, fact_key AS input_key, value_text, value_number, value_date, value_bool
FROM pricing_context_fact
UNION ALL
SELECT pricing_context_id, attribute_key AS input_key, value_text, value_number, value_date, value_bool
FROM pricing_context_attribute;
```

---

## Operators

The following operators are supported in both `attribute_rule_condition.operator` and `pricing_condition_requirement.operator`:

| Operator | Description | Value source |
|---|---|---|
| `=` | Equal | `_value` table |
| `!=` | Not equal | `_value` table |
| `IN` | Value is in set | `_value` table (multiple rows) |
| `NOT_IN` | Value is not in set | `_value` table (multiple rows) |
| `>` | Greater than | `_value` table |
| `>=` | Greater than or equal | `_value` table |
| `<` | Less than | `_value` table |
| `<=` | Less than or equal | `_value` table |
| `BETWEEN` | Value within inclusive range | `_range` table |
| `EXISTS` | Key is present in context | *(no value table needed)* |
| `NOT_EXISTS` | Key is absent from context | *(no value table needed)* |

---

## Indexes

| Index name | Table | Columns |
|---|---|---|
| `idx_rule_condition_source` | `attribute_rule_condition` | `(rule_id, source_key, operator, value_type)` |
| `idx_rule_value_text` | `attribute_rule_condition_value` | `(value_text, condition_id)` |
| `idx_rule_value_number` | `attribute_rule_condition_value` | `(value_number, condition_id)` |
| `idx_condition_active` | `pricing_condition` | `(active, condition_type, valid_from, valid_to, priority)` |
| `idx_req_key_operator` | `pricing_condition_requirement` | `(attribute_key, operator, value_type, condition_id, requirement_id)` |
| `idx_req_value_text` | `pricing_condition_requirement_value` | `(value_text, requirement_id)` |
| `idx_req_value_number` | `pricing_condition_requirement_value` | `(value_number, requirement_id)` |
| `idx_attr_ctx_key` | `pricing_context_attribute` | `(pricing_context_id, attribute_key)` |
| `idx_fact_ctx_key` | `pricing_context_fact` | `(pricing_context_id, fact_key)` |
| `ux_pricing_context_attribute` *(unique)* | `pricing_context_attribute` | `(pricing_context_id, attribute_key, value_hash)` |

---

## Entity-Relationship Diagram

```
┌──────────────────────────────────────┐
│           RULE CONFIGURATION         │
│                                      │
│  attribute_rule                      │
│  ├── attribute_rule_condition        │
│  │   ├── attribute_rule_condition_value  │
│  │   └── attribute_rule_condition_range │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│        CONDITION CONFIGURATION       │
│                                      │
│  pricing_condition                   │
│  ├── pricing_condition_requirement   │
│  │   ├── pricing_condition_requirement_value  │
│  │   └── pricing_condition_requirement_range  │
└──────────────────────────────────────┘

┌──────────────────────────────────────┐
│           RUNTIME DATA               │
│                                      │
│  pricing_context                     │
│  ├── pricing_context_fact            │
│  └── pricing_context_attribute       │
│                                      │
│  VIEW: pricing_context_input         │
│    (= fact UNION ALL attribute)      │
└──────────────────────────────────────┘
```
