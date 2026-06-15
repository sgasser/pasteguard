import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { isKnownSuite, SUITES, suiteNames } from "./taxonomy";
import {
  type BenchmarkCase,
  BenchmarkFileSchema,
  type Detection,
  type ExpectedSpan,
  type TestResult,
} from "./types";

const DEFAULT_ANALYZE_URL = "http://localhost:3000/analyze";
const DEFAULT_THRESHOLD = 0.7;
const MAX_FAILURES_TO_PRINT = 40;
const MAX_CONTAINS_EDGE_CHARS = 2;

type Filters = {
  suites?: Set<string>;
  categories?: Set<string>;
  languages?: Set<string>;
  split?: Set<string>;
};

type Metrics = {
  cases: number;
  passed: number;
  errors: number;
  tp: number;
  fp: number;
  fn: number;
};

const argv = parseArgs({
  options: {
    url: { type: "string" },
    threshold: { type: "string" },
    suite: { type: "string" },
    category: { type: "string" },
    languages: { type: "string" },
    split: { type: "string" },
    verbose: { type: "boolean", default: false },
    "list-suites": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (argv.values.help) {
  printHelp();
  process.exit(0);
}

if (argv.values["list-suites"]) {
  for (const name of suiteNames()) {
    console.log(`${name}: ${SUITES[name].description}`);
  }
  process.exit(0);
}

const analyzeUrl = argv.values.url ?? process.env.PII_BENCHMARK_ANALYZE_URL ?? DEFAULT_ANALYZE_URL;
const threshold = parseThreshold(argv.values.threshold ?? String(DEFAULT_THRESHOLD));
const filters = buildFilters(argv.values);
const verbose = Boolean(argv.values.verbose);

const benchmarkDir = dirname(fileURLToPath(import.meta.url));
const testDataDir = join(benchmarkDir, "test-data");

const allCases = await loadCases(testDataDir);
validateCorpus(allCases);

const cases = applyFilters(allCases, filters);

if (cases.length === 0) {
  console.error("No benchmark cases matched the selected filters.");
  process.exit(1);
}

const results: TestResult[] = [];

for (const testCase of cases) {
  results.push(await runCase(testCase, analyzeUrl, threshold));
}

printReport(results, analyzeUrl, threshold, verbose);

const gatingFailures = results.filter((result) => result.gating && !result.passed);
const errors = results.filter((result) => result.error);

if (gatingFailures.length > 0 || errors.length > 0) {
  process.exitCode = 1;
}

async function loadCases(dir: string): Promise<BenchmarkCase[]> {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".yaml")).sort();
  const casesFromFiles = await Promise.all(
    files.map(async (file) => {
      const raw = await readFile(join(dir, file), "utf8");
      const parsed = BenchmarkFileSchema.safeParse(parseYaml(raw));

      if (!parsed.success) {
        const details = parsed.error.errors
          .map((error) => `${error.path.join(".")}: ${error.message}`)
          .join("; ");
        throw new Error(`Invalid benchmark file ${file}: ${details}`);
      }

      return parsed.data.cases;
    }),
  );

  return casesFromFiles.flat();
}

function validateCorpus(casesToValidate: BenchmarkCase[]) {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const testCase of casesToValidate) {
    if (seenIds.has(testCase.id)) {
      errors.push(`Duplicate case id: ${testCase.id}`);
    }
    seenIds.add(testCase.id);

    if (!isKnownSuite(testCase.suite)) {
      errors.push(`Unknown suite in ${testCase.id}: ${testCase.suite}`);
    }

    for (const expected of testCase.expected) {
      if (!testCase.text.includes(expected.text)) {
        errors.push(
          `Expected text is not present in ${testCase.id}: ${expected.entity}(${expected.text})`,
        );
      }
    }
  }

  if (errors.length > 0) {
    console.error(`Invalid benchmark corpus:\n${errors.map((error) => `- ${error}`).join("\n")}`);
    process.exit(1);
  }
}

