/**
 * Tests for lib/ltm-view.js — recall preview pure function + the local view server's
 * /recall and / endpoints. No host imports: buildRecallPreview reads a JSON file off
 * disk, the server listens on an ephemeral port and is hit with fetch.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildRecallPreview, buildLtmView, startLtmViewServer } from "../lib/ltm-view.js";
import { readSelfState, selfView, writeSelfOverride, resetSelfOverride } from "../lib/self-store.js";

/** Write a temp dsh_memory.json in the store shape and return its path. */
function tempStore(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-mem-view-"));
  const file = path.join(dir, "dsh_memory.json");
  const table = {};
  for (const r of records) table[r.id] = r;
  fs.writeFileSync(file, JSON.stringify({ unit: "x", global: {}, tables: { records: table } }), "utf8");
  return file;
}

function rec(id, over = {}) {
  return {
    id,
    zone: "recall",
    kind: "decision",
    title: "t",
    body: "b",
    weight: 0.8,
    pinned: false,
    rev: 1,
    born: 1,
    archived: false,
    firstSeenTurn: 1,
    hits: 1,
    ...over,
  };
}

test("buildRecallPreview: empty query returns empty, ok=true", () => {
  const store = tempStore([rec("a", { title: "专利答复", body: "专利预审答复的打法" })]);
  const p = buildRecallPreview("", store);
  assert.equal(p.ok, true);
  assert.equal(p.count, 0);
  assert.deepEqual(p.hits, []);
});

test("buildRecallPreview: matching query returns hits with work/kind", () => {
  const store = tempStore([
    rec("a", { title: "专利预审答复", body: "预审答复的核心打法", work: "work:专利" }),
    rec("b", { title: "无关记录", body: "完全不相干的内容" }),
  ]);
  const p = buildRecallPreview("预审答复", store);
  assert.equal(p.ok, true);
  assert.ok(p.count >= 1, `expected >=1 hit, got ${p.count}`);
  assert.equal(p.hits[0].title, "专利预审答复");
  assert.equal(p.hits[0].work, "work:专利");
  assert.equal(p.hits[0].kind, "decision");
});

test("buildRecallPreview: noise query recalls nothing", () => {
  const store = tempStore([rec("a", { title: "专利预审答复", body: "预审答复的核心打法" })]);
  const p = buildRecallPreview("量子纠缠超导", store);
  assert.equal(p.ok, true);
  assert.equal(p.count, 0);
});

test("buildRecallPreview: missing store file → ok=false with error", () => {
  const p = buildRecallPreview("x", path.join(os.tmpdir(), "definitely-not-here-xyz.json"));
  assert.equal(p.ok, false);
  assert.match(p.error, /读存储失败/);
});

test("buildLtmView: groups members and reports pivot summary", () => {
  const store = tempStore([
    rec("a", { work: "work:x", title: "m1" }),
    rec("b", { work: "work:x", title: "m2" }),
    rec("p", { work: "work:x", kind: "work-summary", title: "x", body: "这是 x 的摘要" }),
  ]);
  const v = buildLtmView(store);
  const x = v.works.find((w) => w.name === "work:x");
  assert.ok(x);
  assert.equal(x.count, 2); // work-summary excluded from members
  assert.equal(x.pivotSummary, "这是 x 的摘要");
  assert.equal(x.members.length, 2);
});

test("server: GET /recall?q= returns JSON preview; GET / serves HTML", async () => {  const store = tempStore([rec("a", { title: "专利预审答复", body: "预审答复的核心打法与实操要点", work: "work:专利" })]);
  const handle = startLtmViewServer({ port: 0, store });
  assert.ok(handle, "server should start");
  // listen() is async; wait until the ephemeral port is assigned.
  let port = handle.port;
  for (let i = 0; i < 50 && !port; i++) {
    await new Promise((r) => setTimeout(r, 20));
    port = handle.port;
  }
  assert.ok(port && port > 0, `expected a bound port, got ${port}`);
  try {
    const r1 = await fetch(`http://127.0.0.1:${port}/recall?q=${encodeURIComponent("预审答复")}`);
    assert.equal(r1.status, 200);
    const body = await r1.json();
    assert.equal(body.ok, true);
    assert.ok(body.count >= 1);

    const r2 = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(r2.status, 200);
    const html = await r2.text();
    assert.match(html, /召回预览/);
  } finally {
    handle.close();
  }
});

