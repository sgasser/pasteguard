#!/usr/bin/env bun

/**
 * PII Detection Accuracy Benchmark
 *
 * Measures precision, recall, and F1 score of the PII detection system.
 *
 * Usage:
 *   bun run benchmarks/pii-accuracy/run.ts
 *   bun run benchmarks/pii-accuracy/run.ts --threshold 0.5
 *   bun run benchmarks/pii-accuracy/run.ts --languages de,en
 *   bun run benchmarks/pii-accuracy/run.ts --mode api --target-url https://pasteguard.eu
 *   bun run benchmarks/pii-accuracy/run.ts --verbose
 */

import { parseArgs } from "node:util";
import { Glob } from "bun";
import { parse as parseYaml } from "yaml";
import {
  type AccuracyMetrics,
  type DetectedEntity,
  type ExpectedEntity,
  type TestCase,
  TestCaseSchema,
  type TestResult,
} from "./types";

const DEFAULT_THRESHOLD = 0.7;
const DEFAULT_DETECTOR_URL = "http://localhost:5002";
const DEFAULT_API_URL = "http://localhost:3000";
const TEST_DATA_DIR = `${import.meta.dir}/test-data`;

type BenchmarkMode = "detector" | "api";

// Parse command line arguments
const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    threshold: { type: "string", short: "t" },
    languages: { type: "string", short: "l" },
    split: { type: "string", short: "s" },
    mode: { type: "string", short: "m" },
    "detector-url": { type: "string" },
    "target-url": { type: "string" },
    verbose: { type: "boolean", short: "v", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(`
PII Detection Accuracy Benchmark

Usage:
  bun run benchmarks/pii-accuracy/run.ts [options]

Options:
  -t, --threshold <value>    Score threshold (default: ${DEFAULT_THRESHOLD})
  -l, --languages <langs>    Comma-separated languages to test (e.g., de,en)
  -s, --split <dev|test>     Only run cases from this split (default: all)
  -m, --mode <detector|api>  Run against the detector /analyze API or PasteGuard /api/mask
      --detector-url <url>   Detector base URL (default: DETECTOR_URL or ${DEFAULT_DETECTOR_URL})
      --target-url <url>     PasteGuard app URL for --mode api (default: PASTEGUARD_URL or ${DEFAULT_API_URL})
  -v, --verbose              Show detailed results for each test case
  -h, --help                 Show this help message

Examples:
  bun run benchmarks/pii-accuracy/run.ts
  bun run benchmarks/pii-accuracy/run.ts --threshold 0.5
  bun run benchmarks/pii-accuracy/run.ts --languages de,en
  bun run benchmarks/pii-accuracy/run.ts --mode api --target-url https://pasteguard.eu --split test
  bun run benchmarks/pii-accuracy/run.ts --verbose
`);
  process.exit(0);
}

const threshold = args.threshold ? Number.parseFloat(args.threshold) : DEFAULT_THRESHOLD;
const verbose = args.verbose ?? false;
const languageFilter = args.languages?.split(",").map((l) => l.trim().toLowerCase());
const splitFilter = args.split?.trim().toLowerCase();
const mode = parseMode(args.mode);
const detectorUrl = normalizeBaseUrl(
  args["detector-url"] ?? process.env.DETECTOR_URL ?? DEFAULT_DETECTOR_URL,
);
const apiUrl = normalizeBaseUrl(
  args["target-url"] ?? process.env.PASTEGUARD_URL ?? process.env.TARGET_URL ?? DEFAULT_API_URL,
);

if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
  console.error(`Invalid threshold: ${args.threshold}. Expected a number from 0 to 1.`);
  process.exit(1);
}

if (splitFilter && !["dev", "test"].includes(splitFilter)) {
  console.error(`Invalid split: ${splitFilter}. Expected "dev" or "test".`);
  process.exit(1);
}

