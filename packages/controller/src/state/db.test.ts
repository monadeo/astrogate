import { describe, expect, it } from "vitest";
import { StateDb } from "./db.js";

describe("StateDb", () => {
  it("dedupes deliveries and tracks attempts", () => {
    const db = new StateDb(":memory:");
    expect(db.recordDelivery("d1", "issues")).toBe(true);
    expect(db.recordDelivery("d1", "issues")).toBe(false);
    const row = db.insertAttempt({ repo: "o/r", ticket: 4, attempt: 1, role: "worker", branch: "astrogate/4", worktree: "/w/4", workspaceId: "w1", paneId: "w1:p1" });
    db.setSessionFile(row.id, "/s.jsonl");
    db.setPr(row.id, 9, "abc");
    db.setReview(row.id, "approved");
    const latest = db.latestAttempt("o/r", 4, "worker");
    expect(latest?.sessionFile).toBe("/s.jsonl");
    expect(latest?.pr).toBe(9);
    expect(latest?.review).toBe("approved");
    expect(db.attemptByHeadSha("o/r", "abc")?.id).toBe(row.id);
    expect(db.runningAttempts()).toHaveLength(1);
    db.stopAttempt(row.id);
    expect(db.runningAttempts()).toHaveLength(0);
    db.close();
  });
  it("tracks release members and alert windows", () => {
    const db = new StateDb(":memory:");
    db.setMember("o/r", 1, "qa");
    db.setMember("o/r", 1, "accepted");
    expect(db.members("o/r")).toEqual([{ repo: "o/r", ticket: 1, state: "accepted" }]);
    expect(db.shouldAlert("k", 60_000)).toBe(true);
    expect(db.shouldAlert("k", 60_000)).toBe(false);
    db.clearAlert("k");
    expect(db.shouldAlert("k", 60_000)).toBe(true);
    db.close();
  });
});
