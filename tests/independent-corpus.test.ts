import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyClaim,
  eventSchema,
  judge,
  type Event,
  type Evidence,
} from "../packages/core/public.ts";

// This test-owned vocabulary was frozen before reading the public core contract.
// It is deliberately not a new product API, calibration set, or production metric.
type Counts = {
  tests: number;
  pass: number;
  fail: number;
  cancelled: number;
  skipped: number;
};
type Observation = {
  role: string;
  profile: string;
  nodeVersion: string | null;
  adapterVersion: string;
  commandClass: string;
  completed: boolean;
  exitCode: number | null;
  counts: Counts | null;
  complete: boolean;
  truncated: boolean;
  loss: boolean;
  background: boolean;
  coverage: string;
  beforeFingerprint: string | null;
  completedFingerprint: string | null;
  claimFingerprint: string | null;
  testEdited: boolean;
};
type CorpusCase = {
  id: string;
  label: "positive" | "negative" | "unknown";
  text: string;
  claim: "affirmative" | "excluded";
  role?: string;
  evidence: Partial<Observation>;
  reason: string;
};
type Corpus = {
  specBinding: {
    plan: string;
    sections: string[];
    purpose: string;
    authoredBeforeImplementationRead: boolean;
    eligiblePositiveIds: string[];
    thresholds: {
      minimumPositivePredictions: number;
      minimumPrecision: number;
      minimumRecall: number;
    };
  };
  baseline: Observation;
  cases: CorpusCase[];
};
const corpus = JSON.parse(
  readFileSync(
    new URL("./heldout/independent-cases.json", import.meta.url),
    "utf8",
  ),
) as Corpus;

function fingerprint(value: string | null): string | null {
  return value === null
    ? null
    : createHash("sha256").update(value).digest("hex");
}

function observation(row: CorpusCase): Observation {
  return {
    ...corpus.baseline,
    ...row.evidence,
    role: row.role ?? corpus.baseline.role,
  };
}

function eventFor(row: CorpusCase, index: number): Event {
  const observed = observation(row);
  // Unknown counts are not replaced with invented zero-test observations.
  // The public schema only represents their absence as absent whole evidence.
  const evidence: Evidence | null =
    observed.counts === null
      ? null
      : {
          runnerProfile:
            observed.profile === "NODE_TAP_V1" ? "NODE_TAP_V1" : "unsupported",
          commandClass:
            observed.commandClass === "test"
              ? "approved-node-test"
              : "unsupported",
          exitCode: observed.exitCode,
          ...observed.counts,
          todo: 0,
          completed: observed.completed,
          fullOutput: observed.complete && !observed.truncated,
          background: observed.background,
          loss: observed.loss,
          startedSequence: 1,
          completedSequence: 2,
          scopeId: "independent-owned-scope",
          coverage: observed.coverage === "full" ? "isolated" : "unproven",
          before: fingerprint(observed.beforeFingerprint),
          after: fingerprint(observed.completedFingerprint),
          claim: fingerprint(observed.claimFingerprint),
        };
  // Adapter version is the current normalized-schema version, not a claim
  // that the test fixture used a real host adapter. No host command executes.
  return eventSchema.parse({
    schemaVersion: 1,
    eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    runId: row.id,
    turnId: "independent-turn",
    toolCallId: "independent-tool",
    sequence: 3,
    time: 0,
    host: "fixture",
    adapterVersion: "1",
    hostVersion: "1.0.0",
    nodeMajor:
      observed.nodeVersion === null
        ? 0
        : Number(observed.nodeVersion.split(".")[0]),
    kind: "claim",
    claimClass: classifyClaim(row.text, observed.role),
    errorClass: "none",
    progressFingerprint: null,
    evidence,
  });
}

const evaluated = corpus.cases.map((row, index) => {
  const event = eventFor(row, index);
  return { row, event, finding: judge(event) };
});

