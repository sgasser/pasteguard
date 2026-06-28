import { describe, expect, test } from "bun:test";
import type { MaskingConfig } from "../config";
import { createRestoreFormatter } from "./restore-policy";

const defaultConfig: MaskingConfig = {
  show_markers: false,
  marker_text: "[protected]",
  allowlist: [],
  denylist: [],
};

describe("createRestoreFormatter", () => {
  test("returns undefined when markers are disabled", () => {
    expect(createRestoreFormatter(defaultConfig)).toBeUndefined();
  });

  test("prefixes restored values when markers are enabled", () => {
    const formatter = createRestoreFormatter({ ...defaultConfig, show_markers: true });

    expect(formatter?.("secret")).toBe("[protected]secret");
  });

  test("uses configured marker text", () => {
    const formatter = createRestoreFormatter({
      ...defaultConfig,
      show_markers: true,
      marker_text: "[masked] ",
    });

    expect(formatter?.("jane@example.com")).toBe("[masked] jane@example.com");
  });
});