function applyFilters(casesToFilter: BenchmarkCase[], activeFilters: Filters): BenchmarkCase[] {
  return casesToFilter.filter((testCase) => {
    if (activeFilters.suites && !activeFilters.suites.has(testCase.suite)) {
      return false;
    }
    if (activeFilters.categories && !activeFilters.categories.has(testCase.category)) {
      return false;
    }
    if (activeFilters.languages && !activeFilters.languages.has(testCase.language)) {
      return false;
    }
    if (activeFilters.split && !activeFilters.split.has(testCase.split)) {
      return false;
    }
    return true;
  });
}

async function runCase(
  testCase: BenchmarkCase,
  endpoint: string,
  globalThreshold: number,
): Promise<TestResult> {
  const gating = isGatingCase(testCase);

  try {
    const detections = await analyze(testCase, endpoint, globalThreshold);
    const { matched, missing, unexpected } = scoreDetections(testCase, detections);

    return {
      case: testCase,
      passed: missing.length === 0 && unexpected.length === 0,
      gating,
      detections,
      matched,
      missing,
      unexpected,
    };
  } catch (error) {
    return {
      case: testCase,
      passed: false,
      gating,
      detections: [],
      matched: [],
      missing: testCase.expected,
      unexpected: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function analyze(
  testCase: BenchmarkCase,
  endpoint: string,
  globalThreshold: number,
): Promise<Detection[]> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: testCase.text,
      language: testCase.language,
      entities: entitiesForCase(testCase),
      score_threshold: globalThreshold,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`HTTP ${response.status}: ${body || response.statusText}`);
  }

  const payload = await response.json();

  if (!Array.isArray(payload)) {
    throw new Error(`Expected analyzer array response, got ${typeof payload}`);
  }

  return payload.map((item) => normalizeDetection(testCase, item));
}

function normalizeDetection(testCase: BenchmarkCase, item: unknown): Detection {
  if (!item || typeof item !== "object") {
    throw new Error("Analyzer returned a non-object detection");
  }

  const record = item as Record<string, unknown>;
  const entity = record.entity_type ?? record.entity;
  const start = record.start;
  const end = record.end;
  const score = record.score;

  if (typeof entity !== "string") {
    throw new Error("Analyzer detection is missing entity_type");
  }
  if (typeof start !== "number" || typeof end !== "number") {
    throw new Error(`Analyzer detection ${entity} is missing numeric offsets`);
  }

  return {
    entity,
    start,
    end,
    score: typeof score === "number" ? score : 0,
    text: testCase.text.slice(start, end),
  };
}

function scoreDetections(testCase: BenchmarkCase, detections: Detection[]) {
  const unmatched = [...detections];
  const matched: Array<{ expected: ExpectedSpan; detection: Detection }> = [];
  const missing: ExpectedSpan[] = [];

  for (const expected of testCase.expected) {
    const matchIndex = unmatched.findIndex((detection) =>
      detectionMatchesExpected(testCase, detection, expected),
    );

    if (matchIndex === -1) {
      missing.push(expected);
      continue;
    }

    const [detection] = unmatched.splice(matchIndex, 1);
    matched.push({ expected, detection });
  }

  return { matched, missing, unexpected: unmatched };
}

function detectionMatchesExpected(
  testCase: BenchmarkCase,
  detection: Detection,
  expected: ExpectedSpan,
): boolean {
  if (!entityMatches(detection.entity, expected)) {
    return false;
  }

  if (expected.match === "exact") {
    return normalized(detection.text) === normalized(expected.text);
  }

  if (expected.match === "overlap") {
    return spansOverlap(testCase, detection, expected);
  }

  return boundedContainsMatch(testCase, detection, expected);
}

function entityMatches(entity: string, expected: ExpectedSpan): boolean {
  return entity === expected.entity || expected.aliases.includes(entity);
}

function boundedContainsMatch(
  testCase: BenchmarkCase,
  detection: Detection,
  expected: ExpectedSpan,
): boolean {
  const expectedStart = testCase.text.indexOf(expected.text);

  if (expectedStart === -1) {
    return false;
  }

  const expectedEnd = expectedStart + expected.text.length;
  const detectionCoversExpected = detection.start <= expectedStart && detection.end >= expectedEnd;

  if (!detectionCoversExpected || !normalizedContains(detection.text, expected.text)) {
    return false;
  }

  const leadingExtraChars = expectedStart - detection.start;
  const trailingExtraChars = detection.end - expectedEnd;

  return (
    leadingExtraChars <= MAX_CONTAINS_EDGE_CHARS && trailingExtraChars <= MAX_CONTAINS_EDGE_CHARS
  );
}

