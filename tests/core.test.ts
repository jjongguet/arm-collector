import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  eventSchema,
  judge,
  classifyClaim,
  parseTap,
} from "../packages/core/public.ts";
import type { Event, Evidence } from "../packages/core/public.ts";
import { baseEvent } from "../packages/collector/public.ts";
export function evidence(): Evidence {
  return {
    runnerProfile: "NODE_TAP_V1",
    commandClass: "approved-node-test",
    exitCode: 0,
    tests: 2,
    pass: 2,
    fail: 0,
    cancelled: 0,
    skipped: 0,
    todo: 0,
    completed: true,
    fullOutput: true,
    background: false,
    loss: false,
    startedSequence: 0,
    completedSequence: 1,
    scopeId: "scope",
    coverage: "isolated",
    before: "a".repeat(64),
    after: "a".repeat(64),
    claim: "a".repeat(64),
  };
}
export function claim(): Event {
  return {
    ...baseEvent("fixture", "run", 2),
    kind: "claim",
    claimClass: "tests-passed",
    evidence: evidence(),
  };
}
const corpus = JSON.parse(
  readFileSync(new URL("./heldout/cases.json", import.meta.url), "utf8"),
) as { cases: Record<string, unknown>[] };
let tp = 0,
  fp = 0,
  fn = 0,
  tn = 0,
  unknown = 0,
  predictions = 0;
for (const c of corpus.cases)
  test(`heldout ${c.id} ${c.label}`, () => {
    const e = claim(),
      v = e.evidence!;
    for (const key of [
      "fail",
      "pass",
      "cancelled",
      "skipped",
      "todo",
      "exitCode",
      "fullOutput",
      "background",
      "loss",
      "coverage",
      "runnerProfile",
    ])
      if (c[key] !== undefined)
        (v as unknown as Record<string, unknown>)[key] = c[key];
    v.tests = v.pass + v.fail + v.cancelled + v.skipped + v.todo;
    if (c.kind) e.kind = c.kind as Event["kind"];
    if (c.claimClass) e.claimClass = c.claimClass as Event["claimClass"];
    if (c.missing) e.evidence = null;
    if (c.stale) v.claim = "b".repeat(64);
    if (c.zero) {
      v.tests = 0;
      v.pass = 0;
    }
    const finding = judge(eventSchema.parse(e)),
      positive = finding?.status === "detected";
    if (positive) {
      predictions++;
      if (c.label === "positive") tp++;
      else fp++;
    } else if (c.label === "positive") fn++;
    else tn++;
    if (finding?.status === "unknown") unknown++;
    if (c.label === "unknown") assert.equal(finding?.status, "unknown");
    if (c.label === "positive") assert.equal(finding?.status, "detected");
    if (c.label === "negative") assert.notEqual(finding?.status, "detected");
  });
test("heldout confusion gate", () => {
  assert.equal(corpus.cases.length, 40);
  assert.equal(corpus.cases.filter((c) => c.label === "positive").length, 16);
  assert.equal(corpus.cases.filter((c) => c.label === "negative").length, 16);
  assert.equal(corpus.cases.filter((c) => c.label === "unknown").length, 8);
  assert.ok(predictions >= 13);
  assert.ok(tp / (tp + fp) >= 0.95);
  assert.ok(tp / 16 >= 0.8);
  console.log(
    JSON.stringify({
      heldout: {
        tp,
        fp,
        fn,
        tn,
        unknown,
        predictions,
        precision: tp / (tp + fp),
        recall: tp / 16,
      },
    }),
  );
});
for (const text of ["All tests passed.", "모든 테스트가 통과했습니다."])
  test(`affirmative ${text}`, () =>
    assert.equal(classifyClaim(text, "assistant"), "tests-passed"));
for (const text of [
  "All tests did not pass",
  "Will all tests pass?",
  "If all tests passed",
  '"All tests passed"',
  "테스트가 통과하지 않았습니다",
])
  test(`exclude ${text}`, () =>
    assert.notEqual(classifyClaim(text, "assistant"), "tests-passed"));
test("user statements excluded", () =>
  assert.equal(classifyClaim("All tests passed", "user"), "none"));
test("D2 three identical failures, not malicious", () => {
  const e = {
    ...claim(),
    kind: "error" as const,
    errorClass: "tool-failed" as const,
    progressFingerprint: "c".repeat(64),
  };
  assert.equal(
    judge({ ...e, sequence: 4 }, [
      { ...e, sequence: 1 },
      { ...e, sequence: 2 },
    ])?.status,
    "suspected",
  );
  assert.equal(
    judge({ ...e, sequence: 4 }, [
      { ...e, sequence: 1, progressFingerprint: "d".repeat(64) },
    ]),
    null,
  );
});
test("tap full totals and truncated tail", () => {
  const output =
    "TAP version 13\n1..1\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 1.2\n";
  assert.equal(parseTap(output).fullOutput, true);
  assert.equal(parseTap(output.slice(0, -20)).fullOutput, false);
  assert.equal(parseTap(output + output).fullOutput, false);
});
test("strict schema blocks raw fields", () =>
  assert.throws(() =>
    eventSchema.parse({ ...claim(), prompt: "secret-canary" }),
  ));
