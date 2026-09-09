const fs = require("fs");
const path = require("path");
const PptxGenJS = require("pptxgenjs");
const sharp = require("sharp");

const ROOT = "E:\\GMS\\Flood\\SatGPT-app";
const OUT_DIR = path.join(ROOT, "outputs");
const PREVIEW_DIR = path.join(OUT_DIR, "SatGPT_HITL_Geospatial_Agent_Talk_preview");
const ASSET_DIR = path.join(OUT_DIR, "satgpt_hitl_assets");
const PPTX_PATH = path.join(OUT_DIR, "SatGPT_HITL_Geospatial_Agent_Talk.pptx");
const COVER_SOURCE = "C:\\Users\\Administrator\\.codex\\generated_images\\019e1c86-c4b4-7cc1-9a04-cbab8fdda65a\\ig_0612cdfe97bebd15016a0335f9d5e48191a8399da693152567.png";
const COVER_PATH = path.join(ASSET_DIR, "flood_remote_sensing_cover.png");

const W = 13.333;
const H = 7.5;
const PXW = 1920;
const PXH = 1080;

const C = {
  navy: "0B1220",
  navy2: "111827",
  cyan: "18A0FB",
  red: "EF4444",
  gray: "E5E7EB",
  text: "F8FAFC",
  muted: "94A3B8",
  green: "22C55E",
  yellow: "FBBF24",
  white: "FFFFFF",
  black: "020617",
};

const titleFont = "Aptos Display";
const bodyFont = "Aptos";
const monoFont = "Cascadia Mono";

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.mkdirSync(PREVIEW_DIR, { recursive: true });
fs.mkdirSync(ASSET_DIR, { recursive: true });
if (fs.existsSync(COVER_SOURCE)) fs.copyFileSync(COVER_SOURCE, COVER_PATH);

function pptx() {
  const deck = new PptxGenJS();
  deck.layout = "LAYOUT_WIDE";
  deck.author = "SatGPT Pro";
  deck.subject = "Human-in-the-Loop Geospatial Agent Design for SatGPT Pro Flood Analysis";
  deck.title = "Human-in-the-Loop Geospatial Agent Design for SatGPT Pro Flood Analysis";
  deck.company = "Nanjing Normal University";
  deck.lang = "en-US";
  deck.theme = {
    headFontFace: titleFont,
    bodyFontFace: bodyFont,
    lang: "en-US",
  };
  deck.defineLayout({ name: "LAYOUT_WIDE", width: W, height: H });
  return deck;
}

function addBg(s, fill = C.navy) {
  s.background = { color: fill };
  s.addShape(deck.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: fill }, line: { color: fill, transparency: 100 } });
}

function addHeader(s, no, title, subtitle) {
  s.addText(String(no).padStart(2, "0"), { x: 0.55, y: 0.38, w: 0.5, h: 0.25, fontFace: monoFont, fontSize: 8.5, color: C.cyan, bold: true, margin: 0 });
  s.addShape(deck.ShapeType.line, { x: 1.15, y: 0.51, w: 1.1, h: 0, line: { color: C.cyan, width: 1.2, transparency: 10 } });
  s.addText(title, { x: 0.62, y: 0.75, w: 7.8, h: 0.52, fontFace: titleFont, fontSize: 29, bold: false, color: C.text, breakLine: false, fit: "shrink", margin: 0 });
  if (subtitle) s.addText(subtitle, { x: 0.64, y: 1.28, w: 8.3, h: 0.28, fontFace: bodyFont, fontSize: 10.5, color: C.muted, margin: 0, fit: "shrink" });
  s.addText("SatGPT Pro / HITL Geospatial Agent", { x: 9.25, y: 0.42, w: 3.3, h: 0.24, fontFace: monoFont, fontSize: 7.8, color: C.muted, align: "right", margin: 0 });
}

function addFooter(s) {
  s.addShape(deck.ShapeType.line, { x: 0.62, y: 7.05, w: 12.1, h: 0, line: { color: "1F2937", width: 0.8 } });
}

function note(s, t) {
  s.addNotes(t.split("\n").map(x => x.trim()).filter(Boolean));
}