function parseMode(value: string | undefined): BenchmarkMode {
  if (!value) return process.env.PASTEGUARD_URL || process.env.TARGET_URL ? "api" : "detector";
  if (value === "detector" || value === "api") return value;
  console.error(`Invalid mode: ${value}. Expected "detector" or "api".`);
  process.exit(1);
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

// Entity types requested from the detector.
const ENTITY_TYPES = [
  "PERSON",
  "EMAIL_ADDRESS",
  "PHONE_NUMBER",
  "CREDIT_CARD",
  "IBAN_CODE",
  "IP_ADDRESS",
  "LOCATION",
  "ORGANIZATION",
  "ADDRESS",
  "IT_FISCAL_CODE",
  "VAT_CODE",
  "BIC_CODE",
  "CRYPTO",
];

/**
 * Load test cases from YAML files in test-data directory
 */
async function loadTestCases(): Promise<TestCase[]> {
  const testCases: TestCase[] = [];
  const glob = new Glob("*.yaml");

  for await (const file of glob.scan(TEST_DATA_DIR)) {
    const filePath = `${TEST_DATA_DIR}/${file}`;
    const content = await Bun.file(filePath).text();
    const data = parseYaml(content) as { test_cases: unknown[] };

    if (!data.test_cases || !Array.isArray(data.test_cases)) {
      console.warn(`Warning: ${file} has no test_cases array`);
      continue;
    }

    for (const testCase of data.test_cases) {
      const parsed = TestCaseSchema.safeParse(testCase);
      if (parsed.success) {
        // Filter by language and/or split if specified
        const langOk = !languageFilter || languageFilter.includes(parsed.data.language);
        const splitOk = !splitFilter || parsed.data.split === splitFilter;
        if (langOk && splitOk) {
          testCases.push(parsed.data);
        }
      } else {
        console.warn(`Warning: Invalid test case in ${file}:`, parsed.error.format());
      }
    }
  }

  // Sort by ID for deterministic output
  return testCases.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Call the configured target.
 */
async function detectPII(text: string, language: string): Promise<DetectedEntity[]> {
  if (!text) return [];
  if (mode === "api") {
    return detectViaMaskApi(text, language);
  }
  return detectViaDetector(text, language);
}

/**
 * Call the detector /analyze API.
 */
async function detectViaDetector(text: string, language: string): Promise<DetectedEntity[]> {
  const response = await fetch(`${detectorUrl}/analyze`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      language,
      entities: ENTITY_TYPES,
      score_threshold: threshold,
    }),
  });

  if (!response.ok) {
    throw new Error(`Detector error: ${response.status} ${await response.text()}`);
  }

  const entities = (await response.json()) as Array<{
    entity_type: string;
    start: number;
    end: number;
    score: number;
  }>;

  return entities.map((e) => ({
    type: e.entity_type,
    text: text.slice(e.start, e.end),
    start: e.start,
    end: e.end,
    score: e.score,
  }));
}

/**
 * Call PasteGuard's public masking API. This exercises the same app endpoint
 * users call in production, at the cost of losing detector scores and offsets.
 */
async function detectViaMaskApi(text: string, language: string): Promise<DetectedEntity[]> {
  const response = await fetch(`${apiUrl}/api/mask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, language, detect: ["pii"] }),
  });

  if (!response.ok) {
    throw new Error(`PasteGuard API error: ${response.status} ${await response.text()}`);
  }

  const data = (await response.json()) as {
    context?: Record<string, string>;
    entities?: Array<{ type: string; placeholder: string }>;
  };

  return (data.entities ?? [])
    .map((entity) => {
      const entityText = data.context?.[entity.placeholder] ?? "";
      const start = entityText ? text.indexOf(entityText) : -1;
      return {
        type: entity.type,
        text: entityText,
        start: start >= 0 ? start : undefined,
        end: start >= 0 ? start + entityText.length : undefined,
        score: 1,
      };
    })
    .filter((entity) => entity.text);
}

/**
 * Check if the configured target is available.
 */
async function checkTarget(): Promise<boolean> {
  try {
    if (mode === "detector") {
      const response = await fetch(`${detectorUrl}/health`);
      return response.ok;
    }

    const response = await fetch(`${apiUrl}/api/mask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "benchmark smoke test", language: "en", detect: ["pii"] }),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function missingTargetHelp(): string {
  if (mode === "detector") {
    return "Start it with:\n  docker compose --profile dev up detector -d";
  }
  return `Check the app URL or run locally with:\n  bun run dev\nCurrent target: ${apiUrl}`;
}

/**
 * Run a single test case and compare results
 */
async function runTestCase(testCase: TestCase): Promise<TestResult> {
  const detected = await detectPII(testCase.text, testCase.language);

  // Match expected entities with detected ones
  const truePositives: ExpectedEntity[] = [];
  const falseNegatives: ExpectedEntity[] = [];
  const matchedDetected = new Set<number>();

  for (const expected of testCase.expected) {
    // Find a matching detected entity
    const matchIndex = detected.findIndex(
      (d, i) =>
        !matchedDetected.has(i) &&
        d.type === expected.type &&
        normalizeText(d.text).includes(normalizeText(expected.text)),
    );

    if (matchIndex !== -1) {
      truePositives.push(expected);
      matchedDetected.add(matchIndex);
    } else {
      falseNegatives.push(expected);
    }
  }

  // Remaining detected entities are false positives
  const falsePositives = detected.filter((_, i) => !matchedDetected.has(i));

  const passed = falseNegatives.length === 0 && falsePositives.length === 0;

  return {
    id: testCase.id,
    text: testCase.text,
    language: testCase.language,
    category: testCase.category,
    split: testCase.split,
    passed,
    expected: testCase.expected,
    detected,
    falseNegatives,
    falsePositives,
    truePositives,
  };
}

