# Phase 0 — Fork hygiene: ESLint gate + dependency audit to zero

**Why:** the fork's gate fails on two rows that predate this feature: `pnpm eslint .` (no config) and `pnpm audit --audit-level=moderate` (98 vulns: 40 moderate, 47 high, 1 critical; identical on the base before Phase 2a). User decision (AskUserQuestion, 2026-11-07): fix first; Electron **43.8.3**; a dated ignore + ticket **#34** for minimatch/glob.
**Where:** done on branch `phase-2a-host-core` (the zod call sites come from 2a), as the 2a `/check` follow-up. **Agent:** `general-purpose`.
**Repo:** `/home/simon/projects/data-science/worktrees/weavit-projector`. Prefix every local pnpm command with `pnpm_config_verify_deps_before_run=false`.
**Age rule:** cutoff **2026-10-24** (≥ 2 weeks before 2026-11-07). Re-check every date with `npm view <pkg> time --json`.

## Findings that shape the work
1. **Electron 39 is not audit-clean** (39.8.10 still has 12 open advisories, ranges `<41.10.x`/`<42.11.16`, e.g. GHSA-jr5w-w6x2-84p9; 41.10.7 has 8). The first clean lines are 42.11.18, 43.8.3 and 44.9.3. **Pin 43.8.3.** 42 is EOL. Stay below 45: it deprecates `safeStorage.*` (`src/main/store/electronHost.ts`) and drops the Node shims in sandboxed preloads. Our Electron surface is about 15 calls; nothing in the 38→43 breaking changes touches it.
2. **minimatch/glob**: GHSA-g3hv-75wg-m249 (minimatch `>=7 <11.0.1`) and GHSA-3g3m-2fjr-6pw4 (glob `>=9 <=14.0.1`) are moderate. The fixes (minimatch 11.0.1, glob 14.0.2) were published 2026-10-27 and are too new. Ignore exactly these two IDs, dated, under tracker **#34**.
3. **pnpm 11 (local) vs pnpm 9 (CI):** pnpm 11 ignores `package.json#pnpm`. pnpm 9.15.9 throws `packages field missing or empty` on a `pnpm-workspace.yaml` without `packages`, so **CI install is already broken today.** Add `packages: ['.']` and write the overrides **identically in both** `pnpm-workspace.yaml` and `package.json#pnpm.overrides`.
4. **Electron ≥ 42 has no postinstall**; the binary downloads on demand (`install-electron`). Set `allowBuilds.electron: false`. electron-vite `dev`/`start` throw `Electron uninstall` until `pnpm electron:install` has run once; `build`/`web:build` don't need it.

## Exact versions (direct, `--save-exact`)
| Package | From | To | Published |
|---|---|---|---|
| electron | ^37.2.0 (37.10.3) | `43.8.3` | 2026-10-21 |
| electron-builder | ^25.1.8 | `26.18.0` | 2026-10-20 |
| zod | ^3.24.1 (3.25.76) | `4.6.7` | 2026-10-12 |
| eslint | — | `10.13.0` | 2026-10-16 |
| typescript-eslint | — | `8.72.0` | 2026-10-19 |
| eslint-plugin-react-hooks | — | `7.1.1` | 2026-04-17 |
Too new, do not use: electron-builder 26.18.1, eslint 10.14.0, typescript-eslint 8.72.1, electron 43.8.4.

## Overrides (range selectors; same map in both files)
| Selector | → | Published |
|---|---|---|
| `nanoid@<3.3.18` | `3.3.20` | 2026-10-05 |
| `source-map-js@<1.2.2` | `1.2.2` | 2026-09-30 |
| `tar@<7.5.21` | `7.5.22` | 2026-07-24 |
| `js-yaml@>=4.0.0 <4.3.2` / `js-yaml@>=3.0.0 <3.15.2` | `4.3.2` / `3.15.2` | 2026-08-26 |
| `@xmldom/xmldom@>=0.9.0 <0.9.12` / `@xmldom/xmldom@>=0.7.0 <0.8.15` | `0.9.12` / `0.8.15` | 2026-08-21 |
| `ip-address@<10.7.4` | `10.7.4` | 2026-10-11 |
| `brace-expansion@<1.1.21` / `@>=2.0.0 <2.1.7` / `@>=3.0.0 <3.0.9` / `@>=4.0.0 <5.0.12` | `1.1.21` / `2.1.7` / `3.0.9` / `5.0.12` | 2026-09-14 |
| `postcss-selector-parser@>=7.0.0 <7.1.6` | `7.1.6` | 2026-09-03 |
| `@grpc/grpc-js@>=1.14.0 <1.14.5` | `1.14.6` | 2026-10-08 |
| `builder-util-runtime@<9.7.0` | `9.7.0` | 2026-06-05 |
| `electron>@types/node` | `22.20.1` | 2026-07-08 |
extract-zip has no patched version; it disappears with electron 43 (`@electron-internal/extract-zip`). The `@types/node` override avoids a second copy under the hoisted linker.