function txt(s, t, x, y, w, h, opt = {}) {
  s.addText(t, {
    x, y, w, h,
    fontFace: opt.fontFace || bodyFont,
    fontSize: opt.fontSize || 18,
    color: opt.color || C.text,
    bold: opt.bold || false,
    fit: opt.fit || "shrink",
    margin: opt.margin ?? 0.02,
    breakLine: opt.breakLine || false,
    valign: opt.valign || "mid",
    align: opt.align || "left",
    paraSpaceAfterPt: 0,
  });
}

function pill(s, t, x, y, w, color = C.cyan) {
  s.addShape(deck.ShapeType.roundRect, { x, y, w, h: 0.36, rectRadius: 0.07, fill: { color, transparency: 82 }, line: { color, transparency: 10, width: 1 } });
  txt(s, t, x + 0.08, y + 0.08, w - 0.16, 0.13, { fontSize: 8.5, color: C.text, fontFace: monoFont, align: "center" });
}

function line(s, x1, y1, x2, y2, color = C.cyan, width = 1.8) {
  s.addShape(deck.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color, width, beginArrowType: "none", endArrowType: "triangle" } });
}

function node(s, label, x, y, w, h, color = C.navy2, accent = C.cyan, fs = 13) {
  s.addShape(deck.ShapeType.roundRect, { x, y, w, h, rectRadius: 0.08, fill: { color, transparency: 4 }, line: { color: accent, width: 1.1, transparency: 8 } });
  txt(s, label, x + 0.12, y + 0.08, w - 0.24, h - 0.16, { fontSize: fs, bold: true, align: "center", fit: "shrink" });
}

function smallLabel(s, label, x, y, w, color = C.muted) {
  txt(s, label, x, y, w, 0.18, { fontSize: 8.4, color, fontFace: monoFont, fit: "shrink" });
}

function drawLoop(s) {
  const pts = [
    ["AI proposes", 1.25, 2.25, C.cyan],
    ["Human reviews", 4.15, 1.65, C.yellow],
    ["System executes", 7.05, 2.25, C.green],
    ["Results feed back", 4.15, 4.55, C.red],
  ];
  pts.forEach(([l, x, y, c]) => node(s, l, x, y, 2.05, 0.72, C.navy2, c, 12.5));
  line(s, 3.30, 2.54, 4.10, 2.12, C.cyan, 1.7);
  line(s, 6.20, 2.12, 7.00, 2.54, C.yellow, 1.7);
  line(s, 8.10, 3.02, 6.00, 4.48, C.green, 1.7);
  line(s, 4.25, 4.85, 2.25, 3.06, C.red, 1.7);
  s.addShape(deck.ShapeType.arc, { x: 2.45, y: 1.35, w: 5.65, h: 4.6, adjustPoint: 0.25, line: { color: "334155", width: 1.2, transparency: 8 } });
}

function addCodeRef(s, refs) {
  txt(s, refs, 8.7, 6.52, 3.9, 0.22, { fontSize: 7.5, color: C.muted, fontFace: monoFont, align: "right" });
}

const deck = pptx();

// Slide 1
{
  const s = deck.addSlide();
  if (fs.existsSync(COVER_PATH)) s.addImage({ path: COVER_PATH, x: 0, y: 0, w: W, h: H });
  else addBg(s);
  s.addShape(deck.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: C.navy, transparency: 18 }, line: { color: C.navy, transparency: 100 } });
  s.addShape(deck.ShapeType.rect, { x: 0, y: 0, w: 7.4, h: H, fill: { color: C.navy, transparency: 8 }, line: { color: C.navy, transparency: 100 } });
  txt(s, "Human-in-the-Loop\nGeospatial Agent Design\nfor SatGPT Pro Flood Analysis", 0.78, 1.15, 7.15, 2.5, { fontFace: titleFont, fontSize: 32, bold: false, color: C.white, fit: "shrink" });
  txt(s, "Making AI-assisted flood mapping controllable, reviewable, and executable", 0.82, 4.05, 6.2, 0.42, { fontSize: 15.5, color: C.gray, fit: "shrink" });
  s.addShape(deck.ShapeType.line, { x: 0.82, y: 3.82, w: 2.7, h: 0, line: { color: C.cyan, width: 3 } });
  pill(s, "10-minute technical talk", 0.82, 5.78, 2.0, C.cyan);
  pill(s, "Flood analysis workflow", 3.0, 5.78, 2.15, C.red);
  txt(s, "Nanjing Normal University", 0.82, 6.64, 2.9, 0.22, { fontSize: 9.5, color: C.gray, fontFace: monoFont });
  note(s, "今天不重复介绍 SatGPT 平台，而是聚焦一个技术问题：在洪水遥感分析中，如何让 AI Agent 的输出可控、可检查、可执行。");
}

