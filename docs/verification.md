# Development verification

Opening `index.html` needs only a modern browser. The tools below are for development and CI, not application runtime.

Requirements: Node.js 22+ and npm. On this Windows ARM64 workstation the browser suite uses installed Chrome. On Linux it uses Playwright Chromium. Set `PLAYWRIGHT_CHANNEL=chrome` to choose Chrome explicitly.

```sh
npm ci
npm test
# On Linux or when using bundled Chromium:
npx playwright install --with-deps chromium
npm run test:browser
```

The browser runner opens the real app from disk in an isolated browser context. It asserts user workflows, exported content, error behavior and mobile body width at 390/320 pixels. All imported sample data is fictional. Page/console errors fail the run; unexpected HTTP(S) requests are detected and fail the offline check. Relevant record-persistence and blocked-storage paths are covered in the record-keeping apps.

Logs, JSON results, downloads and workflow screenshots go to ignored `test-results/`. These generated files are local QA evidence, not user records or release contents. Pure unit checks use Node's built-in test runner and need no packages; Playwright is the pinned development dependency.

The `verify` workflow runs the locked install, unit checks and browser checks as required steps. It uploads browser evidence even after failure. A configured workflow is not evidence of a completed hosted run: Linux and Node 22 must be verified at the exact published commit. Local verified hardware is Windows ARM64, not an x86/x64 test matrix.