function normalizedContains(detectedText: string, expectedText: string): boolean {
  const detected = normalized(detectedText);
  const expected = normalized(expectedText);

  return detected.includes(expected);
}

function spansOverlap(
  testCase: BenchmarkCase,
  detection: Detection,
  expected: ExpectedSpan,
): boolean {
  const expectedStart = testCase.text.indexOf(expected.text);

  if (expectedStart === -1) {
    return false;
  }

  const expectedEnd = expectedStart + expected.text.length;
  return detection.start < expectedEnd && detection.end > expectedStart;
}

function normalized(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/^[\s"'([<{]+/g, "")
    .replace(/[\s"').,;:!?>\]}]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function entitiesForCase(testCase: BenchmarkCase): string[] {
  if (testCase.entities) {
    return testCase.entities;
  }

  if (testCase.expected.length > 0) {
    return [...new Set(testCase.expected.map((expected) => expected.entity))];
  }

  return [...(SUITES[testCase.suite]?.defaultEntities ?? [])];
}

function isGatingCase(testCase: BenchmarkCase): boolean {
  return testCase.gate ?? (testCase.category === "core" || testCase.category === "precision");
}

function printReport(
  results: TestResult[],
  endpoint: string,
  activeThreshold: number,
  printVerbose: boolean,
) {
  const gatingResults = results.filter((result) => result.gating);
  const reportOnlyResults = results.filter((result) => !result.gating);
  const failed = results.filter((result) => !result.passed);
  const gatingFailures = gatingResults.filter((result) => !result.passed);
  const errors = results.filter((result) => result.error);

  console.log("PII accuracy benchmark");
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Default threshold: ${activeThreshold}`);
  console.log(
    `Cases: ${results.length} (${gatingResults.length} gating, ${reportOnlyResults.length} report-only)`,
  );
  console.log("");

  printMetrics("Overall", [["all", aggregate(results)]]);
  printMetrics(
    "By suite",
    groupMetrics(results, (result) => result.case.suite),
  );
  printMetrics(
    "By category",
    groupMetrics(results, (result) => result.case.category),
  );
  printMetrics(
    "By language",
    groupMetrics(results, (result) => result.case.language),
  );
  printMetrics("By entity", entityMetrics(results));

  if (failed.length > 0) {
    console.log("");
    console.log(
      `Failures: ${failed.length} total, ${gatingFailures.length} gating, ${errors.length} errors`,
    );

    const failuresToPrint = printVerbose ? failed : failed.slice(0, MAX_FAILURES_TO_PRINT);
    for (const result of failuresToPrint) {
      printFailure(result);
    }

    if (!printVerbose && failed.length > failuresToPrint.length) {
      console.log(`... ${failed.length - failuresToPrint.length} more failures hidden`);
      console.log("Run with --verbose to print all failure details.");
    }
  }
}

function printMetrics(title: string, rows: Array<[string, Metrics]>) {
  console.log(title);
  console.log(
    [
      "name".padEnd(24),
      "cases".padStart(5),
      "pass".padStart(7),
      "P".padStart(7),
      "R".padStart(7),
      "F1".padStart(7),
      "F2".padStart(7),
      "err".padStart(5),
    ].join(" "),
  );

  for (const [name, metrics] of rows) {
    console.log(
      [
        name.slice(0, 24).padEnd(24),
        String(metrics.cases).padStart(5),
        percent(metrics.passed, metrics.cases).padStart(7),
        percent(metrics.tp, metrics.tp + metrics.fp).padStart(7),
        percent(metrics.tp, metrics.tp + metrics.fn).padStart(7),
        fScore(metrics.tp, metrics.fp, metrics.fn, 1).padStart(7),
        fScore(metrics.tp, metrics.fp, metrics.fn, 2).padStart(7),
        String(metrics.errors).padStart(5),
      ].join(" "),
    );
  }
  console.log("");
}

function groupMetrics(
  results: TestResult[],
  keyFn: (result: TestResult) => string,
): Array<[string, Metrics]> {
  const groups = new Map<string, TestResult[]>();

  for (const result of results) {
    const key = keyFn(result);
    groups.set(key, [...(groups.get(key) ?? []), result]);
  }

  return [...groups.entries()]
    .map(([key, group]) => [key, aggregate(group)] as [string, Metrics])
    .sort(([left], [right]) => left.localeCompare(right));
}

function entityMetrics(results: TestResult[]): Array<[string, Metrics]> {
  const entities = new Map<string, Metrics>();

  for (const result of results) {
    const seenEntities = new Set(entitiesForCase(result.case));
    for (const expected of result.case.expected) {
      seenEntities.add(expected.entity);
    }
    for (const detection of result.unexpected) {
      seenEntities.add(detection.entity);
    }

    for (const entity of seenEntities) {
      if (!entities.has(entity)) {
        entities.set(entity, emptyMetrics());
      }
    }

    for (const entity of seenEntities) {
      const bucket = entities.get(entity);

      if (!bucket) {
        continue;
      }

      bucket.cases += 1;
      bucket.errors += result.error ? 1 : 0;
      const tp = result.matched.filter((match) => match.expected.entity === entity).length;
      const fn = result.missing.filter((missing) => missing.entity === entity).length;
      const fp = result.unexpected.filter((unexpected) => unexpected.entity === entity).length;

      bucket.tp += tp;
      bucket.fn += fn;
      bucket.fp += fp;
      bucket.passed += result.error || fn > 0 || fp > 0 ? 0 : 1;
    }
  }

  return [...entities.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function aggregate(results: TestResult[]): Metrics {
  const metrics = emptyMetrics();

  for (const result of results) {
    metrics.cases += 1;
    metrics.passed += result.passed ? 1 : 0;
    metrics.errors += result.error ? 1 : 0;
    metrics.tp += result.matched.length;
    metrics.fp += result.unexpected.length;
    metrics.fn += result.error ? result.case.expected.length : result.missing.length;
  }

  return metrics;
}

function emptyMetrics(): Metrics {
  return {
    cases: 0,
    passed: 0,
    errors: 0,
    tp: 0,
    fp: 0,
    fn: 0,
  };
}

function printFailure(result: TestResult) {
  const mode = result.gating ? "gating" : "report-only";
  console.log(`- ${result.case.id} [${result.case.suite}/${result.case.category}/${mode}]`);

  if (result.error) {
    console.log(`  error: ${result.error}`);
    return;
  }

  if (result.missing.length > 0) {
    console.log(
      `  missing: ${result.missing
        .map((expected) => `${expected.entity}(${expected.text})`)
        .join(", ")}`,
    );
  }

  if (result.unexpected.length > 0) {
    console.log(
      `  unexpected: ${result.unexpected
        .map((detection) => `${detection.entity}(${detection.text}, ${detection.score.toFixed(2)})`)
        .join(", ")}`,
    );
  }
}

function percent(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return "n/a";
  }

  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function fScore(tp: number, fp: number, fn: number, beta: number): string {
  const betaSquared = beta * beta;
  const denominator = (1 + betaSquared) * tp + betaSquared * fn + fp;

  if (denominator === 0) {
    return "n/a";
  }

  return `${(((1 + betaSquared) * tp) / denominator).toFixed(3)}`;
}

function buildFilters(values: typeof argv.values): Filters {
  return {
    suites: csvSet(values.suite),
    categories: csvSet(values.category),
    languages: csvSet(values.languages),
    split: csvSet(values.split),
  };
}

function csvSet(value: string | boolean | undefined): Set<string> | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  return new Set(
    value
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean),
  );
}

function parseThreshold(value: string): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid threshold: ${value}`);
  }

  return parsed;
}

function printHelp() {
  console.log(`Usage: bun run benchmarks/pii-accuracy/run.ts [options]

Options:
  --url <url>              Analyze endpoint. Default: ${DEFAULT_ANALYZE_URL}
  --threshold <0..1>       Default score threshold. Default: ${DEFAULT_THRESHOLD}
  --suite <csv>            Filter suites, e.g. core,precision
  --category <csv>         Filter categories: core,precision,eval,hard
  --languages <csv>        Filter languages, e.g. en,de,it
  --split <csv>            Filter split: dev,test
  --list-suites            Print suites and exit
  --verbose                Print all failure details
  --help                   Print this help
`);
}