// Slide 2
{
  const s = deck.addSlide(); addBg(s); addHeader(s, 2, "Human-in-the-Loop Is a Control Loop", "Human judgment is inserted where uncertainty and responsibility concentrate.");
  drawLoop(s);
  txt(s, "HITL places human judgment inside the AI decision loop,\nespecially where uncertainty and responsibility matter.", 0.92, 5.88, 8.7, 0.55, { fontSize: 18, color: C.gray });
  txt(s, "Loop = feedback, not supervision theater.", 9.6, 2.18, 2.55, 1.2, { fontFace: titleFont, fontSize: 23, color: C.white, bold: false, align: "left" });
  txt(s, "The human is not a passive observer; the review changes what the system is allowed to execute.", 9.62, 3.65, 2.55, 0.75, { fontSize: 12.5, color: C.muted });
  addFooter(s);
  note(s, "HITL 的 loop 来自反馈回路，不是简单“人在旁边看一下”。AI 提出假设，人类审查关键点，系统再执行动作，结果还能反向影响下一次流程。");
}

// Slide 3
{
  const s = deck.addSlide(); addBg(s); addHeader(s, 3, "Flood Mapping Is Not Just Text Generation", "A single natural-language request hides several execution-critical assumptions.");
  node(s, "Flood mapping\nrequest", 5.35, 3.1, 2.3, 0.88, C.navy2, C.red, 15);
  const items = [
    ["event", 2.0, 1.7, C.red],
    ["dates", 5.55, 1.35, C.yellow],
    ["spatial scope", 9.0, 1.7, C.cyan],
    ["datasets", 2.5, 5.15, C.green],
    ["workflow", 8.65, 5.15, C.muted],
  ];
  items.forEach(([l,x,y,c]) => { node(s, l, x, y, 1.75, 0.58, C.navy2, c, 13); line(s, x + 0.87, y + 0.58, 6.5, 3.1, c, 1.2); });
  txt(s, "A flood analysis request hides multiple assumptions:\nevent, dates, spatial scope, datasets, and execution workflow.", 1.05, 6.35, 9.9, 0.48, { fontSize: 15.5, color: C.gray });
  addFooter(s);
  note(s, "普通聊天错了只是文本不准；洪水制图里，时间窗口、AOI、数据源错一个，地图证据就可能误导。灾害遥感属于高风险 AI 辅助决策场景，不适合完全黑箱自动化。");
}

// Slide 4
{
  const s = deck.addSlide(); addBg(s); addHeader(s, 4, "How Can SatGPT Pro Implement HITL?", "The control layer sits between language assumptions and Earth Engine execution.");
  const steps = ["Natural-language request", "LLM assumptions", "Human review checkpoint", "Earth Engine execution", "Map evidence"];
  const xs = [0.9, 3.25, 5.55, 8.05, 10.45];
  steps.forEach((st, i) => node(s, st, xs[i], 3.05, 1.72, 0.75, C.navy2, i === 2 ? C.red : C.cyan, 10.5));
  for (let i = 0; i < xs.length - 1; i++) line(s, xs[i] + 1.72, 3.42, xs[i + 1], 3.42, i === 1 ? C.red : C.cyan, 1.7);
  txt(s, "The checkpoint converts uncertain natural language into confirmed spatial analysis parameters.", 1.02, 5.36, 8.25, 0.38, { fontSize: 18, color: C.gray });
  txt(s, "Design question", 1.02, 2.1, 2.7, 0.26, { fontSize: 11, color: C.cyan, fontFace: monoFont });
  txt(s, "Where should the agent stop before it spends computation and generates map evidence?", 1.02, 2.42, 7.4, 0.36, { fontSize: 17, color: C.white });
  addFooter(s);
  note(s, "这里的核心问题不是“怎么做一个确认弹窗”，而是如何在 LLM 和 GEE 执行之间插入一个控制层，把不确定的自然语言输出变成确认后的空间分析参数。");
}

