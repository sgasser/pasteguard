export type SuiteDefinition = {
  description: string;
  defaultEntities: readonly string[];
};

export const CONFIGURED_PII_ENTITIES = [
  "CREDIT_CARD",
  "EMAIL_ADDRESS",
  "IBAN_CODE",
  "IP_ADDRESS",
  "LOCATION",
  "PERSON",
  "PHONE_NUMBER",
  "VAT_CODE",
] as const;

export const SUPPORTED_LANGUAGES = ["en", "de", "es", "fr", "it", "nl", "pl", "pt", "ro"] as const;

export const SUITES: Record<string, SuiteDefinition> = {
  core: {
    description: "Configured PII entities used by Pasteguard's default detection setup.",
    defaultEntities: CONFIGURED_PII_ENTITIES,
  },
  precision: {
    description: "Negative controls where common non-PII strings must not be flagged.",
    defaultEntities: CONFIGURED_PII_ENTITIES,
  },
  "precision-paragraphs": {
    description: "Longer non-PII paragraphs with lookalike strings and operational text.",
    defaultEntities: CONFIGURED_PII_ENTITIES,
  },
  "multilingual-sentences": {
    description: "Sentence-level coverage for every configured entity across supported languages.",
    defaultEntities: CONFIGURED_PII_ENTITIES,
  },
  "multilingual-paragraphs": {
    description: "Paragraph-level workflow coverage for every configured entity across languages.",
    defaultEntities: CONFIGURED_PII_ENTITIES,
  },
  boundaries: {
    description: "Span boundary checks around punctuation, brackets, quotes, and repeated context.",
    defaultEntities: CONFIGURED_PII_ENTITIES,
  },
  hard: {
    description: "Known difficult, ambiguous, or edge-case strings. Report-only by default.",
    defaultEntities: CONFIGURED_PII_ENTITIES,
  },
  eval: {
    description: "Multilingual smoke corpus for trend tracking across configured languages.",
    defaultEntities: CONFIGURED_PII_ENTITIES,
  },
};

export function isKnownSuite(suite: string): boolean {
  return suite in SUITES;
}

export function suiteNames(): string[] {
  return Object.keys(SUITES).sort();
}
