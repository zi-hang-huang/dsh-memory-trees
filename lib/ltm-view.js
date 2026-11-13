/**
 * dsh-memory · LTM 记忆视图服务（v9 P2 路线①：插件加载时自起常驻服务）。
 *
 * 为什么单独成文件：插件宿主半 apply() 加载时调 startLtmViewServer()，卸载时 close。
 * 与 dsh-memory-eval/memory-view-server.js（独立手动脚本）逻辑一致，但这里作为插件
 * 模块，随插件一起发布/加载——用户无需手敲命令。
 *
 * 设计要点（保守，不拖垮插件）：
 *   - 端口固定默认 7788，被占用则静默放弃（不影响折叠/召回等核心功能）。
 *   - 纯只读：只在请求时读 ~/.dsh/storages/dsh_memory.json，不轮询、不写盘、不挂 watcher。
 *   - 只监听 127.0.0.1（本机），不对外。
 *   - 零第三方依赖：node 内置 http/fs/path/os。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { recall } from "./recall.js";
import { isLikelySingleTopic } from "./work-name.js";

/** 存储文件默认路径。 */
function storePath() {
  return path.join(os.homedir(), ".dsh", "storages", "dsh_memory.json");
}

/**
 * 读 dsh_memory.json，归约成面板 view-model（对齐 v9 方案 §2 的 ltm 部分）。
 * 记录存储形状：{ unit, global, tables: { records: { id: {...} } } }。
 */
export function buildLtmView(store = storePath()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(store, "utf8"));
  } catch (e) {
    return { error: `读存储失败: ${e.message}`, path: store };
  }
  const recTable = raw?.tables?.records;
  const all = recTable && typeof recTable === "object" ? Object.values(recTable) : [];
  const live = all.filter((r) => r && r.archived !== true && r.supersededAt == null);
  const members = live.filter((r) => r.kind !== "work-summary");
  const withWork = members.filter((r) => typeof r.work === "string" && r.work.length > 0);

  const groups = new Map();
  for (const r of members) {
    const key = typeof r.work === "string" && r.work ? r.work : "(无 work)";
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const pivotByWork = new Map();
  for (const r of live) {
    if (r.kind === "work-summary" && typeof r.work === "string") {
      const b = typeof r.body === "string" ? r.body : "";
      pivotByWork.set(r.work, b ? b.slice(0, 80) : null);
    }
  }
  const TEMP_RE = /^work:[a-z0-9]{4,24}$/;
  const works = [...groups.entries()]
    .map(([name, list]) => {
      const members = list.map((r) => ({
        title: String(r.title ?? "").slice(0, 80),
        work: name,
      }));
      // Guide the ✂️ split UI: a group whose member titles are highly alike is
      // almost certainly one topic — splitting it only makes fragments (and was
      // the historical trigger for the orphan-pivot bug). Computed server-side so
      // the client can grey out the button without shipping the heuristic.
      const st = isLikelySingleTopic(members.map((m) => m.title));
      return {
        name,
        count: list.length,
        isTemporary: TEMP_RE.test(name),
        pivotSummary: pivotByWork.get(name) ?? null,
        // v10: member previews for the split UI. Same store order the host-side splitWork
        // enumerates (m0..mN), so a preview / dryRun index maps onto the right record.
        members,
        singleTopic: st.singleTopic,
        topicScore: st.score,
      };
    })
    .sort((a, b) => b.count - a.count);

  const temporaryKeys = works.filter((w) => w.isTemporary).length;
  const emptyWork = members.filter((r) => !(typeof r.work === "string" && r.work)).length;

  return {
    version: 1,
    generatedAt: Date.now(),
    counts: { total: all.length, live: live.length, withWork: withWork.length },
    works,
    health: { temporaryKeys, emptyWork, oversized: 0, skipped: {} },
    sourcePath: store,
  };
}

