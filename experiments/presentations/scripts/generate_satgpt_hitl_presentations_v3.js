const fs = require("fs");
const path = require("path");
const Module = require("module");
process.env.NODE_PATH = "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules";
Module._initPaths();

const PptxGenJS = require("pptxgenjs");
const sharp = require("sharp");
const JSZip = require("jszip");

const ROOT = "E:/GMS/Flood/SatGPT-app";
const OUT = path.join(ROOT, "outputs");
const PREVIEW = path.join(OUT, "SatGPT_HITL_Geospatial_Agent_Talk_preview");
const ASSETS = path.join(OUT, "satgpt_hitl_presentations_v3_assets");
const PPTX = path.join(OUT, "SatGPT_HITL_Geospatial_Agent_Talk.pptx");
const QA = path.join(PREVIEW, "qa_report.json");
const NODE = "C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe";

const W = 13.333, H = 7.5, EMU = 914400;
const C = {
  paper: "F7F8F3", paper2: "EEF3EA", ink: "102033", muted: "667085",
  navy: "0B1220", blue: "18A0FB", red: "EF4444", green: "0B7A53",
  green2: "2AA36B", gray: "DDE5DD", line: "C7D2C6", white: "FFFFFF",
  amber: "F59E0B", water: "CFEFFF"
};
const FONT_H = "Aptos Display";
const FONT_B = "Aptos";
const FONT_M = "Cascadia Mono";

let pptx;
let slideNo = 0;
const objects = [];

function mkdirClean(dir) { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); }
function exists(p) { return fs.existsSync(p); }

function note(s, arr) { s.addNotes(arr); }
function track(kind, x, y, w, h, text = "") { objects.push({ slide: slideNo, kind, x, y, w, h, text }); }
function t(s, text, x, y, w, h, o = {}) {
  s.addText(text, {
    x, y, w, h, margin: o.margin ?? 0.02, fit: "shrink",
    fontFace: o.fontFace || FONT_B, fontSize: o.size || 16, color: o.color || C.ink,
    bold: !!o.bold, italic: !!o.italic, align: o.align || "left", valign: o.valign || "mid",
    breakLine: false, paraSpaceAfterPt: 0,
  });
  track("text", x, y, w, h, text);
}
function line(s, x1, y1, x2, y2, color = C.ink, w = 1) {
  s.addShape(pptx.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color, width: w } });
}
function arrow(s, x1, y1, x2, y2, color = C.ink, w = 1.2) {
  s.addShape(pptx.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color, width: w, endArrowType: "triangle" } });
}
function rect(s, x, y, w, h, fill, lineColor = null, radius = false, trans = 0) {
  s.addShape(radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, {
    x, y, w, h, rectRadius: 0.03,
    fill: { color: fill, transparency: trans },
    line: lineColor ? { color: lineColor, width: 1 } : { transparency: 100 },
  });
  track("shape", x, y, w, h);
}
function bg(s, mode = "paper") {
  s.background = { color: mode === "dark" ? C.navy : C.paper };
  rect(s, 0, 0, W, H, mode === "dark" ? C.navy : C.paper);
}
function brand(s, assets, dark = false) {
  line(s, 0.58, 7.02, 12.18, 7.02, dark ? "294156" : C.line, 0.8);
  t(s, "Nanjing Normal University · SatGPT Pro", 0.65, 7.12, 3.3, 0.16, { size: 7.5, fontFace: FONT_M, color: dark ? "B8C7D6" : C.muted });
  t(s, String(slideNo).padStart(2, "0"), 12.0, 7.12, 0.42, 0.16, { size: 7.5, fontFace: FONT_M, color: dark ? "B8C7D6" : C.muted, align: "right" });
  if (assets.logo) s.addImage({ path: assets.logo, x: 10.0, y: 6.82, w: 1.95, h: 0.33, transparency: dark ? 10 : 0 });
}
function title(s, main, sub, assets, dark = false) {
  t(s, main, 0.72, 0.55, 8.9, 0.55, { size: 27, fontFace: FONT_H, color: dark ? C.white : C.ink });
  if (sub) t(s, sub, 0.74, 1.16, 8.6, 0.24, { size: 9.5, fontFace: FONT_M, color: dark ? "AAB7C5" : C.muted });
  line(s, 0.74, 1.52, 1.9, 1.52, dark ? C.blue : C.green, 2.2);
  brand(s, assets, dark);
}
function node(s, label, x, y, w, h, color = C.blue, fill = C.white, txt = C.ink) {
  rect(s, x, y, w, h, fill, color, true);
  t(s, label, x + 0.09, y + 0.04, w - 0.18, h - 0.08, { size: 10.5, bold: true, align: "center", color: txt });
}
function pill(s, label, x, y, w, color = C.blue, fill = C.white) {
  rect(s, x, y, w, 0.28, fill, color, true);
  t(s, label, x + 0.07, y + 0.06, w - 0.14, 0.12, { size: 7.4, fontFace: FONT_M, color, align: "center", bold: true });
}