// Slide 5
{
  const s = deck.addSlide(); addBg(s); addHeader(s, 5, "From Conversation to Stateful Workflow", "LangGraph turns a chat into a sequence of typed responsibilities.");
  const steps = ["intent_node", "chat_node", "extraction_node", "pre_confirmation_node", "confirmation_node", "processing_node"];
  const y = 3.15; const start = 0.72; const ww = 1.72; const gap = 0.34;
  steps.forEach((st, i) => {
    node(s, st, start + i * (ww + gap), y, ww, 0.62, C.navy2, i === 4 ? C.red : C.cyan, 9.8);
    if (i < steps.length - 1) line(s, start + i * (ww + gap) + ww, y + 0.31, start + (i + 1) * (ww + gap), y + 0.31, C.cyan, 1.3);
  });
  txt(s, "Each node narrows the problem: intent → context → structured extraction → review → execution.", 0.82, 5.2, 9.7, 0.36, { fontSize: 17, color: C.gray });
  smallLabel(s, "stateful workflow, not one-shot completion", 0.82, 2.42, 4.6, C.cyan);
  addCodeRef(s, "agent/flood_agent.py");
  addFooter(s);
  note(s, "LangGraph 把一次聊天拆成任务流水线。每个节点职责明确：判断意图、对话/搜索、抽取结构化参数、准备确认、等待用户、执行报告和 GEE code 生成。");
}

// Slide 6
{
  const s = deck.addSlide(); addBg(s); addHeader(s, 6, "The Review Checkpoint Exposes AI Assumptions", "The key move is explicitization: hidden guesses become editable parameters.");
  txt(s, "Hidden assumptions", 1.0, 2.0, 3.0, 0.28, { fontSize: 16, color: C.muted, fontFace: monoFont });
  txt(s, "Reviewable parameters", 7.1, 2.0, 3.2, 0.28, { fontSize: 16, color: C.cyan, fontFace: monoFont });
  node(s, "Free-form answer\nwith implicit choices", 1.05, 3.05, 2.55, 1.05, C.navy2, C.muted, 15);
  line(s, 3.8, 3.56, 6.35, 3.56, C.red, 2.4);
  const params = ["Event name", "Event description", "Location", "Pre / peak / post dates", "Resolved AOI", "Recommended layers"];
  params.forEach((p, i) => {
    const x = 6.65 + (i % 2) * 2.55;
    const y = 2.58 + Math.floor(i / 2) * 0.84;
    node(s, p, x, y, 2.08, 0.48, C.navy2, i >= 4 ? C.red : C.cyan, 9.6);
  });
  txt(s, "The expert reviews variables, not prose.", 1.05, 5.6, 6.2, 0.34, { fontSize: 20, color: C.white });
  addCodeRef(s, "confirmation_node · EventConfirmation.js");
  addFooter(s);
  note(s, "这一页讲“显式化”。AI 原本藏在回答里的判断，被拆成一组可检查参数。专家看到的不是一段自然语言，而是事件、时间、空间、图层这些可修正变量。");
}