/**
 * Recall 预览（v9 P3）：对给定查询跑一遍真实召回管线（filter → rank → trim → expand），
 * 返回「会召回哪些条目」。纯读取、无模型调用、无副作用——与 pre-step 自动召回走
 * 完全相同的 `recall()` 纯函数，所以预览结果就是模型真会看到的东西。
 *
 * @param {string} query - 用户输入的关键词。
 * @param {string} [store] - 存储路径，默认 ~/.dsh/storages/dsh_memory.json。
 * @param {object} [options] - {topK,minScore,maxExtra}。
 * @returns {{ok:boolean, query:string, count:number, hits:Array, expanded:Array, error?:string}}
 */
export function buildRecallPreview(query, store = storePath(), options = {}) {
  const q = typeof query === "string" ? query.trim() : "";
  if (q === "") return { ok: true, query: "", count: 0, hits: [], expanded: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(store, "utf8"));
  } catch (e) {
    return { ok: false, query: q, count: 0, hits: [], expanded: [], error: `读存储失败: ${e.message}` };
  }
  const recTable = raw?.tables?.records;
  const records = recTable && typeof recTable === "object" ? Object.values(recTable) : [];
  let result;
  try {
    result = recall(records, q, {
      topK: Number.isFinite(options.topK) ? options.topK : 5,
      minScore: Number.isFinite(options.minScore) ? options.minScore : 1.0,
      maxExtra: Number.isFinite(options.maxExtra) ? options.maxExtra : 2,
    });
  } catch (e) {
    return { ok: false, query: q, count: 0, hits: [], expanded: [], error: `召回失败: ${e.message}` };
  }
  const shape = (r) => ({
    title: String(r?.title ?? "").slice(0, 120),
    work: typeof r?.work === "string" ? r.work : null,
    kind: String(r?.kind ?? ""),
  });
  const hits = (result.hits ?? []).map(shape);
  const expanded = (result.expanded ?? []).map(shape);
  return { ok: true, query: q, count: hits.length + expanded.length, hits, expanded };
}

