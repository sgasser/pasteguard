import type { MaskingConfig } from "../config";

export type RestoreFormatter = (original: string) => string;

export function createRestoreFormatter(config: MaskingConfig): RestoreFormatter | undefined {
  return config.show_markers ? (original: string) => `${config.marker_text}${original}` : undefined;
}
