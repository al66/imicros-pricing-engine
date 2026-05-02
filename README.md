# imicros-pricing-engine
Pricing engine [Moleculer](https://moleculer.services/index.html) service with PostgreSQL

## Overview

The pricing engine derives pricing-relevant attributes from raw business facts using configurable rules, and then matches those attributes against pricing conditions to determine applicable discounts, surcharges, or prices.

**Core concepts**

| Concept | Description |
|---|---|
| **Attribute derivation rule** | Maps raw facts (e.g. `customer.annual_revenue`) to pricing attributes (e.g. `customer.tier = "premium"`) using conditions. |
| **Pricing condition** | Grants a discount/surcharge/price when a set of requirements on derived attributes are satisfied. |
| **Pricing run** | Given a map of facts, derives all attributes iteratively (up to 10 levels) and returns all matching pricing conditions. |

---

## Documentation

- [Data Model](docs/data-model.md) – PostgreSQL schema reference for all tables, views, indexes, and operators.

---

## pgmock Integration Test

The file `test/pricing.pgmock.spec.js` uses [pgmock](https://github.com/stack-auth/pgmock) to run the entire database layer against an in-memory PostgreSQL instance – no external database is required.

### Scenario: B2B Software License Distributor – Discount Pricing

A software distributor configures discount conditions for its reseller partners. Raw business facts (annual revenue, country code) are first transformed into pricing attributes by attribute derivation rules, and then matched against pricing conditions.

#### Attribute Derivation Rules

| Rule | Condition | Derived Attribute |
|---|---|---|
| **Premium Reseller** | `customer.annual_revenue >= 1,000,000` EUR | `customer.tier = "premium"` |
| **EMEA Region** | `customer.country_code IN ("DE","AT","CH","FR","GB")` | `sales.region = "EMEA"` |

#### Pricing Conditions

| Condition | Discount | Requirement | Priority |
|---|---|---|---|
| **Condition 1** | 5 % | `customer.tier = "premium"` | 100 |
| **Condition 2** | 3 % | `sales.region = "EMEA"` | 200 |
| **Condition 3** | 10 % | `customer.tier = "premium"` **AND** `sales.region = "EMEA"` | 50 |

Lower priority numbers win (i.e. conditions are returned ordered by priority ascending).

#### Test Scenarios

| Scenario | Annual Revenue | Country | Derived Attributes | Applied Discounts |
|---|---|---|---|---|
| **A** | 1,500,000 | DE | `tier=premium`, `region=EMEA` | 10 %, 5 %, 3 % (all three) |
| **B** | 500,000 | US | *(none)* | *(none)* |
| **C** | 2,000,000 | US | `tier=premium` | 5 % only |
| **D** | 50,000 | FR | `region=EMEA` | 3 % only |

Additional scenarios test condition lifecycle management:

- **Scenario E** – deactivating Condition 1 (5 %) removes it from the result; reactivating it brings it back.
- **Scenario F** – permanently deleting Condition 2 (3 %) confirms it no longer appears, while the derived EMEA attribute (and the combined 10 % condition) remain unaffected.

### Running the Tests

```bash
# Unit tests only (uses Jest mocks, no database required)
npx jest test/pricing.spec.js

# Integration tests with pgmock (in-memory PostgreSQL)
npx jest test/pricing.pgmock.spec.js

# All tests
npm test
```

> **Note**: The pgmock test takes ~2 minutes because pgmock starts an in-memory PostgreSQL (PGlite/WASM) process. This is expected.

### pgmock Compatibility Notes

Two small adaptations are made to work with pgmock's in-memory PostgreSQL (PGlite):

1. **`stream` option in `pg.Pool`** – pgmock provides a custom `stream` factory function in its connection config. The `DB.connect()` method now forwards this option to `pg.Pool` so the pool uses the in-memory socket instead of a real TCP connection.

2. **`DATE::text` cast in generated column** – PGlite classifies the `date → text` cast as STABLE (not IMMUTABLE) because the output format depends on the `DateStyle` GUC. The `value_hash` generated column in `pricing_context_attribute` was updated to use `(value_date - DATE '1900-01-01')::text` (an integer day count) which is fully IMMUTABLE and semantically equivalent for deduplication.
