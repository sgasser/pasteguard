/**
 * All 24 spaCy languages with trained pipelines
 * See docker/presidio/languages.yaml for full list
 */
export const SUPPORTED_LANGUAGES = [
  "ca", // Catalan
  "zh", // Chinese
  "hr", // Croatian
  "da", // Danish
  "nl", // Dutch
  "en", // English
  "fi", // Finnish
  "fr", // French
  "de", // German
  "el", // Greek
  "it", // Italian
  "ja", // Japanese
  "ko", // Korean
  "lt", // Lithuanian
  "mk", // Macedonian
  "nb", // Norwegian
  "pl", // Polish
  "pt", // Portuguese
  "ro", // Romanian
  "ru", // Russian
  "sl", // Slovenian
  "es", // Spanish
  "sv", // Swedish
  "uk", // Ukrainian
] as const;

export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];