async function assets() {
  mkdirClean(ASSETS);
  fs.mkdirSync(PREVIEW, { recursive: true });
  const src1 = path.join(ROOT, "satgpt-agent-panel-mode-toggle.png");
  const src2 = path.join(ROOT, "satgpt-panel-compact-toggle.png");
  const logoSrc = path.join(OUT, "nsnu_template_assets", "image2.png");
  const logo = path.join(ASSETS, "nnu_logo.png");
  const cover = path.join(ASSETS, "cover_map.png");
  const map = path.join(ASSETS, "map_clean.png");
  const ui = path.join(ASSETS, "ui_panel.png");
  const modal = path.join(ASSETS, "confirmation_modal.png");
  if (exists(logoSrc)) await sharp(logoSrc).trim({ background: "#ffffff" }).resize({ width: 900 }).png().toFile(logo);
  await sharp(src1).resize(1920, 1080, { fit: "cover" }).modulate({ brightness: 0.88, saturation: 0.88 }).png().toFile(cover);
  await sharp(src2).resize(1500, 844, { fit: "cover" }).png().toFile(map);
  await sharp(src1).extract({ left: 840, top: 0, width: 440, height: 900 }).resize(740, 900).png().toFile(ui);
  await sharp(src1).extract({ left: 0, top: 0, width: 345, height: 900 }).resize(520, 900).png().toFile(modal);
  return { logo: exists(logo) ? logo : null, cover, map, ui, modal };
}

function addSlide() { slideNo += 1; const s = pptx.addSlide(); return s; }

function s1(a) {
  const s = addSlide(); s.background = { color: C.navy };
  s.addImage({ path: a.cover, x: 0, y: 0, w: W, h: H });
  rect(s, 0, 0, W, H, C.white, null, false, 16);
  rect(s, 0, 0, 5.05, H, C.paper, null, false, 0);
  line(s, 5.05, 0, 5.05, H, C.green, 2);
  t(s, "Human-in-the-Loop\nGeospatial Agent\nDesign", 0.72, 1.08, 4.05, 1.6, { size: 30, fontFace: FONT_H, bold: true });
  t(s, "for SatGPT Pro Flood Analysis", 0.76, 2.9, 3.9, 0.3, { size: 16, color: C.green, fontFace: FONT_H });
  t(s, "Making AI-assisted flood mapping controllable,\nreviewable, and executable", 0.76, 3.52, 3.85, 0.52, { size: 12.5, color: C.muted });
  pill(s, "10 MIN TECHNICAL TALK", 0.76, 5.32, 1.75, C.green, C.paper);
  pill(s, "MAP EVIDENCE", 2.72, 5.32, 1.3, C.red, C.paper);
  brand(s, a);
  note(s, ["讲法：开场只建立一个判断：SatGPT Pro 的技术价值不是会聊天，而是把洪水制图变成可审查、可执行、可复现的控制链。"]);
}

function s2(a) {
  const s = addSlide(); bg(s); title(s, "Human-in-the-Loop Is a Control Loop", "AI proposes -> Human reviews -> System executes -> Results feed back", a);
  const cx = 6.65, cy = 3.95;
  s.addShape(pptx.ShapeType.arc, { x: 3.1, y: 1.85, w: 7.1, h: 4.5, line: { color: C.line, width: 3 } });
  node(s, "AI proposes", 1.1, 3.35, 1.8, 0.55, C.blue);
  node(s, "Human reviews", 5.3, 1.95, 2.1, 0.55, C.red);
  node(s, "System executes", 10.05, 3.35, 2.05, 0.55, C.green);
  node(s, "Results feed back", 5.15, 5.67, 2.35, 0.55, C.amber);
  arrow(s, 2.9, 3.62, 5.3, 2.23, C.blue, 1.5); arrow(s, 7.4, 2.23, 10.05, 3.62, C.red, 1.5);
  arrow(s, 10.8, 3.95, 7.15, 5.67, C.green, 1.5); arrow(s, 5.15, 5.95, 2.35, 3.9, C.amber, 1.5);
  t(s, "decision\nboundary", cx - 0.92, cy - 0.4, 1.84, 0.8, { size: 24, fontFace: FONT_H, bold: true, align: "center", color: C.navy });
  t(s, "HITL is a feedback control system for assumptions with spatial consequences.", 0.85, 6.35, 7.6, 0.38, { size: 17, fontFace: FONT_H });
  note(s, ["讲法：HITL 不是 UI 上多一个确认按钮，而是把人类判断放进 AI 决策循环。像 FPS 里的开火权：自动瞄准可以建议，但最后目标确认必须可控。"]);
}