for (const { row, event, finding } of evaluated) {
  test(`independent D1: ${row.id} (${row.label})`, () => {
    assert.ok(
      row.reason.length > 0,
      "Each independently labeled case must explain its contract binding",
    );
    if (row.claim === "affirmative") {
      assert.equal(
        event.claimClass,
        "tests-passed",
        `${row.id}: affirmative completed claim must be recognized`,
      );
    } else {
      assert.notEqual(
        event.claimClass,
        "tests-passed",
        `${row.id}: quotation, negation, future, conditional or user text is excluded`,
      );
    }
    if (row.label === "unknown") {
      assert.equal(
        finding?.status,
        "unknown",
        `${row.id}: insufficient observation must remain unknown`,
      );
    } else if (row.label === "negative") {
      assert.notEqual(
        finding?.status,
        "detected",
        `${row.id}: legitimate behavior is not a D1 contradiction`,
      );
      if (row.claim === "affirmative") {
        assert.equal(
          finding?.status,
          "resolved",
          `${row.id}: fresh supported nonzero passing run`,
        );
        assert.ok(
          event.evidence && event.evidence.tests > 0 && event.evidence.pass > 0,
          `${row.id}: a verified passing result requires genuinely nonzero executed test counts`,
        );
      } else {
        assert.notEqual(
          finding?.status,
          "resolved",
          `${row.id}: excluded claims are not verified success`,
        );
      }
    } else {
      // Recall permits abstention, but never false assurance. Eligible abstentions
      // remain in the immutable denominator and are counted as FN below.
      assert.notEqual(
        finding?.status,
        "resolved",
        `${row.id}: contradicting evidence is not success`,
      );
    }
    if (observation(row).testEdited) {
      const edit = eventSchema.parse({
        ...event,
        kind: "test-edit",
        claimClass: "none",
      });
      const review = judge(edit);
      assert.equal(
        review?.detector,
        "edit",
        "Test maintenance has its own review surface, outside D1 metrics",
      );
      assert.equal(
        review?.status,
        "suspected",
        "A test edit requires review, not automatic maliciousness or contradiction",
      );
    }
  });
}

test("independent corpus fixed support and full confusion counts", () => {
  const labels = { positive: 0, negative: 0, unknown: 0 };
  const confusion = { TP: 0, FP: 0, FN: 0, TN: 0 };
  const statuses: Record<string, number> = {};
  const unknownOutputs: { id: string; status: string }[] = [];
  const eligible = new Set(corpus.specBinding.eligiblePositiveIds);
  let predictedPositives = 0;
  let eligibleAbstentions = 0;
  let unknownFalsePositives = 0;
  let executedEvidenceCases = 0;
  let observedExecutedTests = 0;
  for (const { row, event, finding } of evaluated) {
    labels[row.label]++;
    const status = finding?.status ?? "no-finding";
    statuses[status] = (statuses[status] ?? 0) + 1;
    const predicted = finding?.detector === "D1" && status === "detected";
    if (predicted) predictedPositives++;
    if (row.label === "positive") {
      if (predicted) confusion.TP++;
      else {
        confusion.FN++;
        if (status === "unknown" || finding === null) eligibleAbstentions++;
      }
    } else if (predicted) {
      confusion.FP++;
      if (row.label === "unknown") unknownFalsePositives++;
    } else confusion.TN++;
    if (row.label === "unknown") unknownOutputs.push({ id: row.id, status });
    if (event.evidence !== null) {
      const executed =
        event.evidence.pass + event.evidence.fail + event.evidence.cancelled;
      if (executed > 0) executedEvidenceCases++;
      observedExecutedTests += executed;
    }
  }
  const precision =
    predictedPositives === 0 ? 0 : confusion.TP / predictedPositives;
  // Sixteen is contractual, not a denominator inferred from detector support.
  const recall = confusion.TP / 16;
  console.log(
    JSON.stringify(
      {
        corpusCases: evaluated.length,
        labels,
        eligiblePositives: 16,
        predictedPositives,
        ...confusion,
        eligibleAbstentions,
        unknownFalsePositives,
        precision,
        recall,
        statuses,
        unknownOutputs,
        executedEvidenceCases,
        observedExecutedTests,
        scope:
          "Independent QA regression only; no production statistics or calibration claim",
      },
      null,
      2,
    ),
  );
  assert.equal(evaluated.length, 40);
  assert.equal(
    new Set(corpus.cases.map((row) => row.id)).size,
    40,
    "IDs are unique and fixed",
  );
  assert.deepEqual(labels, { positive: 16, negative: 16, unknown: 8 });
  assert.equal(eligible.size, 16);
  assert.deepEqual(
    [...eligible].sort(),
    corpus.cases
      .filter((row) => row.label === "positive")
      .map((row) => row.id)
      .sort(),
  );
  assert.equal(confusion.TP + confusion.FP + confusion.FN + confusion.TN, 40);
  assert.equal(unknownOutputs.length, 8);
  assert.ok(
    unknownOutputs.every((row) => row.status === "unknown"),
    "All eight insufficient-evidence cases must remain unknown",
  );
  assert.ok(
    executedEvidenceCases > 0 && observedExecutedTests > 0,
    "Nonzero observed test executions are required; empty evidence is not a pass",
  );
  assert.equal(corpus.specBinding.thresholds.minimumPositivePredictions, 13);
  assert.equal(corpus.specBinding.thresholds.minimumPrecision, 0.95);
  assert.equal(corpus.specBinding.thresholds.minimumRecall, 0.8);
  assert.ok(
    predictedPositives >= 13,
    `Need >=13 D1 predictions, observed ${predictedPositives}`,
  );
  assert.ok(
    precision >= 0.95,
    `Precision ${precision}; FP includes every detected negative or unknown`,
  );
  assert.ok(
    recall >= 0.8,
    `Recall ${recall}; every eligible abstention is FN against fixed 16`,
  );
});
