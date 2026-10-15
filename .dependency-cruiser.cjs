// Plan 18 E12 (H12.2, H12.3): architecture rules as configuration. A violation names the file and the line.
module.exports = {
  forbidden: [
    {
      name: "core-does-not-import-the-api",
      comment: "The api is a client of the core; the core never reaches up to it (plan 18 H12.2).",
      severity: "error",
      from: { path: "^src/(?!api/|cli/)" },
      to: { path: "^src/api/" },
    },
    {
      name: "library-does-not-import-execution",
      comment: "The library describes what may run; it never runs anything (plan 18 H12.2, plan 15).",
      severity: "error",
      from: { path: "^src/library/" },
      to: { path: "^src/(agents/runner|agents/adapters|executor|workflow/engine)" },
    },
    {
      name: "ui-does-not-import-the-core",
      comment: "The web app talks to the API only (plan 18 H12.2).",
      severity: "error",
      from: { path: "^web/src/" },
      to: { path: "^src/" },
    },
    {
      name: "source-does-not-import-tests",
      severity: "error",
      from: { path: "^src/" },
      to: { path: "^test/" },
    },
    {
      name: "no-circular-imports",
      comment: "A new cycle fails (plan 18 H12.3). Known cycles are listed below, dated 2026-10-15, and are reviewed at the close of E12.",
      severity: "error",
      // Known debt, dated 2026-10-15: budget.ts <-> types.ts and workflow-designer.tsx <-> workflow-templates.ts.
      from: { pathNot: ["^src/model/budget\\.ts$", "^src/model/types\\.ts$", "^web/src/components/views/workflow-designer\\.tsx$", "^web/src/components/views/workflow-templates\\.ts$"] },
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    exclude: { path: "^(evidence|\\.stryker-tmp|web/node_modules)" },
  },
};