## Files
- **`pnpm-workspace.yaml`** (replace): `packages: ['.']`; `allowBuilds: {electron: false, protobufjs: false}`; `minimumReleaseAge: 20160`; `minimumReleaseAgeStrict: true`; `overrides: {the 15 selectors above}`; `auditConfig.ignoreGhsas: [GHSA-g3hv-75wg-m249, GHSA-3g3m-2fjr-6pw4]`, with the comment `# TODO(#34): remove on/after 2026-11-11 (minimatch 11.0.1 / glob 14.0.2 clear the 14-day rule 2026-11-10)`. Any new `allowBuilds` placeholder → `false` unless the build needs it, and list it.
- **`package.json`**: the six exact devDeps; scripts `"lint": "eslint ."` and `"electron:install": "install-electron"`; `"pnpm": {"overrides": {…byte-identical map…}}`.
- **`eslint.config.js`** (new, CommonJS):
  - `defineConfig` with `globalIgnores(['out/**','dist/**','release/**','coverage/**','docs/**','resources/**','native/**','.harness/**'])` and `linterOptions.reportUnusedDisableDirectives: 'warn'`.
  - For `**/*.{ts,tsx}`: `tseslint.configs.recommended`, plus `@typescript-eslint/no-unused-vars: ['error', {argsIgnorePattern:'^_', varsIgnorePattern:'^_', caughtErrorsIgnorePattern:'^_'}]`.
  - For `src/renderer/**/*.{ts,tsx}`: `react-hooks/rules-of-hooks: 'error'` and `react-hooks/exhaustive-deps: 'warn'`.
  - Rule decisions:
    - `no-explicit-any` stays error. The 10 files that use `any` already carry the disable directive.
    - `exhaustive-deps` is warn, because changing dependency arrays changes runtime behaviour.
    - The React-Compiler rules of react-hooks 7, `@eslint/js` recommended, the type-checked presets and `consistent-type-imports` are off.
    - Calibration: if a recommended rule has ≤ 3 hits, fix them only by deleting dead code; otherwise set it to `warn` and record it in IMPLEMENTATION_NOTES.md. If `rules-of-hooks` fires, STOP and report.