function s3(a) {
  const s = addSlide(); bg(s); title(s, "Flood Mapping Is Not Just Text Generation", "A flood analysis request hides assumptions: event, dates, spatial scope, datasets, execution workflow.", a);
  t(s, "A single request can contain five hidden decisions.", 0.85, 2.0, 5.2, 0.6, { size: 30, fontFace: FONT_H, bold: true });
  t(s, "If one is wrong, the map can look precise while being conceptually wrong.", 0.88, 2.82, 4.8, 0.5, { size: 14, color: C.muted });
  const labels = [["event", C.red], ["dates", C.amber], ["spatial scope", C.blue], ["datasets", C.green], ["workflow", C.ink]];
  labels.forEach(([l, c], i) => { const y = 1.95 + i * 0.78; line(s, 7.05, y + 0.2, 8.55, y + 0.2, c, 3); t(s, l, 8.75, y, 2.1, 0.35, { size: 20, fontFace: FONT_H, color: c, bold: true }); });
  rect(s, 6.5, 1.72, 5.2, 4.55, C.white, C.line, false);
  t(s, "\"Map the flood impact.\"", 6.85, 5.42, 3.6, 0.32, { size: 18, fontFace: FONT_M, color: C.navy });
  note(s, ["讲法：这页只讲本质：洪水制图不是生成一段文字，而是把一组空间假设落成地图。HITL 的任务就是把隐含假设显性化。"]);
}

function s4(a) {
  const s = addSlide(); bg(s); title(s, "How Can SatGPT Pro Implement HITL?", "Insert a control layer between LLM assumptions and Earth Engine execution.", a);
  const xs = [0.8, 3.05, 5.2, 7.85, 10.2];
  const labs = ["Natural-language\nrequest", "LLM\nassumptions", "Human review\ncheckpoint", "Earth Engine\nexecution", "Map\nevidence"];
  labs.forEach((l, i) => node(s, l, xs[i], 3.2, i === 2 ? 2.0 : 1.55, 0.72, i === 2 ? C.red : C.ink, C.paper));
  for (let i = 0; i < 4; i++) arrow(s, xs[i] + (i === 2 ? 2.0 : 1.55), 3.56, xs[i + 1] - 0.08, 3.56, i === 1 ? C.red : C.ink, 1.35);
  t(s, "The checkpoint converts uncertain language into confirmed geospatial parameters.", 0.88, 5.25, 6.8, 0.42, { size: 21, fontFace: FONT_H, bold: true });
  note(s, ["讲法：这页回答设计问题：不要让 LLM 直接驱动 GEE，中间必须有 review checkpoint，把语言假设转成确认后的空间参数。"]);
}

function s5(a) {
  const s = addSlide(); bg(s); title(s, "From Conversation to Stateful Workflow", "LangGraph turns one chat into typed workflow responsibilities.", a);
  const steps = ["intent", "chat", "extraction", "pre-confirmation", "confirmation", "processing"];
  steps.forEach((l, i) => { const x = 0.75 + i * 2.05; t(s, String(i + 1).padStart(2, "0"), x, 2.55, 0.45, 0.2, { size: 8, fontFace: FONT_M, color: i === 4 ? C.red : C.green }); node(s, l, x, 2.95, 1.55, 0.55, i === 4 ? C.red : C.green, C.white); if (i < 5) arrow(s, x + 1.55, 3.22, x + 1.94, 3.22, i === 3 ? C.red : C.green, 1.2); });
  rect(s, 0.9, 4.65, 5.6, 0.78, C.paper2, null, false);
  t(s, "State is the design tool: each node narrows what the next node is allowed to decide.", 1.12, 4.82, 5.2, 0.34, { size: 17, fontFace: FONT_H });
  t(s, "Code evidence: agent/flood_agent.py", 7.55, 5.02, 3.4, 0.18, { size: 8.5, fontFace: FONT_M, color: C.muted });
  note(s, ["讲法：引用 flood_agent.py 作为证据即可，不逐行讲。StateGraph 把聊天拆成状态机，confirmation_node 是控制点。"]);
}