function errorResult(testCase: TestCase, error: unknown): TestResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    id: testCase.id,
    text: testCase.text,
    language: testCase.language,
    category: testCase.category,
    split: testCase.split,
    passed: false,
    expected: testCase.expected,
    detected: [],
    falseNegatives: testCase.expected,
    falsePositives: [],
    truePositives: [],
    error: message,
  };
}

/**
 * Normalize text for comparison (lowercase, trim)
 */
function normalizeText(text: string): string {
  return text.toLowerCase().trim();
}

/**
 * Calculate accuracy metrics from results
 */
function calculateMetrics(results: TestResult[]): AccuracyMetrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;

  for (const result of results) {
    tp += result.truePositives.length;
    fp += result.falsePositives.length;
    fn += result.falseNegatives.length;
  }

  const precision = tp + fp > 0 ? tp / (tp + fp) : 1;
  const recall = tp + fn > 0 ? tp / (tp + fn) : 1;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  // F2 weights recall 2x precision: for a privacy tool, a missed entity (leak)
  // is worse than an over-mask.
  const f2 = 4 * precision + recall > 0 ? (5 * precision * recall) / (4 * precision + recall) : 0;

  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    precision,
    recall,
    f1,
    f2,
    truePositives: tp,
    falsePositives: fp,
    falseNegatives: fn,
  };
}

/**
 * Format percentage for display
 */
function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Print metrics in a formatted way
 */
function printMetrics(label: string, metrics: AccuracyMetrics): void {
  const status = metrics.failed === 0 ? "✓" : "⚠";
  console.log(
    `  ${label.padEnd(20)} P=${formatPercent(metrics.precision).padStart(6)}  ` +
      `R=${formatPercent(metrics.recall).padStart(6)}  ` +
      `F1=${formatPercent(metrics.f1).padStart(6)}  ` +
      `F2=${formatPercent(metrics.f2).padStart(6)}  ${status}`,
  );
}

/**
 * Main benchmark execution
 */
