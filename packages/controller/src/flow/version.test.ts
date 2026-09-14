import { describe, expect, it } from "vitest";
import { highestLevel, levelFromLabels, nextCandidate, nextFinal } from "./version.js";

describe("versions", () => {
  it("starts a candidate series from the shipped version", () => {
    expect(nextCandidate("1.4.2", "1.4.2", "patch")).toBe("1.4.3-rc.1");
    expect(nextCandidate("1.4.2", "1.4.2", "minor")).toBe("1.5.0-rc.1");
  });
  it("continues a candidate series for the same target", () => {
    expect(nextCandidate("1.4.2", "1.4.3-rc.1", "patch")).toBe("1.4.3-rc.2");
    expect(nextCandidate("1.4.2", "1.4.3-rc.2", "minor")).toBe("1.5.0-rc.1");
  });
  it("finalizes by level from the shipped version", () => {
    expect(nextFinal("1.4.2", "patch")).toBe("1.4.3");
    expect(nextFinal("1.4.2", "major")).toBe("2.0.0");
  });
  it("derives the level from labels", () => {
    expect(levelFromLabels(["bug"])).toBe("patch");
    expect(highestLevel([levelFromLabels(["release:minor"]), levelFromLabels([])])).toBe("minor");
  });
});