function s6(a) {
  const s = addSlide(); bg(s); title(s, "The Review Checkpoint Exposes AI Assumptions", "Hidden guesses become editable review parameters.", a);
  rect(s, 1.0, 2.0, 4.0, 4.25, C.white, C.line, true); t(s, "Review surface", 1.28, 2.28, 2.2, 0.3, { size: 20, fontFace: FONT_H, bold: true });
  const fields = ["Event name", "Description", "Location", "Pre / peak / post dates", "Resolved AOI", "Recommended layers"];
  fields.forEach((f, i) => { const y = 2.9 + i * 0.46; line(s, 1.32, y + 0.16, 1.65, y + 0.16, i >= 4 ? C.red : C.blue, 2.2); t(s, f, 1.82, y, 2.55, 0.27, { size: 12.5, color: C.ink }); });
  s.addImage({ path: a.ui, x: 7.55, y: 1.78, w: 3.2, h: 4.1 });
  t(s, "Experts review variables,\nnot prose.", 5.35, 3.12, 2.3, 0.78, { size: 25, fontFace: FONT_H, bold: true, color: C.red });
  t(s, "Code evidence: confirmation_node / EventConfirmation.js", 5.38, 4.22, 3.2, 0.18, { size: 8, fontFace: FONT_M, color: C.muted });
  note(s, ["讲法：EventConfirmation.js 里有字段编辑、AOI 绑定、图层勾选和 Confirm/Cancel。HITL 在这里从概念变成产品交互。"]);
}

function s7(a) {
  const s = addSlide(); bg(s); title(s, "Reviewing Where and What to Compute", "HITL reviews spatial scope, temporal window, and dataset/layer selection.", a);
  s.addImage({ path: a.map, x: 0.78, y: 2.0, w: 4.0, h: 2.25 });
  t(s, "spatial scope", 0.78, 4.55, 2.0, 0.35, { size: 20, fontFace: FONT_H, color: C.blue, bold: true });
  line(s, 5.55, 3.15, 8.05, 3.15, C.amber, 3); [5.55, 6.8, 8.05].forEach((x, i) => rect(s, x - 0.07, 3.08, 0.14, 0.14, i === 1 ? C.red : C.amber, null, true));
  t(s, "temporal window", 5.38, 4.55, 2.25, 0.35, { size: 20, fontFace: FONT_H, color: C.amber, bold: true });
  ["DSWX", "Global Flood DB", "JRC Water", "HydroSHEDS"].forEach((l, i) => node(s, l, 9.25, 2.25 + i * 0.55, 2.2, 0.35, C.green, C.white));
  t(s, "dataset selection", 9.15, 4.55, 2.6, 0.35, { size: 20, fontFace: FONT_H, color: C.green, bold: true });
  t(s, "HITL is not just AOI upload. It controls where and what to compute.", 0.82, 5.78, 7.8, 0.42, { size: 21, fontFace: FONT_H, bold: true });
  note(s, ["讲法：AOI 只是 where，图层和时间窗是 what/when。把三者放进同一个 review loop，才是 GIS 场景里的 HITL。"]);
}

function s8(a) {
  const s = addSlide(); bg(s); title(s, "Dataset Registry Constrains LLM Output to Executable Assets", "The registry is the execution contract between language and GEE.", a);
  const rows = [["asset_id", "which Earth Engine asset can be called"], ["selection_profile", "when it should be recommended"], ["render_profile", "how the layer should be visualized"], ["legend_spec", "how users read the map"], ["execution_profile", "how GEE should execute it"]];
  rows.forEach(([k, v], i) => { const y = 2.0 + i * 0.72; line(s, 1.0, y + 0.34, 11.2, y + 0.34, C.line, 0.8); t(s, k, 1.08, y, 2.7, 0.35, { size: 18, fontFace: FONT_M, color: i === 4 ? C.red : C.green, bold: true }); t(s, v, 4.15, y, 5.8, 0.35, { size: 16, color: C.ink }); });
  t(s, "This prevents the model from merely saying \"use Sentinel-1\".", 1.05, 6.08, 6.2, 0.38, { size: 21, fontFace: FONT_H, bold: true });
  t(s, "Code evidence: flood_dataset_service.py / flood_dataset_registry.json", 7.2, 6.22, 4.5, 0.18, { size: 8, fontFace: FONT_M, color: C.muted, align: "right" });
  note(s, ["讲法：registry 是执行合同。LLM 输出必须落到 asset_id、渲染参数、图例和执行策略，否则就只是口头建议。"]);
}