- **`src/renderer/src/app/TopBar.tsx:1`**: remove the unused `Badge` import.
- **`.pre-commit-config.yaml`**: add an `eslint` hook (`pnpm lint`, language system, `pass_filenames: false`, `always_run: true`, stage pre-push) after `typecheck`.
- **`.github/workflows/ci.yml`**: in job `check`, add `- run: pnpm lint` after typecheck. Keep pnpm 9. Do not add `pnpm audit` to CI (pnpm 9 does not read `auditConfig`).
- **`CONTRIBUTING.md:20`**: after `pnpm install`, add `pnpm electron:install   # once: Electron ≥42 downloads its binary on demand`.
- **`CHANGELOG.md`** `[Unreleased]`: "Electron 43, electron-builder 26, zod 4; ESLint config; audit clean".
- **`electron-builder.yml`, `build/adhoc-sign-mac.cjs`**: no change expected (26 only moved `win.sign*` and `linux.desktop`, which we don't use). Verify with `pnpm pack:dir`.

## zod 4 call sites (expected: 0 code edits, 1 new test)
Unchanged:
- `protocol.ts`: discriminatedUnion, literal, enum, union, regex with a string message, `safeParse`, `issues[0].path.join('.')`.
- `validate.ts`:
  - the `z.enum(…) satisfies z.ZodType<…>` unions;
  - `z.custom<FilterNode>(fn, msg)`;
  - `.strict()` (deprecated but works);
  - `z.number().finite()` (a no-op in v4);
  - `scopeSchema.keyof().options`.

Only the error wording changes; no test asserts zod's message text.

One behaviour change: the `statusArgsSchema` tuple with an optional trailing element now accepts `['j']`. Add `expect(statusArgsSchema.safeParse(['j']).success).toBe(true)` to `validate.test.ts`.

If `tsc` disagrees with any row, fix it and record the line count. The budget is 50 lines.

## Steps
1. Write the workspace file (without overrides) and the six devDeps, then run `pnpm install`. If `minimumReleaseAgeStrict` blocks a package, pin its parent one patch lower and record it.
2. Add the identical overrides to both files and run `pnpm install`. Then run `pnpm why zod minimatch glob tar extract-zip @types/node nanoid`.
3. Run `pnpm audit --audit-level=moderate`. If a new advisory appears in the electron-builder 26 tree, override it only with a patched version published on or before 2026-10-24; otherwise STOP and report. Never ignore any other GHSA.
4. Remove `Badge`, add the ESLint config, run `pnpm lint`, and calibrate.
5. Add the zod test. Run `pnpm typecheck`, `pnpm test:coverage`, `pnpm build` and `pnpm web:build`.
6. Run `pnpm electron:install`. Smoke `pnpm dev` if a display is available; on WSL without a display, run `pnpm exec electron --version` and record that the GUI smoke is pending. Then run `pnpm pack:dir`.
7. Add the pre-commit hook and the CI step.
8. Check pnpm 9 compatibility: `git clone` the tree to the scratchpad, commit the working changes into the clone first, then run `npx -y pnpm@9.15.9 install --frozen-lockfile --ignore-scripts`.

## Acceptance (Given → expected)
1. `pnpm audit --audit-level=moderate` → exit 0. The only suppressed IDs are the two above.
2. `pnpm audit --json` with the ignores removed → the only moderate-or-higher advisories left are those two IDs.
3. `pnpm why zod` → only 4.6.7. `pnpm why extract-zip` → not found. `tar` → only versions ≥ 7.5.21. `@types/node` → only 22.20.1.
4. Every pinned or overridden version → published on or before 2026-10-24.
5. `pnpm eslint .` and `pnpm lint` → exit 0, with warnings only from `exhaustive-deps` or unused directives. A scratch `const x: any = 1` makes lint exit 1, and so does a conditional hook in the renderer. Revert both.
6. `pnpm typecheck` → 0. `pnpm test:coverage` passes (lines ≥ 70 %) and includes the new tuple test.
7. `pnpm build` writes `out/{main,preload,renderer}`. `pnpm web:build` → 0.
8. `pnpm exec electron --version` → `v43.8.3`. `pnpm pack:dir` → `release/*/linux-unpacked/` exists.
9. `pre-commit run --all-files --hook-stage pre-push` passes, including the eslint hook.
10. The pnpm 9.15.9 frozen install → exit 0, with no `ERR_PNPM_LOCKFILE_CONFIG_MISMATCH` and no `packages field missing`.
11. Source changes are limited to `TopBar.tsx` (1 line), `validate.test.ts` (+1 line) and any zod fixes, ≤ 50 lines in total.

## Fallbacks
- **Electron:** if 43.8.3 needs more than about 50 lines of code changes, fall back to `42.11.18` (2026-10-21) and record it. If 42 also fails, STOP. Never ignore the electron advisories.
- **electron-builder:** if 26.18.0 breaks `pack:dir`, try 26.17.0 (2026-09-26), then 26.15.7 (2026-07-18).
- **pnpm split:** if pnpm 9 still reports a config mismatch, pin CI and `release.yml` to pnpm `11.28.8` (2026-10-22). In that case drop `package.json#pnpm` and keep only the workspace file.

## Risks
- The electron-builder 26 tree is unverified, so new transitive advisories may show up (step 3).
- `minimumReleaseAgeStrict` can block an install.
- The two override maps can drift apart; acceptance 10 catches it.
- The ignores persist until #34 is done.
- zod 4 changes the user-visible error wording.
- Electron 43 visual check on Linux/macOS before release.
- Electron ≥ 45 requires replacing `safeStorage`.