/** 页面 HTML（内嵌，自带「刷新」按钮，点了 fetch /data.json 重渲染）。 */
const PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>dsh-memory · LTM 记忆视图</title>
<style>
  :root{color-scheme:light dark}
  body{font:14px/1.55 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
       margin:0;padding:22px;max-width:860px;margin:0 auto;background:#1e1e20;color:#e6e6e6}
  @media (prefers-color-scheme:light){body{background:#fafafa;color:#222}}
  h1{font-size:17px;margin:0 0 4px}
  .bar{display:flex;align-items:center;gap:10px;margin-bottom:16px}
  button{font:inherit;padding:5px 14px;border-radius:7px;border:1px solid #555;background:#2d2d30;color:inherit;cursor:pointer}
  button:hover{background:#3a3a3d}
  @media (prefers-color-scheme:light){button{background:#fff;border-color:#ccc}}
  .muted{color:#8a8a8a;font-size:12px}
  h2{font-size:13px;margin:18px 0 6px;color:#9fb4d8}
  .kpi{display:flex;gap:22px;flex-wrap:wrap;margin:8px 0}
  .kpi div{font-size:12px;color:#8a8a8a}
  .kpi b{display:block;font-size:19px;color:inherit;font-weight:600}
  .seg{display:flex;height:12px;border-radius:6px;overflow:hidden;margin:8px 0}
  .row{display:flex;justify-content:space-between;padding:4px 0;border-top:1px solid rgba(128,128,128,.14)}
  .row:first-child{border-top:none}
  .woname{font-weight:500}
  .wtemp{color:#d9a441}
  .wcount{color:#8a8a8a;font-variant-numeric:tabular-nums}
  .psum{font-size:12px;color:#8a8a8a;margin-top:1px}
  .err{color:#e06c6c;padding:10px;border:1px solid #e06c6c;border-radius:8px}
  input#rq{color:#e8e8e8}
  input#rq::placeholder{color:#8a8a8a;opacity:1}
  @media (prefers-color-scheme:light){input#rq{background:#fff;color:#222;border-color:#ccc}}
</style></head>
<body>
  <div class="bar">
    <h1>LTM 记忆视图</h1>
    <button id="btn">⟳ 刷新</button>
    <button id="organize">🧹 整理全部记忆</button>
    <button id="splitbtn">✂️ 拆分组</button>
    <span class="muted" id="ts"></span>
  </div>
  <div id="orgmsg" class="muted" style="margin:-8px 0 10px"></div>
  <div id="splitbox" class="muted" style="margin:-8px 0 10px"></div>
  <h2 style="margin-top:16px">召回预览（输入关键词看会召回哪些记忆）</h2>
  <div class="bar" style="margin-bottom:8px">
    <input id="rq" type="text" placeholder="输入关键词，例如 AZIGZO / 专利 / 折叠…"
           style="flex:1;font:inherit;padding:6px 10px;border-radius:7px;border:1px solid #555;background:#2d2d30;color:#e8e8e8;caret-color:#e8e8e8">
    <button id="rbtn">🔍 预览召回</button>
  </div>
  <div id="rmsg" class="muted" style="margin:-4px 0 12px"></div>
  <div id="root" class="muted">加载中…</div>
<script>
const root = document.getElementById("root");
const ts = document.getElementById("ts");
function seg(t,total,color){return '<div style="width:'+(total>0?t/total*100:0)+'%;background:'+color+'"></div>';}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
function row(k,v){return '<div class="row"><span class="muted">'+k+'</span><span>'+v+'</span></div>';}
async function load(){
  try{
    const r = await fetch("/data.json", {cache:"no-store"});
    const v = await r.json();
    if(v.error){ root.innerHTML='<div class="err">'+esc(v.error)+'<br><span class="muted">'+esc(v.path||"")+'</span></div>'; return; }
    const c=v.counts, h=v.health;
    lastWorks = Array.isArray(v.works) ? v.works : [];
    let html="";
    html+='<h2>长期记忆</h2><div class="kpi">'+
      '<div><b>'+c.total+'</b>总记录</div>'+
      '<div><b>'+c.live+'</b>活跃</div>'+
      '<div><b>'+c.withWork+'</b>有 work</div>'+
      '<div><b>'+v.works.length+'</b>work 分组</div></div>';
    html+='<h2>健康</h2>'+
      row("临时键残留", h.temporaryKeys)+
      row("空 work", h.emptyWork)+
      row("超大项", h.oversized);
    const totalMembers = v.works.reduce((s,w)=>s+w.count,0);
    const palette=["#5b8def","#e0a64b","#6ec07a","#c07ad0","#e06c6c","#4bb5c1","#a0a0a0"];
    if(totalMembers>0){
      html+='<h2>work 条数占比</h2><div class="seg">';
      v.works.forEach((w,i)=>{html+=seg(w.count,totalMembers,palette[i%palette.length]);});
      html+='</div>';
    }
    html+='<h2>work 分组（'+v.works.length+'）</h2>';
    html+='<div class="bar" style="margin-bottom:8px"><input id="wf" type="text" placeholder="按 work 名过滤…" value="'+esc(workFilter)+'" style="flex:1;font:inherit;padding:5px 9px;border-radius:7px;border:1px solid #555;background:#2d2d30;color:inherit"></div>';
    html+='<div id="wlist"></div>';
    root.innerHTML=html;
    root.classList.remove("muted");
    document.getElementById("wf").addEventListener("input", function(e){ workFilter = e.target.value; renderWorkList(v.works); });
    renderWorkList(v.works);
    ts.textContent = "数据源于 " + (v.sourcePath||"") + " · " + new Date(v.generatedAt).toLocaleTimeString();
  }catch(e){ root.innerHTML='<div class="err">加载失败: '+esc(e.message)+'</div>'; }
}
// 渲染 work 列表：支持按名过滤 + 点开某 work 展开其成员标题。
let workFilter = "";
let expandedWork = {};
function renderWorkList(works){
  const box = document.getElementById("wlist");
  if(!box){ return; }
  const q = workFilter.trim().toLowerCase();
  const shown = (works||[]).filter(function(w){ return q==="" || String(w.name).toLowerCase().indexOf(q)>=0; });
  if(shown.length===0){ box.innerHTML='<div class="muted" style="padding:8px 0">没有匹配的 work。</div>'; return; }
  let html="";
  shown.forEach(function(w){
    const open = !!expandedWork[w.name];
    html+='<div class="row" style="cursor:pointer" data-work="'+esc(w.name)+'"><span class="woname">'+(open?'▾ ':'▸ ')+(w.isTemporary?'<span class="wtemp">⏳ </span>':'')+esc(w.name)+'</span><span class="wcount">'+w.count+'</span></div>';
    if(w.pivotSummary) html+='<div class="psum">'+esc(w.pivotSummary)+'</div>';
    if(open && Array.isArray(w.members) && w.members.length>0){
      html+='<div style="margin:2px 0 8px 18px">';
      w.members.forEach(function(m){ html+='<div class="muted" style="font-size:12px;padding:1px 0">• '+esc(m.title||"(无标题)")+'</div>'; });
      html+='</div>';
    }
  });
  box.innerHTML=html;
  Array.prototype.forEach.call(box.querySelectorAll(".row[data-work]"), function(r){
    r.addEventListener("click", function(){
      const k = r.getAttribute("data-work");
      expandedWork[k] = !expandedWork[k];
      renderWorkList(works);
    });
  });
}
// ── 召回预览（v9 P3）：GET /recall?q=... ──────────────────────────────────
async function recallPreview(){
  const msg = document.getElementById("rmsg");
  const q = (document.getElementById("rq").value || "").trim();
  if(q===""){ msg.textContent = "请先输入关键词。"; return; }
  msg.textContent = "查询中…";
  try{
    const r = await fetch("/recall?q="+encodeURIComponent(q), {cache:"no-store"});
    const v = await r.json();
    if(!v.ok){ msg.textContent = "预览失败：" + (v.error||"未知错误"); return; }
    const all = (v.hits||[]).concat(v.expanded||[]);
    if(all.length===0){ msg.textContent = "「"+q+"」没有召回任何记忆（可能低于打分门限，或库里无相关内容）。"; return; }
    let html='<div style="margin:2px 0 6px">「'+esc(q)+'」会召回 '+v.hits.length+' 条命中'+(v.expanded.length>0?' + '+v.expanded.length+' 条关联带出':'')+'：</div>';
    (v.hits||[]).forEach(function(h){ html+='<div class="row"><span class="woname">'+esc(h.title||"(无标题)")+'</span><span class="muted">'+esc((h.work||"").replace(/^work:/,""))+'</span></div>'; });
    if(v.expanded.length>0){
      html+='<div class="muted" style="margin:6px 0 2px">关联带出（同 work / 家族扩展）：</div>';
      v.expanded.forEach(function(h){ html+='<div class="row"><span class="woname" style="opacity:.85">'+esc(h.title||"(无标题)")+'</span><span class="muted">'+esc((h.work||"").replace(/^work:/,""))+'</span></div>'; });
    }
    msg.innerHTML = html;
  }catch(e){ msg.textContent = "预览失败：" + e.message; }
}
document.getElementById("rbtn").addEventListener("click", recallPreview);
document.getElementById("rq").addEventListener("keydown", function(e){ if(e.key==="Enter") recallPreview(); });
document.getElementById("btn").addEventListener("click", load);
// 整理全部记忆（两步，档3）：
//  1) 点「整理」→ POST /organize {dryRun:true} 拿「建议合并方案」，不写盘；
//  2) 弹确认：显示每组「A + B → C」，用户点「确认执行」→ POST /organize {plan:[...]} 写盘。
let pendingPlan = null;
async function organizePreview(){
  const msg = document.getElementById("orgmsg");
  const ob = document.getElementById("organize");
  ob.disabled = true;
  msg.innerHTML = "正在分析（调模型判断哪些工作应合并）…可能需要十几秒";
  try{
    const r = await fetch("/organize", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({dryRun:true})});
    const res = await r.json();
    if(!res.ok){ msg.textContent = "分析未生效：" + (res.reason || "未知原因"); return; }
    const plan = Array.isArray(res.plan) ? res.plan : [];
    if(plan.length === 0){ msg.textContent = "模型认为没有需要合并的工作（共 "+res.works+" 个分组）。"; return; }
    pendingPlan = plan;
    let html = '<div style="margin:6px 0 8px">建议合并方案（共 '+plan.length+' 组），确认后才会写入：</div>';
    plan.forEach(function(p){
      const froms = p.from.map(function(k){return esc(k.replace(/^work:/,''));}).join(' + ');
      html += '<div class="row"><span class="woname">'+froms+'</span><span style="color:#9fb4d8">→ '+esc(p.to)+'</span></div>';
    });
    html += '<div style="margin-top:10px"><button id="orgApply">✓ 确认执行</button> <button id="orgCancel" style="margin-left:8px">✗ 取消</button></div>';
    msg.innerHTML = html;
    document.getElementById("orgCancel").addEventListener("click", function(){ pendingPlan = null; msg.textContent = "已取消，未做任何修改。"; });
    document.getElementById("orgApply").addEventListener("click", organizeApply);
  }catch(e){
    msg.textContent = "分析失败：" + e.message;
  }finally{
    ob.disabled = false;
  }
}
async function organizeApply(){
  const msg = document.getElementById("orgmsg");
  if(!pendingPlan){ return; }
  msg.textContent = "正在执行合并…";
  try{
    const r = await fetch("/organize", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({plan:pendingPlan})});
    const res = await r.json();
    if(res.ok){
      msg.textContent = "整理完成：共 "+res.works+" 个工作，合并/重命名 "+res.renamed+" 项，新建枢轴 "+res.pivotsCreated+" 个";
    }else{
      msg.textContent = "执行未生效：" + (res.reason || "未知原因");
    }
  }catch(e){
    msg.textContent = "执行失败：" + e.message;
  }finally{
    pendingPlan = null;
    load();
  }
}
document.getElementById("organize").addEventListener("click", organizePreview);

// ── 拆分组（两步，档3）──────────────────────────────────────────────────────
//  0) 点「拆分组」→ 先列出所有 work 分组（条数≥2 的才可拆），点一个选定要拆的工作；
//  1) POST /split {work, dryRun:true} → 拿「建议拆分方案」，不写盘；
//  2) 显示每组「子组名 ← m0, m3 …」（带成员标题），点「确认拆开」→ POST /split {work, plan} 写盘。
let lastWorks = [];
document.getElementById("splitbtn").addEventListener("click", function(){
  const box = document.getElementById("splitbox");
  const pickable = (lastWorks||[]).filter(function(w){return w.count >= 2;});
  if(pickable.length === 0){ box.textContent = "没有可拆的分组（需至少 2 条记忆的工作）。"; return; }
  let html = '<div style="margin:6px 0 8px">选择要拆开的工作（点一个）：</div>';
  const splittable = pickable.filter(function(w){return !w.singleTopic;});
  if(splittable.length === 0){
    html += '<div class="muted" style="margin:4px 0 8px">所有分组都疑似「单一主题」——成员内容高度相似，拆开只会制造碎片，因此全部禁拆。</div>';
  }
  pickable.forEach(function(w,i){
    if(w.singleTopic){
      html += '<div class="row" style="opacity:.55"><button class="pickwork" disabled title="成员内容高度相似，疑似单一主题，不建议拆" style="margin-right:8px">'+esc(w.name.replace(/^work:/,''))+'</button><span class="wcount">'+w.count+' 条 · 单一主题，禁拆</span></div>';
    }else{
      html += '<div class="row"><button class="pickwork" data-work="'+esc(w.name)+'" style="margin-right:8px">'+esc(w.name.replace(/^work:/,''))+'</button><span class="wcount">'+w.count+' 条</span></div>';
    }
  });
  html += '<div style="margin-top:8px"><button id="splitCancel">✗ 取消</button></div>';
  box.innerHTML = html;
  Array.prototype.forEach.call(box.querySelectorAll(".pickwork[data-work]"), function(b){
    b.addEventListener("click", function(){ splitPreview(b.getAttribute("data-work")); });
  });
  document.getElementById("splitCancel").addEventListener("click", function(){ box.textContent=""; });
});

async function splitPreview(work){
  const box = document.getElementById("splitbox");
  const w = (lastWorks||[]).find(function(x){return x.name===work;});
  const lines = w && Array.isArray(w.members) ? w.members : [];
  box.innerHTML = "正在分析「"+esc(work.replace(/^work:/,''))+"」里的记忆该怎么拆…可能需要十几秒";
  try{
    const r = await fetch("/split", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({work:work, dryRun:true})});
    const res = await r.json();
    if(!res.ok){ box.textContent = "分析未生效：" + (res.reason || "未知原因"); return; }
    const plan = Array.isArray(res.plan) ? res.plan : [];
    if(plan.length <= 1){ box.textContent = "模型认为这组不需要拆（"+res.groups+" 组，共 "+res.members+" 条）。"; return; }
    pendingSplit = { work: work, plan: plan };
    let html = '<div style="margin:6px 0 8px">建议拆成 '+plan.length+' 组（确认后才写入）：</div>';
    plan.forEach(function(g){
      const mlist = (g.members||[]).map(function(idx){
        const m = lines[idx];
        return 'm'+idx+(m? "："+esc(m.title) : "");
      }).join('<br>');
      html += '<div class="row" style="align-items:flex-start"><span class="woname" style="flex:0 0 34%">'+esc(g.name)+'</span><span class="muted" style="flex:1">'+mlist+'</span></div>';
    });
    html += '<div style="margin-top:10px"><button id="splitApply">✓ 确认拆开</button> <button id="splitCancel2" style="margin-left:8px">✗ 取消</button></div>';
    box.innerHTML = html;
    document.getElementById("splitCancel2").addEventListener("click", function(){ pendingSplit=null; box.textContent="已取消，未做任何修改。"; });
    document.getElementById("splitApply").addEventListener("click", splitApply);
  }catch(e){
    box.textContent = "分析失败：" + e.message;
  }
}
let pendingSplit = null;
async function splitApply(){
  const box = document.getElementById("splitbox");
  if(!pendingSplit){ return; }
  box.textContent = "正在拆分…";
  try{
    const r = await fetch("/split", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({work:pendingSplit.work, plan:pendingSplit.plan})});
    const res = await r.json();
    if(res.ok){
      box.textContent = "拆分完成：从「"+res.work.replace(/^work:/,'')+"」移出 "+res.moved+" 条记忆，新建枢轴 "+res.pivotsCreated+" 个";
    }else{
      box.textContent = "执行未生效：" + (res.reason || "未知原因");
    }
  }catch(e){
    box.textContent = "执行失败：" + e.message;
  }finally{
    pendingSplit = null;
    load();
  }
}

load();
</script>
</body></html>`;

/**
 * 启动 LTM 视图服务。返回 { close } 或 null（端口被占等失败时静默返回 null）。
 * @param {{port?:number, store?:string, onOrganize?:() => Promise<any>, onSplit?:() => Promise<any>}} opts
 */
export function startLtmViewServer(opts = {}) {
  // port 0 = OS-assigned ephemeral port (used by tests); otherwise the requested port.
  const port = Number.isFinite(opts.port) ? Number(opts.port) : 7788;
  const store = opts.store || storePath();
  const onOrganize = typeof opts.onOrganize === "function" ? opts.onOrganize : null;
  const onSplit = typeof opts.onSplit === "function" ? opts.onSplit : null;
  // v10: synchronous getter returning the latest per-message context detail the
  // host half snapshotted in `agent/pre-step`. Returns null when no snapshot yet.
  const getContext = typeof opts.getContext === "function" ? opts.getContext : null;
  // v11: the Settings-page transport. `getSettings()` returns the plugin's own
  // fenced face ({ get(): {value, revision, writable} }) when the host mounted
  // the settings service, or undefined. `updateSettings(patch, revision)` writes
  // through the SAME settings service, so a save here is a live config edit.
  const getSettings = typeof opts.getSettings === "function" ? opts.getSettings : null;
  const updateSettings = typeof opts.updateSettings === "function" ? opts.updateSettings : null;
  // v12: self-tree (自我认知) store transport. Each returns a plain view
  // ({ nodes, revision, exists, kinds }) or throws; the routes map errors to 4xx/5xx.
  const getSelf = typeof opts.getSelf === "function" ? opts.getSelf : null;
  const updateSelf = typeof opts.updateSelf === "function" ? opts.updateSelf : null;
  const resetSelf = typeof opts.resetSelf === "function" ? opts.resetSelf : null;

  const server = http.createServer((req, res) => {
    const url = req.url || "/";
    // v10: this server is fetched from the DSH Web GUI on a different origin
    // (e.g. :64907 → :7788). Without CORS headers the browser rejects every
    // XHR/fetch with "Failed to fetch" even though curl works fine. Allow all
    // origins here — this is a localhost-only diagnostic server with no secrets.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    // Answer CORS preflight before any route logic.
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    // POST /organize — trigger a whole-store work reorganisation (v8-c-2). The model
    // call happens in the injected callback (the plugin host half owns ctx/llm).
    if (url.startsWith("/organize")) {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("POST only");
        return;
      }
      if (onOrganize === null) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, reason: "organize not wired in this host" }));
        return;
      }
      // Read an optional JSON body: { dryRun?: boolean, plan?: [{from:[],to:""}] }.
      // dryRun=true → preview only (step 1); plan provided → apply approved mapping (step 2).
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(); // 1MB guard
      });
      req.on("end", () => {
        let payload = {};
        if (body.trim() !== "") {
          try {
            payload = JSON.parse(body);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, reason: "bad JSON body" }));
            return;
          }
        }
        Promise.resolve()
          .then(() => onOrganize(payload))
          .then((result) => {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify(result ?? { ok: false, reason: "no result" }));
          })
          .catch((e) => {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, reason: String(e?.message ?? e) }));
          });
      });
      return;
    }
    // POST /split — split ONE over-merged work into sub-groups (v10). Body:
    // { work: "work:xxx", dryRun?: boolean, plan?: [{name, members:[...]}] }.
    if (url.startsWith("/split")) {
      if (req.method !== "POST") {
        res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("POST only");
        return;
      }
      if (onSplit === null) {
        res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, reason: "split not wired in this host" }));
        return;
      }
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1024 * 1024) req.destroy(); // 1MB guard
      });
      req.on("end", () => {
        let payload = {};
        if (body.trim() !== "") {
          try {
            payload = JSON.parse(body);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, reason: "bad JSON body" }));
            return;
          }
        }
        Promise.resolve()
          .then(() => onSplit(payload))
          .then((result) => {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify(result ?? { ok: false, reason: "no result" }));
          })
          .catch((e) => {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, reason: String(e?.message ?? e) }));
          });
      });
      return;
    }
    try {
      if (url === "/" || url.startsWith("/index")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(PAGE_HTML);
        return;
      }
      // GET /recall?q=... — recall preview (v9 P3). Runs the same pure recall() the
      // pre-step hook uses, so the preview shows exactly what the model would see.
      if (url.startsWith("/recall")) {
        const qs = new URLSearchParams(url.includes("?") ? url.slice(url.indexOf("?") + 1) : "");
        const view = buildRecallPreview(qs.get("q") ?? "", store);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(view));
        return;
      }
      if (url.startsWith("/data.json")) {
        const view = buildLtmView(store);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(view));
        return;
      }
      // GET /settings.get — current live values + revision for the Settings page.
      // Returns { ok:true, value, revision, writable } or a 503 envelope when the
      // host has no settings service (the page then renders read-only defaults).
      if (url.startsWith("/settings.get")) {
        const face = getSettings ? getSettings() : null;
        if (face === null || face === undefined) {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          res.end(JSON.stringify({ ok: false, reason: "settings service not mounted in this host" }));
          return;
        }
        const view = face.get();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, value: view.value, revision: view.revision, writable: view.writable }));
        return;
      }
      // POST /settings.update — write live fields { patch:{...}, expectedRevision? }.
      // The client always sends the full live set; only the plugin's LIVE_FIELDS
      // survive the server-side filter. A stale revision is refused so a concurrent
      // change is never silently overwritten.
      if (url.startsWith("/settings.update")) {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("POST only");
          return;
        }
        if (updateSettings === null) {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, reason: "settings service not mounted in this host" }));
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 256 * 1024) req.destroy(); // 256KB guard
        });
        req.on("end", () => {
          let payload = {};
          if (body.trim() !== "") {
            try {
              payload = JSON.parse(body);
            } catch {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, reason: "bad JSON body" }));
              return;
            }
          }
          const patch = payload && typeof payload.patch === "object" && payload.patch !== null ? payload.patch : {};
          const expected = Number.isFinite(payload?.expectedRevision) ? payload.expectedRevision : undefined;
          Promise.resolve()
            .then(() => updateSettings(patch, expected))
            .then((view) => {
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
              res.end(JSON.stringify({ ok: true, value: view.value, revision: view.revision, writable: view.writable }));
            })
            .catch((e) => {
              const conflict = e && e.code === "settings-conflict";
              res.writeHead(conflict ? 409 : 400, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, reason: String(e?.message ?? e) }));
            });
        });
        return;
      }
      // ---- v12: self tree (自我认知) read/write ---------------------------------
      // GET /self.get — current nodes + revision + kind vocabulary.
      if (url.startsWith("/self.get")) {
        if (getSelf === null) {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, reason: "self store not wired in this host" }));
          return;
        }
        const view = getSelf();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, ...view }));
        return;
      }
      // POST /self.update — { nodes:[{id?,kind?,order?,title,body}], expectedRevision? }.
      // 200 on success, 409 on a stale revision, 400 on a validation rejection.
      if (url.startsWith("/self.update")) {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("POST only");
          return;
        }
        if (updateSelf === null) {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, reason: "self store not wired in this host" }));
          return;
        }
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 256 * 1024) req.destroy(); // 256KB guard
        });
        req.on("end", () => {
          let payload = {};
          try {
            payload = body.trim() === "" ? {} : JSON.parse(body);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, reason: "bad JSON body" }));
            return;
          }
          const nodes = Array.isArray(payload?.nodes) ? payload.nodes : null;
          const expected = Number.isFinite(payload?.expectedRevision) ? payload.expectedRevision : undefined;
          Promise.resolve()
            .then(() => {
              if (nodes === null) throw new Error("缺少数组成员数组 nodes。");
              return updateSelf(nodes, expected);
            })
            .then((view) => {
              res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
              res.end(JSON.stringify({ ok: true, ...view }));
            })
            .catch((e) => {
              const conflict = e && e.code === "self-conflict";
              res.writeHead(conflict ? 409 : 400, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, reason: String(e?.message ?? e) }));
            });
        });
        return;
      }
      // POST /self.reset — write the default four nodes back (deterministic in every session).
      if (url.startsWith("/self.reset")) {
        if (req.method !== "POST") {
          res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("POST only");
          return;
        }
        if (resetSelf === null) {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, reason: "self store not wired in this host" }));
          return;
        }
        Promise.resolve()
          .then(() => resetSelf())
          .then((view) => {
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ ok: true, ...view }));
          })
          .catch((e) => {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, reason: String(e?.message ?? e) }));
          });
        return;
      }
      // GET /context.json — per-message context detail for the CURRENT session,
      // snapshotted by the host half in `agent/pre-step` (v10). Returns
      // { ready:false } until the first step has run.
      if (url.startsWith("/context.json")) {        const detail = getContext ? getContext() : null;
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(detail ?? { ready: false }));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("not found");
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(String(e));
    }
  });
  let failed = false;
  server.on("error", () => {
    failed = true;
  });
  try {
    server.listen(port, "127.0.0.1");
  } catch {
    return null;
  }
  return {
    // Report the actual bound port (relevant when port 0 requested an ephemeral one).
    // Before listen() completes address() may be null, so fall back to the requested port.
    get port() {
      const addr = server.address();
      return addr && typeof addr === "object" ? addr.port : port;
    },
    close: () => {
      try {
        server.close();
      } catch {
        /* ignore */
      }
    },
    get failed() {
      return failed;
    },
  };
}
