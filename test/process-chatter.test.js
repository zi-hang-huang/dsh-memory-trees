/**
 * Tests for the process-chatter gate (v8-b): promotional decisions that are agent ACTION
 * NARRATION, not knowledge, must be rejected before they enter LTM.
 *
 * The English cases are real records captured from a live session on 2026-11-07 — they
 * slipped past the original Chinese-only PROCESS_PATTERNS and turned up as junk inside a
 * work pivot's body. The fact cases guard against over-matching (a real English fact must
 * never be dropped).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isProcessChatter } from "../lib/promote.js";

test("process-chatter: English agent action monologue is rejected (real live samples)", () => {
  const chatter = [
    "I'll search for recent high-impact hydrogen sensor papers.",
    "I'm hitting a couple of blockers. Let me try alternative sources.",
    "E-utilities works. Let me fetch summaries for these PMIDs.",
    "Found strong hits. Let me pull abstracts for the most relevant hydrogen sensor papers.",
    "The PDF is the Adv. Mater. paper I recommended. Let me read it.",
    "PyMuPDF is available. Let me extract the text.",
    "I need to check the experimental section first.",
    "I've loaded the document and will read section 2.2.",
    "Searching for the DOI across three databases.",
  ];
  for (const text of chatter) {
    assert.equal(isProcessChatter(text), true, `should reject: ${text}`);
  }
});

test("process-chatter: English factual statements are NOT rejected (no over-match)", () => {
  const facts = [
    "Adv. Mater. 2024 reports a 3.8 MB supplement for the thermocouple sensor.",
    "The device uses a catalytic exothermic reaction plus a thermocouple.",
    "retainTokens is set to 12000 in the eval config.",
    "The paper does not specify the thermocouple wire diameter.",
    "R_thermal was measured at 45 K/W under vacuum.",
  ];
  for (const text of facts) {
    assert.equal(isProcessChatter(text), false, `must keep: ${text}`);
  }
});

test("process-chatter: Chinese patterns still work (regression)", () => {
  assert.equal(isProcessChatter("好了，先看实测状态再决定"), true);
  assert.equal(isProcessChatter("关键证据在 index.js 14–15 行"), true);
  assert.equal(isProcessChatter("retainTokens 默认 12000，按 0.5 权重晋升"), false);
});