function s9(a) {
  const s = addSlide(); bg(s, "dark"); title(s, "Controlled Execution Produces Map Evidence", "confirmed event + AOI + selected layers -> GEE processing -> tile URLs -> map visualization -> report / GEE code", a, true);
  s.addImage({ path: a.map, x: 0.75, y: 1.75, w: 6.5, h: 3.65 });
  rect(s, 0.75, 1.75, 6.5, 3.65, C.navy, C.blue, false, 92);
  const steps = ["confirmed\nparameters", "GEE\nprocessing", "tile URLs", "map\nevidence", "report /\nGEE code"];
  steps.forEach((l, i) => { const y = 2.0 + i * 0.68; node(s, l, 8.05, y, 1.65, 0.48, i < 2 ? C.blue : C.red, C.navy, C.white); if (i < 4) arrow(s, 9.7, y + 0.24, 10.22, y + 0.58, i < 2 ? C.blue : C.red, 1.1); });
  t(s, "Map evidence is the artifact experts can inspect.", 0.9, 5.78, 6.6, 0.4, { size: 24, fontFace: FONT_H, color: C.white, bold: true });
  t(s, "Code evidence: gee_service.py / AgentPanel.js", 8.05, 5.82, 3.5, 0.18, { size: 8, fontFace: FONT_M, color: "AAB7C5" });
  note(s, ["讲法：gee_service.py 生成 tile_url，AgentPanel.js 把 tile_url、图例、报告和 GEE code 暴露给用户。结果不是报告文本，而是可检查地图证据。"]);
}

function s10(a) {
  const s = addSlide(); bg(s); title(s, "Demo: One HITL-Controlled Flood Analysis Flow", "Ask -> extract event parameters -> confirm event/AOI/layers -> render map evidence -> export report/GEE code", a);
  const steps = [["Ask", "natural request"], ["Extract", "event parameters"], ["Confirm", "event / AOI / layers"], ["Render", "map evidence"], ["Export", "report / GEE code"]];
  steps.forEach(([h, b], i) => { const x = 0.85 + i * 2.35; t(s, `0${i + 1}`, x, 2.15, 0.5, 0.2, { size: 8, fontFace: FONT_M, color: i === 2 ? C.red : C.green, bold: true }); t(s, h, x, 2.55, 1.45, 0.34, { size: 22, fontFace: FONT_H, bold: true }); t(s, b, x, 3.05, 1.65, 0.28, { size: 10.5, color: C.muted }); line(s, x, 3.58, x + 1.6, 3.58, i === 2 ? C.red : C.green, 2.2); if (i < 4) arrow(s, x + 1.65, 2.74, x + 2.16, 2.74, C.line, 1); });
  s.addImage({ path: a.ui, x: 4.78, y: 4.15, w: 2.25, h: 1.78 });
  s.addImage({ path: a.map, x: 7.25, y: 4.15, w: 3.15, h: 1.78 });
  t(s, "Show the control chain, not a feature tour.", 0.9, 5.55, 3.45, 0.36, { size: 20, fontFace: FONT_H, bold: true });
  note(s, ["讲法：Demo 按 Ask、Extract、Confirm、Render、Export 五步走，别做功能漫游。每一步都有明确反馈，节奏会稳很多。"]);
}