// ---------------------------------------------------------------------------
// v12: self-tree (自我认知) routes.
// ---------------------------------------------------------------------------

/** Start a server wired to a temp self-store file; resolve once the port binds. */
async function startSelfServer(file) {
  const store = tempStore([rec("a")]);
  const handle = startLtmViewServer({
    port: 0,
    store,
    getSelf: () => selfView(readSelfState(file)),
    updateSelf: (nodes, rev) => selfView(writeSelfOverride(nodes, rev, file)),
    resetSelf: () => selfView(resetSelfOverride(file)),
  });
  let port = handle.port;
  for (let i = 0; i < 50 && !port; i++) {
    await new Promise((r) => setTimeout(r, 20));
    port = handle.port;
  }
  assert.ok(port && port > 0, `expected a bound port, got ${port}`);
  return { handle, base: `http://127.0.0.1:${port}` };
}

/** A path in a fresh temp dir (not created yet). */
function tempSelfFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-self-route-"));
  return path.join(dir, "dsh_memory_self.json");
}

test("server: GET /self.get → defaults, exists=false, kinds present", async () => {
  const file = tempSelfFile();
  const { handle, base } = await startSelfServer(file);
  try {
    const r = await fetch(`${base}/self.get`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.exists, false);
    assert.equal(body.revision, 0);
    assert.equal(body.nodes.length, 4);
    assert.ok(body.kinds.includes("identity"));
  } finally {
    handle.close();
  }
});

test("server: POST /self.update persists and GET reflects it", async () => {
  const file = tempSelfFile();
  const { handle, base } = await startSelfServer(file);
  try {
    const upd = await fetch(`${base}/self.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nodes: [
          { id: "self-identity", title: "身份", body: "新身份描述" },
          { title: "自定义约定", body: "永远先备份" },
        ],
      }),
    });
    assert.equal(upd.status, 200);
    const ub = await upd.json();
    assert.equal(ub.ok, true);
    assert.equal(ub.revision, 1);
    assert.equal(ub.nodes.length, 2);

    const got = await (await fetch(`${base}/self.get`)).json();
    assert.equal(got.exists, true);
    assert.equal(got.nodes[0].body, "新身份描述");
    assert.equal(got.nodes[1].title, "自定义约定");
  } finally {
    handle.close();
  }
});

test("server: POST /self.update with a stale revision → 409", async () => {
  const file = tempSelfFile();
  const { handle, base } = await startSelfServer(file);
  try {
    await fetch(`${base}/self.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: [{ title: "身份", body: "v1" }] }),
    }); // revision 1
    const stale = await fetch(`${base}/self.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: [{ title: "身份", body: "v2" }], expectedRevision: 7 }),
    });
    assert.equal(stale.status, 409);
    const sb = await stale.json();
    assert.equal(sb.ok, false);
  } finally {
    handle.close();
  }
});

test("server: POST /self.update with empty nodes → 400 (not 500)", async () => {
  const file = tempSelfFile();
  const { handle, base } = await startSelfServer(file);
  try {
    const r = await fetch(`${base}/self.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: [] }),
    });
    assert.equal(r.status, 400);
    const b = await r.json();
    assert.equal(b.ok, false);
    assert.match(b.reason, /至少/);
  } finally {
    handle.close();
  }
});

test("server: POST /self.reset → 4 default nodes", async () => {
  const file = tempSelfFile();
  const { handle, base } = await startSelfServer(file);
  try {
    await fetch(`${base}/self.update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nodes: [{ title: "只剩一条", body: "x" }] }),
    });
    const r = await fetch(`${base}/self.reset`, { method: "POST" });
    assert.equal(r.status, 200);
    const b = await r.json();
    assert.equal(b.ok, true);
    assert.equal(b.nodes.length, 4);
    assert.deepEqual(b.nodes.map((n) => n.title), ["身份", "取舍", "边界", "长期约定"]);
  } finally {
    handle.close();
  }
});

test("server: GET /self.get with no self store wired → 503", async () => {
  const store = tempStore([rec("a")]);
  const handle = startLtmViewServer({ port: 0, store });
  let port = handle.port;
  for (let i = 0; i < 50 && !port; i++) {
    await new Promise((r) => setTimeout(r, 20));
    port = handle.port;
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/self.get`);
    assert.equal(r.status, 503);
    const b = await r.json();
    assert.equal(b.ok, false);
  } finally {
    handle.close();
  }
});
