# WP3B verification record

Verification date: 2026-10-17. Local runtime: Node 22.22.0, npm 10.9.9, Java 21. These checks use fixture projects and local services. They are not deployed staging or production evidence.

| Check | Result |
| --- | --- |
| `npm test -- --run` | 205 frontend files, 2,124 tests passed |
| `npm --prefix functions test` | 1,115 tests passed |
| `npm run lint`, `npm run typecheck` | Passed |
| `npm run test:staging` | 46 staging isolation/release safeguards passed |
| `npm run test:security` plus final affected-file rerun | All 401 unique current emulator tests passed across the full run and focused rerun; see details below |
| `node --test scripts/firebase/purchasing-monitoring*.test.mjs` | 11 activation/scenario safeguards passed |
| `node --test scripts/migrate-domain-settings.test.mjs` | 10 migration safeguards passed |
| `npm run test:restore` | Two-hotel Auth/Firestore/Storage emulator recovery passed, including permitted restored Storage reads |
| `npm run audit:policy` | Passed; all three audited runtime scopes reported zero vulnerabilities |
| `npm run build:test` and App Hosting build with explicit non-production fixture | Passed; existing bundle-size warnings remain |
| Locked operator runtime install and seven required SDK imports | Passed |
| Chromium desktop 1440×1000 and mobile 390×844 | Both passed: rendering, explicit staging caveat, hotel/process filters, acknowledgment retaining an open issue, truncation warning and explicit reviewed workflow closure; no horizontal overflow or runtime errors |

The browser loaded the actual changed components through a local Vite harness with mocked service responses. The screenshots below contain deliberately fictional staging observations. They demonstrate layout and interaction only. The actual cloud evaluator, transport acceptance and supplier delivery were not exercised.

- [Desktop incidents](hotelsuite-monitoring-incidents-desktop.png)
- [Mobile incidents](hotelsuite-monitoring-incidents-mobile.png)
- [Desktop hotel coverage](hotelsuite-monitoring-coverage-desktop.png)
- [Mobile hotel coverage](hotelsuite-monitoring-coverage-mobile.png)

The local execution sandbox initially prevented child test processes from exercising their tests normally; final runs used the environment's permitted network execution context and enumerated the individual tests. The Storage emulator also needed proxy variables removed for local cross-emulator calls because the CLI proxy agent ignored `NO_PROXY`. Those harness failures are not counted as successful checks.

The proxy-corrected full security run recorded 383 passed tests and two file-load failures because the collaboration/demo suites read a policy file while it was being edited. After code freeze, those two files and the final purchasing file were rerun together: all 28 tests passed, including the 11 purchasing regressions for concurrency, authorization, reviewed-alert replay and retention races. The 401 unique final tests are `383 - 10 earlier purchasing tests + 28 final tests`. This is full-suite coverage with targeted reruns, not a claim that the interrupted full command itself exited successfully. The final rerun was:

```bash
npx --no-install firebase emulators:exec --project demo-hotel-suite-a00 --only auth,firestore,storage \
  'node --test --test-concurrency=1 tests/security/collaboration-workflows.test.mjs tests/security/demo-data.test.mjs tests/security/purchasing-monitoring.test.mjs'
```

Live staging and production remain unverified. No Google Cloud identity was configured. The read-only staging scenario preflight stopped before writes. The GitHub Actions variables API returned HTTP 403, so the current production deployment-enable variable could not be read. Production and staging `plan` output was checked locally with fictional release identifiers; that establishes neither deployment nor activation. No production deployment, merge, data write, IAM update or external notification was performed. Follow the [release checklist](../../purchasing-monitoring-release.md) for actual activation and record live results separately.