// Slide 7
{
  const s = deck.addSlide(); addBg(s); addHeader(s, 7, "Reviewing Where and What to Compute", "AOI is only one part of the review surface.");
  const cols = [
    ["spatial scope", "AOI / resolved boundary", C.cyan],
    ["temporal window", "pre / peak / post dates", C.yellow],
    ["dataset selection", "layers and execution profiles", C.green],
  ];
  cols.forEach(([h,b,c], i) => {
    const x = 1.05 + i * 3.95;
    s.addShape(deck.ShapeType.line, { x, y: 2.45, w: 2.75, h: 0, line: { color: c, width: 4 } });
    txt(s, h, x, 2.76, 2.85, 0.35, { fontFace: titleFont, fontSize: 20, color: C.white, bold: false });
    txt(s, b, x, 3.28, 2.85, 0.36, { fontSize: 13, color: C.gray });
    if (i === 0) {
      s.addShape(deck.ShapeType.rect, { x: x + 0.18, y: 4.28, w: 2.35, h: 1.05, fill: { color: C.cyan, transparency: 88 }, line: { color: c, width: 1.1 } });
      s.addShape(deck.ShapeType.rect, { x: x + 0.44, y: 4.48, w: 1.7, h: 0.24, fill: { color: c, transparency: 72 }, line: { color: c, width: 1 } });
      s.addShape(deck.ShapeType.rect, { x: x + 0.75, y: 4.82, w: 1.05, h: 0.22, fill: { color: c, transparency: 78 }, line: { color: c, width: 1 } });
    } else if (i === 1) {
      s.addShape(deck.ShapeType.line, { x: x + 0.2, y: 4.82, w: 2.38, h: 0, line: { color: c, width: 2 } });
      [0.2, 1.19, 2.58].forEach(dx => s.addShape(deck.ShapeType.ellipse, { x: x + dx, y: 4.68, w: 0.18, h: 0.18, fill: { color: c }, line: { color: c } }));
    } else {
      [0, 0.22, 0.44].forEach((dy, j) => s.addShape(deck.ShapeType.rect, { x: x + 0.3 + j * 0.22, y: 4.3 + dy, w: 2.1, h: 0.7, fill: { color: c, transparency: 88 - j * 8 }, line: { color: c, width: 1 } }));
    }
  });
  txt(s, "HITL controls not just where, but what to compute.", 1.05, 6.1, 7.5, 0.45, { fontSize: 22, color: C.white });
  addFooter(s);
  note(s, "AOI 本身不是贡献点，搜索/上传/手绘只是入口。真正重要的是：空间范围和数据层选择都必须进入确认流程。HITL 控制的不只是 where，也包括 what to compute。");
}

// Slide 8
{
  const s = deck.addSlide(); addBg(s); addHeader(s, 8, "Dataset Registry Constrains LLM Output to Executable Assets", "The registry is the execution contract between language and GEE.");
  node(s, "registry", 0.95, 3.0, 1.55, 0.64, C.navy2, C.cyan, 13);
  node(s, "recommended\nlayers", 3.2, 2.9, 1.8, 0.86, C.navy2, C.green, 12);
  node(s, "render_layer()", 5.85, 3.0, 1.8, 0.64, C.navy2, C.yellow, 12);
  node(s, "GEE tile URL", 8.45, 3.0, 1.75, 0.64, C.navy2, C.red, 12);
  line(s, 2.52, 3.32, 3.15, 3.32, C.cyan, 1.5); line(s, 5.03, 3.32, 5.8, 3.32, C.green, 1.5); line(s, 7.68, 3.32, 8.4, 3.32, C.yellow, 1.5);
  const fields = ["asset_id", "selection_profile", "render_profile", "legend_spec", "execution_profile"];
  fields.forEach((f, i) => pill(s, f, 0.98 + i * 2.25, 4.75, 1.85, i === 4 ? C.red : C.cyan));
  txt(s, "This prevents the model from merely saying “use Sentinel-1”; it must map to assets the system can execute.", 0.98, 5.75, 9.2, 0.42, { fontSize: 16, color: C.gray });
  addCodeRef(s, "flood_dataset_service.py · flood_dataset_registry.json");
  addFooter(s);
  note(s, "普通 LLM 会说“可以用 Sentinel-1”。这里更进一步：系统用 registry 把数据集变成可执行资产，包含 asset id、渲染规则、图例、执行条件，避免 LLM 凭空编数据。");
}

