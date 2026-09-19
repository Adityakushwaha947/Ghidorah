# Shared contract acceptance candidate

This is the first locally pinned implementation of the Agent specification's core 1.0.0, Oracle 3.0.0, registry 2.0.0 and ModelClient 1.0.0 definitions. It is not a claim that the frontend, Gyms or Model teams have accepted or deployed these interfaces. Episode export remains Gyms-owned; it is not redefined here.

After `npm run build`, TypeScript consumers import `gidorah/contracts`. This entry point imports only the portable contract modules and Zod, not Mastra, PostgreSQL or Node built-ins. Generated TypeScript declarations live beside those modules. The existing package name remains `gidorah` for compatibility; the product name is **Ghidorah**. Do not publish this private package before the team decides licensing and distribution.

`npm run contracts:build` emits `dist/contracts/schema.json`, a bundle of named draft-2020-12 JSON Schemas. Each entry under `schemas` is an independent schema document. Other languages may consume these documents for structural validation; this release does not generate or claim accepted Python bindings.

`manifest.json` pins the generated structural schemas, portable TypeScript implementation and existing canonical encoder. `npm run contracts:check` and the build fail on drift. To propose an intentional update, inspect `node --import tsx scripts/contracts.ts --fingerprint`, review the compatibility/version impact with consumers, update the manifest explicitly, and rerun the conformance tests. Never auto-refresh the manifest in CI.

## Boundaries

- Shared `FindingSchema` checks wire classification, state and receipt-field consistency. It does **not** authenticate a verifier, resolve artifacts or establish current authorization.
- Backend `src/foundation/findings.ts` adds digest checks and `admitIndependentVerification`, which requires independently trusted policy/authority and artifact resolvers. The frontend must receive committed backend events; accepting JSON is never permission to confirm a finding.
- `validateVerificationRequest` and `validateOracleVerdict` check the captured request and echoed identity. They are not an HTTP client, trusted-service authentication, registry freshness check or durable attempt journal. A structurally valid verdict still needs independent admission before it can change a finding.
- JSON Schema cannot express every cross-field check, state transition or authority rule. Consumers need the shared semantic fixtures and their own accepted implementation. Full event transition/reducer, report and Model round-trip acceptance remains open.
- The canonical encoder is deliberately unchanged to preserve existing digests. Its current key ordering uses `localeCompare(..., "en")`; it is **not** RFC 8785/JCS or Python's default `sort_keys`. Cross-language byte conformance and any versioned codec migration must be agreed before the Oracle transport is enabled.
- Declaring capabilities or API types does not enable execution. The backend still admits only `fixture://counter` with its synthetic model and rejects real targets, unimplemented tools and explicit USD caps.

## Verification

`npm run test:contracts` checks request/response validation, candidate and snapshot records, review bindings, every verification identity field, Oracle errors, model message linkage and the model-gateway foundation. All evidence and providers in these tests are synthetic. The existing finding-admission tests continue checking the backend's stronger trust boundary.