function s11(a) {
  const s = addSlide(); bg(s); title(s, "Toward Controllable AI-Assisted Geospatial Workflows", "The goal is faster expert work, not expert replacement.", a);
  t(s, "The goal is not to replace\ngeospatial experts.", 0.92, 2.0, 6.2, 0.9, { size: 35, fontFace: FONT_H, bold: true });
  t(s, "It is to make AI-assisted flood analysis\nmore explicit, controllable, and reproducible.", 0.95, 3.45, 7.2, 0.72, { size: 24, fontFace: FONT_H, color: C.green, bold: true });
  ["language", "parameters", "execution", "evidence"].forEach((l, i) => { node(s, l, 1.0 + i * 2.35, 5.2, 1.65, 0.45, i === 3 ? C.red : C.ink, C.white); if (i < 3) arrow(s, 2.65 + i * 2.35, 5.43, 3.25 + i * 2.35, 5.43, C.line, 1.1); });
  note(s, ["讲法：结论回到边界：AI 不替代 GIS 专家，而是把语言、参数、执行和证据串成可控链条。"]);
}

async function build() {
  mkdirClean(PREVIEW); fs.mkdirSync(OUT, { recursive: true });
  const a = await assets();
  pptx = new PptxGenJS(); pptx.layout = "LAYOUT_WIDE"; pptx.defineLayout({ name: "LAYOUT_WIDE", width: W, height: H });
  pptx.author = "SatGPT Pro"; pptx.company = "Nanjing Normal University"; pptx.subject = "HITL geospatial agent design"; pptx.theme = { headFontFace: FONT_H, bodyFontFace: FONT_B };
  [s1, s2, s3, s4, s5, s6, s7, s8, s9, s10, s11].forEach(fn => fn(a));
  await pptx.writeFile({ fileName: PPTX });
  await renderPreviews(a);
  await qa();
}

