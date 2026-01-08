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
 *   bun run benchmarks/pii-accuracy/run.ts --verbose
 */

import { parseArgs } from "util";
import { Glob } from "bun";
import { parse as parseYaml } from "yaml";
import {
  TestCaseSchema,
  type AccuracyMetrics,
  type DetectedEntity,
  type ExpectedEntity,
  type TestCase,
  type TestResult,
} from "./types";

// Configuration
const DEFAULT_THRESHOLD = 0.7;
const PRESIDIO_URL = process.env.PRESIDIO_URL || "http://localhost:5002";
const TEST_DATA_DIR = import.meta.dir + "/test-data";

// Parse command line arguments
const { values: args } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    threshold: { type: "string", short: "t" },
    languages: { type: "string", short: "l" },
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
  -v, --verbose              Show detailed results for each test case
  -h, --help                 Show this help message

Examples:
  bun run benchmarks/pii-accuracy/run.ts
  bun run benchmarks/pii-accuracy/run.ts --threshold 0.5
  bun run benchmarks/pii-accuracy/run.ts --languages de,en
  bun run benchmarks/pii-accuracy/run.ts --verbose
`);
  process.exit(0);
}

const threshold = args.threshold ? Number.parseFloat(args.threshold) : DEFAULT_THRESHOLD;
const verbose = args.verbose ?? false;
const languageFilter = args.languages?.split(",").map((l) => l.trim().toLowerCase());

// Entity types we test for
const ENTITY_TYPES = [
  "PERSON",
  "EMAIL_ADDRESS",
  "PHONE_NUMBER",
  "CREDIT_CARD",
  "IBAN_CODE",
  "IP_ADDRESS",
  "LOCATION",
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
        // Filter by language if specified
        if (!languageFilter || languageFilter.includes(parsed.data.language)) {
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
 * Call Presidio analyzer API
 */
async function detectPII(text: string, language: string): Promise<DetectedEntity[]> {
  if (!text) return [];

  const response = await fetch(`${PRESIDIO_URL}/analyze`, {
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
    throw new Error(`Presidio error: ${response.status} ${await response.text()}`);
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
 * Check if Presidio is available
 */
async function checkPresidio(): Promise<boolean> {
  try {
    const response = await fetch(`${PRESIDIO_URL}/health`);
    return response.ok;
  } catch {
    return false;
  }
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
    passed,
    expected: testCase.expected,
    detected,
    falseNegatives,
    falsePositives,
    truePositives,
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

  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
    precision,
    recall,
    f1,
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
      `F1=${formatPercent(metrics.f1).padStart(6)}  ${status}`,
  );
}

/**
 * Main benchmark execution
 */
async function main(): Promise<void> {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║           PII Detection Accuracy Benchmark                 ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Check Presidio availability
  console.log(`Presidio URL: ${PRESIDIO_URL}`);
  console.log(`Threshold: ${threshold}`);
  if (languageFilter) {
    console.log(`Languages: ${languageFilter.join(", ")}`);
  }

  if (!(await checkPresidio())) {
    console.error("\n✗ Presidio is not available. Start it with:");
    console.error("  docker compose up presidio-analyzer -d\n");
    process.exit(1);
  }
  console.log("Presidio: ✓ Connected\n");

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
            console.log(`    Missed: ${result.falseNegatives.map((e) => `${e.type}:"${e.text}"`).join(", ")}`);
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

  console.log(`Overall: ${overall.passed}/${overall.total} passed\n`);

  console.log("Metrics (P=Precision, R=Recall, F1=F1-Score):\n");

  console.log(
    `  ${"OVERALL".padEnd(20)} P=${formatPercent(overall.precision).padStart(6)}  ` +
      `R=${formatPercent(overall.recall).padStart(6)}  ` +
      `F1=${formatPercent(overall.f1).padStart(6)}\n`,
  );

  console.log("By Entity Type:");
  for (const [type, metrics] of Object.entries(byEntityType)) {
    printMetrics(type, metrics);
  }

  console.log("\nBy Language:");
  for (const [lang, metrics] of Object.entries(byLanguage)) {
    printMetrics(lang.toUpperCase(), metrics);
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
      console.log(`  ✗ "${entity.text}" (${entity.type}, score=${entity.score.toFixed(2)}) in ${testId}`);
    }
  }

  console.log("\n────────────────────────────────────────────────────────────\n");

  // Exit with error code if tests failed
  if (overall.failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Benchmark failed:", error);
  process.exit(1);
});
