# G-forces

G-meter, g-vision, and the related flight parameters.

The fly app depends on this package and runs its tests. From the `fly` directory, `npm test` includes them.

## Pilot response models

The pilot's response to load is one of three models behind one interface
(`src/pilotResponse.ts`), each advanced once per accepted physics step:

- **Curve** (`src/curveResponse.ts`): the original vignette, load to vision through a lagged curve, and a timer for passing out.
- **Exposure** (`src/exposureResponse.ts`): retinal and brain debts that fill above what the pilot bears and are repaid below it.
- **Perfusion** (`src/perfusionResponse.ts`): pressure at the eye and the brain, flow, reserves and a pressure reflex.

Exposure and Perfusion are fitted to published measurements of onset, recovery
and thresholds, with whole protocols held out. The comparison, the evidence, the fit and the gaps are in
[docs/g-response-comparison.md](docs/g-response-comparison.md). To reproduce it:

```sh
node scripts/g-response-compare.ts                   # synthetic families and evidence scores
node --expose-gc scripts/g-response-benchmark.ts     # CPU and memory per model
node scripts/g-response-plot.ts                      # docs/g-response-error-vs-cpu.svg from the two
node scripts/g-response-fit.ts exposure              # the fit, from the "fit" fixtures only (minutes)
```

The comparison and the benchmark write to `build/g-response/`. The evidence fixtures, with their sources and
assumptions, are in [validation/evidence/g-response/](validation/evidence/g-response/).

## Community

- [Code of conduct](https://github.com/0SFS/.github/blob/main/CODE_OF_CONDUCT.md)
- [Contributing](https://github.com/0SFS/.github/blob/main/CONTRIBUTING.md)
- [License](LICENSE)
- [Security](https://github.com/0SFS/.github/blob/main/SECURITY.md)