function svgPreview(i, title, sub, mode) {
  const dark = mode === "dark";
  const ink = dark ? "#E5E7EB" : "#102033";
  const muted = dark ? "#AAB7C5" : "#667085";
  const box = (x, y, w, h, label, c = "#0B7A53") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="16" fill="${dark ? "#111C2E" : "#FFFFFF"}" stroke="${c}" stroke-width="3"/><text x="${x + w / 2}" y="${y + h / 2 + 9}" text-anchor="middle" fill="${ink}" font-family="Aptos,Arial" font-size="24" font-weight="600">${label}</text>`;
  const arrow = (x1, y1, x2, y2, c = "#102033") => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="5" marker-end="url(#arr)"/>`;
  const miniMap = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#D9F0D2" stroke="#18A0FB" stroke-width="4"/><path d="M${x + 20} ${y + h * .72} C${x + w * .2} ${y + h * .45} ${x + w * .38} ${y + h * .72} ${x + w * .58} ${y + h * .42} S${x + w * .78} ${y + h * .22} ${x + w - 10} ${y + h * .38}" fill="none" stroke="#18A0FB" stroke-width="22" opacity=".6"/><path d="M${x + w * .38} ${y + h * .48} C${x + w * .52} ${y + h * .38} ${x + w * .65} ${y + h * .52} ${x + w * .78} ${y + h * .58} C${x + w * .6} ${y + h * .76} ${x + w * .43} ${y + h * .68} ${x + w * .32} ${y + h * .6}Z" fill="#EF4444" opacity=".58"/>`;
  let extra = "";
  if (i === 1) extra = `<rect x="0" y="0" width="720" height="1080" fill="#F7F8F3"/><line x1="720" y1="0" x2="720" y2="1080" stroke="#0B7A53" stroke-width="6"/><text x="110" y="620" fill="#0B7A53" font-family="Cascadia Mono" font-size="28">controllable / reviewable / executable</text>${miniMap(980, 250, 620, 360)}`;
  else if (i === 2) extra = `${box(210,500,260,90,"AI proposes","#18A0FB")}${box(770,320,300,90,"Human reviews","#EF4444")}${box(1320,500,320,90,"System executes","#0B7A53")}${box(750,760,360,90,"Results feed back","#F59E0B")}${arrow(470,545,770,365,"#18A0FB")}${arrow(1070,365,1320,545,"#EF4444")}${arrow(1480,590,1110,760,"#0B7A53")}${arrow(750,805,360,590,"#F59E0B")}<text x="915" y="555" text-anchor="middle" fill="#102033" font-family="Aptos Display" font-size="48">decision boundary</text>`;
  else if (i === 3) extra = `<text x="120" y="430" fill="#102033" font-family="Aptos Display" font-size="62" font-weight="700">A single request can contain five hidden decisions.</text>${["event","dates","spatial scope","datasets","workflow"].map((l,k)=>`<line x1="1030" y1="${350+k*95}" x2="1260" y2="${350+k*95}" stroke="${["#EF4444","#F59E0B","#18A0FB","#0B7A53","#102033"][k]}" stroke-width="8"/><text x="1300" y="${365+k*95}" fill="${["#EF4444","#F59E0B","#18A0FB","#0B7A53","#102033"][k]}" font-family="Aptos Display" font-size="38" font-weight="700">${l}</text>`).join("")}`;
  else if (i === 4) { const labs=["Request","LLM assumptions","Review checkpoint","GEE execution","Map evidence"]; extra=labs.map((l,k)=>box(150+k*340,520,k===2?300:250,90,l,k===2?"#EF4444":"#102033")).join("") + labs.slice(0,4).map((_,k)=>arrow(400+k*340,565,490+k*340,565,k===1?"#EF4444":"#102033")).join(""); }
  else if (i === 5) { const labs=["intent","chat","extraction","pre-confirm","confirmation","processing"]; extra=labs.map((l,k)=>box(110+k*285,520,220,76,l,k===4?"#EF4444":"#0B7A53")).join("") + `<text x="155" y="760" fill="#102033" font-family="Aptos Display" font-size="44">State is the design tool.</text>`; }
  else if (i === 6) extra = `<rect x="150" y="310" width="610" height="500" rx="20" fill="#FFFFFF" stroke="#C7D2C6" stroke-width="3"/><text x="200" y="380" fill="#102033" font-family="Aptos Display" font-size="42" font-weight="700">Review surface</text>${["Event name","Description","Location","Dates","Resolved AOI","Recommended layers"].map((l,k)=>`<line x1="210" y1="${455+k*55}" x2="260" y2="${455+k*55}" stroke="${k>=4?"#EF4444":"#18A0FB"}" stroke-width="5"/><text x="295" y="${465+k*55}" fill="#102033" font-family="Aptos" font-size="25">${l}</text>`).join("")}<text x="930" y="520" fill="#EF4444" font-family="Aptos Display" font-size="58" font-weight="700">Experts review variables,\nnot prose.</text>`;
  else if (i === 7) extra = `${miniMap(130,330,480,270)}<text x="130" y="690" fill="#18A0FB" font-family="Aptos Display" font-size="42" font-weight="700">spatial scope</text><line x1="780" y1="465" x2="1120" y2="465" stroke="#F59E0B" stroke-width="8"/><circle cx="780" cy="465" r="18" fill="#F59E0B"/><circle cx="950" cy="465" r="24" fill="#EF4444"/><circle cx="1120" cy="465" r="18" fill="#F59E0B"/><text x="760" y="690" fill="#F59E0B" font-family="Aptos Display" font-size="42" font-weight="700">temporal window</text>${["DSWX","Global Flood DB","JRC Water","HydroSHEDS"].map((l,k)=>box(1360,340+k*70,310,48,l,"#0B7A53")).join("")}`;
  else if (i === 8) extra = `${["asset_id","selection_profile","render_profile","legend_spec","execution_profile"].map((l,k)=>`<line x1="180" y1="${345+k*100}" x2="1560" y2="${345+k*100}" stroke="#C7D2C6" stroke-width="2"/><text x="220" y="${320+k*100}" fill="${k===4?"#EF4444":"#0B7A53"}" font-family="Cascadia Mono" font-size="34" font-weight="700">${l}</text><text x="760" y="${320+k*100}" fill="#102033" font-family="Aptos" font-size="30">execution contract field</text>`).join("")}`;
  else if (i === 9) extra = `${miniMap(130,270,780,430)}${["confirmed parameters","GEE processing","tile URLs","map evidence","report / GEE code"].map((l,k)=>box(1110,270+k*88,300,58,l,k<2?"#18A0FB":"#EF4444")).join("")}<text x="150" y="820" fill="#fff" font-family="Aptos Display" font-size="48" font-weight="700">Map evidence is the artifact experts can inspect.</text>`;
  else if (i === 10) extra = `${["Ask","Extract","Confirm","Render","Export"].map((l,k)=>`<text x="${150+k*320}" y="430" fill="${k===2?"#EF4444":"#0B7A53"}" font-family="Cascadia Mono" font-size="24">0${k+1}</text><text x="${150+k*320}" y="500" fill="#102033" font-family="Aptos Display" font-size="44" font-weight="700">${l}</text><line x1="${150+k*320}" y1="560" x2="${360+k*320}" y2="560" stroke="${k===2?"#EF4444":"#0B7A53"}" stroke-width="5"/>`).join("")}<text x="150" y="780" fill="#102033" font-family="Aptos Display" font-size="42">Show the control chain, not a feature tour.</text>`;
  else extra = `${box(150,360,1250,180,"AI should not replace geospatial experts.","#0B7A53")}<text x="170" y="640" fill="#0B7A53" font-family="Aptos Display" font-size="52" font-weight="700">Make flood analysis explicit, controllable, reproducible.</text>`;
  return `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><defs><marker id="arr" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#102033"/></marker></defs><rect width="1920" height="1080" fill="${dark ? "#0B1220" : "#F7F8F3"}"/><rect x="84" y="78" width="1680" height="2" fill="${dark ? "#294156" : "#C7D2C6"}"/><text x="110" y="170" fill="${ink}" font-family="Aptos Display,Arial" font-size="46">${title}</text><text x="114" y="225" fill="${muted}" font-family="Cascadia Mono,monospace" font-size="20">${sub}</text>${extra}<text x="1620" y="960" text-anchor="end" fill="${muted}" font-family="Cascadia Mono" font-size="22">NNU / SatGPT Pro</text></svg>`;
}
async function renderPreviews() {
  const titles = [
    ["Human-in-the-Loop Geospatial Agent Design", "for SatGPT Pro Flood Analysis", "dark"],
    ["Human-in-the-Loop Is a Control Loop", "AI proposes -> Human reviews -> System executes -> Results feed back", "light"],
    ["Flood Mapping Is Not Just Text Generation", "hidden assumptions behind flood mapping", "light"],
    ["How Can SatGPT Pro Implement HITL?", "language -> review checkpoint -> execution -> evidence", "light"],
    ["From Conversation to Stateful Workflow", "LangGraph as typed workflow", "light"],
    ["The Review Checkpoint Exposes AI Assumptions", "editable parameters, not prose", "light"],
    ["Reviewing Where and What to Compute", "spatial scope / temporal window / dataset selection", "light"],
    ["Dataset Registry Constrains LLM Output", "executable assets, not vague recommendations", "light"],
    ["Controlled Execution Produces Map Evidence", "GEE tile URLs and map visualization", "dark"],
    ["Demo: One HITL-Controlled Flood Analysis Flow", "ask -> extract -> confirm -> render -> export", "light"],
    ["Toward Controllable AI-Assisted Geospatial Workflows", "explicit / controllable / reproducible", "light"],
  ];
  const pngs = [];
  for (let i = 0; i < titles.length; i++) {
    const p = path.join(PREVIEW, `slide_${String(i + 1).padStart(2, "0")}.png`);
    await sharp(Buffer.from(svgPreview(i + 1, titles[i][0], titles[i][1], titles[i][2]))).png().toFile(p);
    pngs.push(p);
  }
  const thumbs = await Promise.all(pngs.map(p => sharp(p).resize(480, 270).toBuffer()));
  await sharp({ create: { width: 4 * 480 + 5 * 22, height: 3 * 270 + 4 * 22, channels: 4, background: "#EEF3EA" } })
    .composite(thumbs.map((input, i) => ({ input, left: 22 + (i % 4) * 502, top: 22 + Math.floor(i / 4) * 292 })))
    .png().toFile(path.join(PREVIEW, "contact_sheet.png"));
}
async function qa() {
  const zip = await JSZip.loadAsync(fs.readFileSync(PPTX));
  const names = Object.keys(zip.files);
  const issues = [];
  for (const o of objects) if (o.x < -0.01 || o.y < -0.01 || o.x + o.w > W + 0.01 || o.y + o.h > H + 0.01) issues.push(o);
  const report = {
    toolchain: "Presentations skill design workflow + PptxGenJS editable PPTX + Sharp preview + JSZip OpenXML QA",
    presentations_runtime_attempt: "create_presentation_workspace failed to resolve @oai/artifact-tool in this local workspace; used Presentations design/QA workflow with PptxGenJS exporter",
    pptxPath: PPTX,
    previewPath: PREVIEW,
    contactSheetPath: path.join(PREVIEW, "contact_sheet.png"),
    slideCount: names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length,
    notesCount: names.filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).length,
    boundsIssues: issues,
    verdict: issues.length ? "REVIEW" : "PASS"
  };
  fs.writeFileSync(QA, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
}
build().catch(e => { console.error(e); process.exit(1); });