// Slide 9
{
  const s = deck.addSlide(); addBg(s); addHeader(s, 9, "Controlled Execution Produces Map Evidence", "The final artifact is inspectable spatial output, not only fluent text.");
  const steps = ["confirmed event", "AOI", "selected layers", "GEE processing", "tile URLs", "map visualization", "report / GEE code"];
  const xs = [0.8, 2.45, 3.65, 5.55, 7.35, 9.0, 10.9];
  steps.forEach((st, i) => node(s, st, xs[i], 3.05, i === 2 || i === 6 ? 1.55 : 1.2, 0.58, C.navy2, i >= 3 ? C.red : C.cyan, 9.1));
  for (let i = 0; i < steps.length - 1; i++) line(s, xs[i] + (i === 2 || i === 6 ? 1.55 : 1.2), 3.34, xs[i + 1], 3.34, i >= 2 ? C.red : C.cyan, 1.2);
  s.addShape(deck.ShapeType.rect, { x: 8.45, y: 4.35, w: 3.0, h: 1.4, fill: { color: "0F172A" }, line: { color: C.cyan, width: 1 } });
  s.addShape(deck.ShapeType.rect, { x: 8.62, y: 4.52, w: 1.1, h: 0.42, fill: { color: C.cyan, transparency: 60 }, line: { color: C.cyan, transparency: 100 } });
  s.addShape(deck.ShapeType.rect, { x: 9.48, y: 4.72, w: 1.45, h: 0.52, fill: { color: C.red, transparency: 65 }, line: { color: C.red, transparency: 100 } });
  s.addShape(deck.ShapeType.rect, { x: 8.85, y: 5.12, w: 2.0, h: 0.2, fill: { color: C.green, transparency: 55 }, line: { color: C.green, transparency: 100 } });
  txt(s, "Map evidence", 8.62, 5.48, 1.7, 0.18, { fontSize: 9, color: C.gray, fontFace: monoFont });
  txt(s, "The agent becomes useful when confirmed parameters drive Earth Engine outputs experts can inspect.", 0.92, 5.75, 7.2, 0.42, { fontSize: 17, color: C.gray });
  addCodeRef(s, "gee_service.py · AgentPanel.js");
  addFooter(s);
  note(s, "最终输出不只是报告文本，而是可检查的地图证据。Agent 的价值不是“回答得像专家”，而是把确认后的参数送入 Earth Engine，生成可以被专家复核的空间结果。");
}

// Slide 10
{
  const s = deck.addSlide(); addBg(s); addHeader(s, 10, "Demo: One HITL-Controlled Flood Analysis Flow", "Show one chain, not every feature.");
  const steps = [
    ["01", "Ask for a concrete flood analysis"],
    ["02", "Agent extracts event parameters"],
    ["03", "Human confirms event, AOI, and layers"],
    ["04", "GEE renders map evidence"],
  ];
  steps.forEach(([n, t], i) => {
    const x = 0.88 + i * 3.08;
    s.addShape(deck.ShapeType.rect, { x, y: 2.2, w: 2.65, h: 2.65, fill: { color: "0F172A" }, line: { color: i === 2 ? C.red : C.cyan, width: 1.2 } });
    txt(s, n, x + 0.18, 2.42, 0.45, 0.26, { fontSize: 12, color: i === 2 ? C.red : C.cyan, fontFace: monoFont, bold: true });
    txt(s, t, x + 0.18, 3.96, 2.24, 0.48, { fontSize: 12.5, color: C.white, fit: "shrink" });
    s.addShape(deck.ShapeType.line, { x: x + 0.2, y: 3.18, w: 2.2, h: 0, line: { color: "334155", width: 1 } });
    s.addShape(deck.ShapeType.line, { x: x + 0.2, y: 3.44, w: 1.55, h: 0, line: { color: "334155", width: 1 } });
  });
  txt(s, "5. Export report / GEE code", 1.0, 5.58, 4.2, 0.3, { fontSize: 18, color: C.gray });
  txt(s, "Screenshot placeholders are intentionally editable and can be replaced with real UI captures later.", 1.0, 6.12, 8.2, 0.28, { fontSize: 11, color: C.muted });
  addFooter(s);
  note(s, "Demo 只展示一条链路，不展开所有功能。目标是证明 HITL 如何把 AI 假设变成地图结果。");
}

// Slide 11
{
  const s = deck.addSlide(); addBg(s); addHeader(s, 11, "Toward Controllable AI-Assisted Geospatial Workflows", "The contribution is a controlled path from language to evidence.");
  drawLoop(s);
  txt(s, "The goal is not to replace geospatial experts,\nbut to make AI-assisted flood analysis more explicit,\ncontrollable, and reproducible.", 7.8, 2.05, 4.35, 1.28, { fontFace: titleFont, fontSize: 24, color: C.white, fit: "shrink" });
  ["explicit", "controllable", "reproducible"].forEach((w, i) => pill(s, w, 7.85 + i * 1.48, 4.25, 1.25, i === 1 ? C.red : C.cyan));
  addFooter(s);
  note(s, "SatGPT Pro 的关键不是让 AI 完全自动替代专家，而是让专家工作流更快、更显式、更可复现。HITL 是把 LLM 不确定性接入真实遥感工作流的关键控制机制。");
}

