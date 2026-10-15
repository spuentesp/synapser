// Plan 18 E3 (H3.6): property runs are reproducible. The default seed is fixed so a CI run and a local run see the
// same cases; SEED overrides it, and fast-check prints the seed and the shrunk case when a property fails.
export const RUN = {
  numRuns: Number(process.env["RUNS"] ?? 200),
  seed: Number(process.env["SEED"] ?? 20261015),
};
