import { z } from "zod";

// Schema for expected PII entity in test data
export const ExpectedEntitySchema = z.object({
  type: z.string(),
  text: z.string(),
});

// Schema for a single test case
export const TestCaseSchema = z.object({
  id: z.string(),
  text: z.string(),
  language: z.string(),
  expected: z.array(ExpectedEntitySchema),
  description: z.string().optional(),
});

export type ExpectedEntity = z.infer<typeof ExpectedEntitySchema>;
export type TestCase = z.infer<typeof TestCaseSchema>;

// Result of running a single test case
export interface TestResult {
  id: string;
  text: string;
  language: string;
  passed: boolean;
  expected: ExpectedEntity[];
  detected: DetectedEntity[];
  falseNegatives: ExpectedEntity[]; // Expected but not detected
  falsePositives: DetectedEntity[]; // Detected but not expected
  truePositives: ExpectedEntity[]; // Correctly detected
}

export interface DetectedEntity {
  type: string;
  text: string;
  start: number;
  end: number;
  score: number;
}

// Aggregated metrics
export interface AccuracyMetrics {
  total: number;
  passed: number;
  failed: number;
  precision: number; // TP / (TP + FP)
  recall: number; // TP / (TP + FN)
  f1: number; // 2 * (P * R) / (P + R)
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
}