async function main(): Promise<void> {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║           PII Detection Accuracy Benchmark                 ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Check target availability
  console.log(`Mode: ${mode}`);
  console.log(`Target URL: ${mode === "detector" ? detectorUrl : apiUrl}`);
  console.log(`Threshold: ${threshold}`);
  if (languageFilter) {
    console.log(`Languages: ${languageFilter.join(", ")}`);
  }

  if (!(await checkTarget())) {
    console.error("\n✗ Benchmark target is not available.");
    console.error(`${missingTargetHelp()}\n`);
    process.exit(1);
  }
  console.log("Target: ✓ Connected\n");

  // Load test cases from directory
  const testCases = await loadTestCases();

  if (testCases.length === 0) {
    console.error("No test cases found in", TEST_DATA_DIR);
    process.exit(1);
  }

  console.log(`Running ${testCases.length} test cases...\n`);

  // Run all test cases
  const results: TestResult[] = [];
  for (const testCase of testCases) {
    try {
      const result = await runTestCase(testCase);
      results.push(result);

      if (verbose) {
        const icon = result.passed ? "✓" : "✗";
        console.log(`${icon} ${result.id}`);
        if (!result.passed) {
          if (result.falseNegatives.length > 0) {
            console.log(
              `    Missed: ${result.falseNegatives.map((e) => `${e.type}:"${e.text}"`).join(", ")}`,
            );
          }
          if (result.falsePositives.length > 0) {
            console.log(
              `    Wrong:  ${result.falsePositives.map((e) => `${e.type}:"${e.text}" (${e.score.toFixed(2)})`).join(", ")}`,
            );
          }
        }
      }
    } catch (error) {
      console.error(`Error in test ${testCase.id}:`, error);
      results.push(errorResult(testCase, error));
    }
  }

  // Calculate overall metrics
  const overall = calculateMetrics(results);

  // Calculate metrics by entity type
  const byEntityType: Record<string, AccuracyMetrics> = {};
  for (const entityType of ENTITY_TYPES) {
    const filtered = results.map((r) => ({
      ...r,
      expected: r.expected.filter((e) => e.type === entityType),
      truePositives: r.truePositives.filter((e) => e.type === entityType),
      falseNegatives: r.falseNegatives.filter((e) => e.type === entityType),
      falsePositives: r.falsePositives.filter((e) => e.type === entityType),
    }));
    // Only include if there are test cases for this type
    const hasTestCases = filtered.some((r) => r.expected.length > 0 || r.falsePositives.length > 0);
    if (hasTestCases) {
      byEntityType[entityType] = calculateMetrics(filtered);
    }
  }

  // Calculate metrics by language
  const languages = [...new Set(results.map((r) => r.language))];
  const byLanguage: Record<string, AccuracyMetrics> = {};
  for (const lang of languages) {
    byLanguage[lang] = calculateMetrics(results.filter((r) => r.language === lang));
  }

  // Print report
  console.log("\n────────────────────────────────────────────────────────────");
  console.log("                         RESULTS");
  console.log("────────────────────────────────────────────────────────────\n");

  const core = results.filter((r) => r.category === "core");
  const hard = results.filter((r) => r.category === "hard");
  const evalResults = results.filter((r) => r.category === "eval");
  const corePassed = core.filter((r) => r.passed).length;
  const hardPassed = hard.filter((r) => r.passed).length;
  const evalPassed = evalResults.filter((r) => r.passed).length;
  console.log(
    `Overall: ${overall.passed}/${overall.total} passed  ` +
      `(core ${corePassed}/${core.length}, hard ${hardPassed}/${hard.length}, ` +
      `eval ${evalPassed}/${evalResults.length})\n`,
  );

  console.log("Metrics (P=Precision, R=Recall, F1=F1-Score, F2=Recall-weighted):\n");

  console.log(
    `  ${"OVERALL".padEnd(20)} P=${formatPercent(overall.precision).padStart(6)}  ` +
      `R=${formatPercent(overall.recall).padStart(6)}  ` +
      `F1=${formatPercent(overall.f1).padStart(6)}  ` +
      `F2=${formatPercent(overall.f2).padStart(6)}\n`,
  );

  console.log("By Entity Type:");
  for (const [type, metrics] of Object.entries(byEntityType)) {
    printMetrics(type, metrics);
  }

  console.log("\nBy Language:");
  for (const [lang, metrics] of Object.entries(byLanguage)) {
    printMetrics(lang.toUpperCase(), metrics);
  }

  // Core = regression guard (must pass); Hard = honest measure of real limits.
  console.log("\nBy Category:");
  for (const cat of ["core", "hard", "eval"] as const) {
    const catResults = results.filter((r) => r.category === cat);
    if (catResults.length > 0) {
      printMetrics(cat, calculateMetrics(catResults));
    }
  }

  // Dev = tuning split; Test = held-out eval (report the headline number here).
  console.log("\nBy Split:");
  for (const sp of ["dev", "test"] as const) {
    const spResults = results.filter((r) => r.split === sp);
    if (spResults.length > 0) {
      printMetrics(sp, calculateMetrics(spResults));
    }
  }

  // Print false negatives (missed PII)
  const allFalseNegatives = results.flatMap((r) =>
    r.falseNegatives.map((fn) => ({ testId: r.id, text: r.text, entity: fn })),
  );
  if (allFalseNegatives.length > 0) {
    console.log("\n────────────────────────────────────────────────────────────");
    console.log(`False Negatives (Missed PII): ${allFalseNegatives.length}`);
    console.log("────────────────────────────────────────────────────────────");
    for (const { testId, entity } of allFalseNegatives) {
      console.log(`  ✗ "${entity.text}" (${entity.type}) in ${testId}`);
    }
  }

  // Print false positives (wrong detections)
  const allFalsePositives = results.flatMap((r) =>
    r.falsePositives.map((fp) => ({ testId: r.id, text: r.text, entity: fp })),
  );
  if (allFalsePositives.length > 0) {
    console.log("\n────────────────────────────────────────────────────────────");
    console.log(`False Positives (Wrong Detections): ${allFalsePositives.length}`);
    console.log("────────────────────────────────────────────────────────────");
    for (const { testId, entity } of allFalsePositives) {
      console.log(
        `  ✗ "${entity.text}" (${entity.type}, score=${entity.score.toFixed(2)}) in ${testId}`,
      );
    }
  }

  const executionErrors = results.filter((r) => r.error);
  if (executionErrors.length > 0) {
    console.log("\n────────────────────────────────────────────────────────────");
    console.log(`Execution Errors: ${executionErrors.length}`);
    console.log("────────────────────────────────────────────────────────────");
    for (const result of executionErrors) {
      console.log(`  ✗ ${result.id}: ${result.error}`);
    }
  }

  console.log("\n────────────────────────────────────────────────────────────\n");

  // Exit non-zero only on a *core* regression. Hard/adversarial cases are an
  // honest measure of limits, not a pass/fail gate, so their misses don't fail
  // the run (they're already reflected in the metrics above).
  const coreFailed = results.filter((r) => r.category === "core" && !r.passed).length;
  if (coreFailed > 0 || executionErrors.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