async function renderPreview() {
  const slides = [
    ["Human-in-the-Loop Geospatial Agent Design", "Making AI-assisted flood mapping controllable, reviewable, and executable", "flood remote sensing cover"],
    ["Human-in-the-Loop Is a Control Loop", "AI proposes → Human reviews → System executes → Results feed back", "control loop"],
    ["Flood Mapping Is Not Just Text Generation", "event · dates · spatial scope · datasets · workflow", "assumption graph"],
    ["How Can SatGPT Pro Implement HITL?", "Natural-language request → LLM assumptions → checkpoint → GEE → evidence", "pipeline"],
    ["From Conversation to Stateful Workflow", "intent_node → chat_node → extraction_node → pre_confirmation_node → confirmation_node → processing_node", "LangGraph state machine"],
    ["The Review Checkpoint Exposes AI Assumptions", "Event, location, dates, AOI, and layers become reviewable variables.", "explicit parameters"],
    ["Reviewing Where and What to Compute", "spatial scope · temporal window · dataset selection", "three review surfaces"],
    ["Dataset Registry Constrains LLM Output", "asset_id · selection_profile · render_profile · legend_spec · execution_profile", "registry pipeline"],
    ["Controlled Execution Produces Map Evidence", "confirmed event + AOI + layers → GEE → tiles → map visualization", "execution pipeline"],
    ["Demo: One HITL-Controlled Flood Analysis Flow", "Ask → extract → confirm → render → export", "demo placeholders"],
    ["Toward Controllable AI-Assisted Geospatial Workflows", "explicit · controllable · reproducible", "closing loop"],
  ];
  const svgs = [];
  for (let i = 0; i < slides.length; i++) {
    const [title, sub, tag] = slides[i];
    const svg = `<svg width="${PXW}" height="${PXH}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#${C.navy}"/>
      <path d="M0 820 C 320 760, 500 920, 820 850 S 1320 720, 1920 840 L1920 1080 L0 1080 Z" fill="#0F172A"/>
      <line x1="90" y1="165" x2="410" y2="165" stroke="#${C.cyan}" stroke-width="5"/>
      <text x="90" y="105" fill="#${C.cyan}" font-family="Cascadia Mono, monospace" font-size="24">${String(i+1).padStart(2,"0")}</text>
      <text x="90" y="245" fill="#${C.white}" font-family="Aptos Display, Calibri, sans-serif" font-size="58">${escapeXml(title)}</text>
      <text x="90" y="320" fill="#${C.gray}" font-family="Aptos, Calibri, sans-serif" font-size="30">${escapeXml(sub)}</text>
      <text x="90" y="930" fill="#${C.muted}" font-family="Cascadia Mono, monospace" font-size="22">${escapeXml(tag)}</text>
      <circle cx="1540" cy="520" r="160" fill="none" stroke="#${C.cyan}" stroke-width="5" opacity=".55"/>
      <circle cx="1540" cy="520" r="92" fill="none" stroke="#${C.red}" stroke-width="5" opacity=".75"/>
    </svg>`;
    const out = path.join(PREVIEW_DIR, `slide_${String(i+1).padStart(2,"0")}.png`);
    await sharp(Buffer.from(svg)).png().toFile(out);
    svgs.push(out);
  }
  const thumbs = await Promise.all(svgs.map(p => sharp(p).resize(384, 216).toBuffer()));
  const cols = 4, rows = 3, tw = 384, th = 216, gap = 18;
  const canvas = sharp({
    create: { width: cols * tw + (cols + 1) * gap, height: rows * th + (rows + 1) * gap, channels: 4, background: "#0B1220" }
  });
  const composite = thumbs.map((input, i) => ({ input, left: gap + (i % cols) * (tw + gap), top: gap + Math.floor(i / cols) * (th + gap) }));
  await canvas.composite(composite).png().toFile(path.join(PREVIEW_DIR, "contact_sheet.png"));
}

function escapeXml(s) {
  return String(s).replace(/[<>&"']/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" }[ch]));
}

deck.writeFile({ fileName: PPTX_PATH }).then(async () => {
  await renderPreview();
  console.log(PPTX_PATH);
  console.log(PREVIEW_DIR);
});
