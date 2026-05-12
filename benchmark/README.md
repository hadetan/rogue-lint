# Benchmark Harness

The benchmark harness runs `rogue-lint` against real-project corpora installed locally under this repository.

## Purpose

The benchmark exists to surface capability debt on real code:
- conservative skips the engine still produces
- regression anchors we must not lose or reintroduce
- unexpected current findings, skips, or diagnostics that still need engine work

See `benchmark/GAP_INVENTORY.md` for the checked-in classification of every family surfaced by the latest real-world benchmark run.

The command is always:

```bash
npm run benchmark
```

The command stays offline. It only uses local corpora that already exist under `benchmark/corpus/`.

If no local corpus is installed, the benchmark prints an informative report and exits with code `0`.

## Layout

```text
benchmark/
├── corpus/                # local gitignored corpora
├── suites/                # repository-managed benchmark target manifests
│   ├── default/
│   └── real-world/
└── README.md
```

## Installing A Local Corpus

1. Inspect the target manifest under `benchmark/suites/` to find the expected local corpus path.
2. Clone the corresponding repository into that path.
3. Run `npm run benchmark`.

The harness does not clone or update corpora for you.

## Adding Another Benchmark Repository

1. Add a new manifest JSON file under `benchmark/suites/real-world/`.
2. Point `localCorpusPath` at a folder under `benchmark/corpus/`.
3. Set `targetPath`, `mode`, and any include/exclude filters needed for the production code you want to benchmark.
4. Add required expectations first; only add accepted capability-debt entries if you intentionally want bounded debt instead of raw unexpected output.
5. Clone the repository into the declared local corpus path.
6. Run `npm run benchmark`.

Example placeholder repository layout:

```text
benchmark/corpus/example-repo
```

Example placeholder clone command:

```bash
git clone https://github.com/example/example-repo benchmark/corpus/example-repo
```

## Manifest Fields

Each manifest can define:
- repository metadata (`url`, `ref`)
- `coverageClass`
- `localCorpusPath`
- optional `targetPath`
- optional analyzer config overrides such as `mode`, `include`, `exclude`, `entrypoints`, and `hiddenRoots`
- `mustFind`, `mustNotFind`, `mustSkip`, `mustDiagnose`, `mustNotDiagnose`
- `mustNotSkip`
- `acceptedFindings`, `knownSkips`
- optional count bounds on expectation matchers via `minCount` and `maxCount`

Coverage classes currently used by the suite are:
- `workspace-monorepo-subproject`
- `library-public-surface`
- `application-entrypoint-driven`

The current suite represents:
- `workspace-monorepo-subproject`: `zod-main`
- `library-public-surface`: `dayjs-core`

The current suite is still missing:
- `application-entrypoint-driven`

Required expectations determine benchmark success. A target with no required expectations is treated as an incomplete benchmark contract and does not count as a trusted pass.

In the checked-in real-world suite, `mustFind`, `mustNotFind`, `mustSkip`, and `mustNotSkip` are the active contract:
- `mustFind` pins trusted real detections we must keep reporting.
- `mustNotFind` pins past false positives we must not reintroduce.
- `mustSkip` pins trusted conservative boundaries we want to keep visible.
- `mustNotSkip` pins conservative skip families we expect the engine to eliminate without hiding them in accepted skip debt.

The harness still supports `acceptedFindings` and `knownSkips` for bounded-debt workflows, but the current checked-in manifests leave them empty on purpose so remaining engine gaps surface as unexpected findings and unexpected skips.

For legacy accepted-debt entries that still use labels like `(33 current findings)` or `(8 current skips)` without an explicit `maxCount`, the benchmark treats that trailing label count as the current enforced bound during migration.