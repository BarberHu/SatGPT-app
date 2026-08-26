const fs = require("fs");
const path = require("path");
const PptxGenJS = require("pptxgenjs");
const sharp = require("sharp");

const ROOT = "E:\\GMS\\Flood\\SatGPT-app";
const OUT = path.join(ROOT, "outputs");
const PREVIEW = path.join(OUT, "SatGPT_HITL_Geospatial_Agent_Talk_preview");
const ASSETS = path.join(OUT, "satgpt_hitl_assets_v2");
const PPTX = path.join(OUT, "SatGPT_HITL_Geospatial_Agent_Talk.pptx");
const COVER_SRC = "C:\\Users\\Administrator\\.codex\\generated_images\\019e1c86-c4b4-7cc1-9a04-cbab8fdda65a\\ig_0612cdfe97bebd15016a0335f9d5e48191a8399da693152567.png";
const CAMPUS_SRC = path.join(OUT, "nsnu_template_assets", "image1.jpeg");
const NNU_LOGO_SRC = path.join(OUT, "nsnu_template_assets", "image2.png");
const GLOBE_ICON = path.join(OUT, "nsnu_template_assets", "image17.png");
const CHART_ICON = path.join(OUT, "nsnu_template_assets", "image21.png");
const DOC_ICON = path.join(OUT, "nsnu_template_assets", "image6.png");

fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(PREVIEW, { recursive: true });
fs.mkdirSync(ASSETS, { recursive: true });

const C = {
  navy: "07111F",
  navy2: "0B1220",
  ink: "0F172A",
  panel: "111C2E",
  cyan: "18A0FB",
  cyan2: "67E8F9",
  red: "EF4444",
  green: "007A4D",
  green2: "00A86B",
  cream: "EEF6E8",
  gray: "CBD5E1",
  muted: "7E8A9A",
  white: "FFFFFF",
  yellow: "FBBF24",
};

const W = 13.333;
const H = 7.5;
const titleFont = "Aptos Display";
const bodyFont = "Aptos";
const monoFont = "Cascadia Mono";

async function prepareAssets() {
  const cover = path.join(ASSETS, "cover_satellite.png");
  const mapDark = path.join(ASSETS, "map_dark.png");
  const mapSoft = path.join(ASSETS, "map_soft.png");
  const campus = path.join(ASSETS, "campus_dark.png");
  const logo = path.join(ASSETS, "nnu_logo.png");
  if (fs.existsSync(COVER_SRC)) fs.copyFileSync(COVER_SRC, cover);
  if (fs.existsSync(NNU_LOGO_SRC)) {
    await sharp(NNU_LOGO_SRC).trim({ background: "#ffffff" }).resize({ width: 900 }).png().toFile(logo);
  }
  if (fs.existsSync(COVER_SRC)) {
    await sharp(COVER_SRC)
      .resize(1920, 1080, { fit: "cover" })
      .modulate({ brightness: 0.34, saturation: 0.82 })
      .composite([{ input: Buffer.from(`<svg width="1920" height="1080"><rect width="1920" height="1080" fill="#07111F" opacity="0.46"/><rect x="0" y="0" width="680" height="1080" fill="#07111F" opacity="0.76"/></svg>`), left: 0, top: 0 }])
      .png().toFile(mapDark);
    await sharp(COVER_SRC)
      .resize(1920, 1080, { fit: "cover" })
      .modulate({ brightness: 0.45, saturation: 0.65 })
      .composite([{ input: Buffer.from(`<svg width="1920" height="1080"><rect width="1920" height="1080" fill="#07111F" opacity="0.70"/></svg>`), left: 0, top: 0 }])
      .png().toFile(mapSoft);
  }
  if (fs.existsSync(CAMPUS_SRC)) {
    await sharp(CAMPUS_SRC)
      .resize(1920, 1080, { fit: "cover" })
      .modulate({ brightness: 0.42, saturation: 0.75 })
      .composite([{ input: Buffer.from(`<svg width="1920" height="1080"><rect width="1920" height="1080" fill="#07111F" opacity="0.55"/></svg>`), left: 0, top: 0 }])
      .png().toFile(campus);
  }
  return { cover, mapDark, mapSoft, campus, logo };
}

function createDeck() {
  const pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.author = "SatGPT Pro";
  pptx.company = "Nanjing Normal University";
  pptx.subject = "Human-in-the-Loop Geospatial Agent Design for SatGPT Pro Flood Analysis";
  pptx.title = "Human-in-the-Loop Geospatial Agent Design";
  pptx.lang = "en-US";
  pptx.theme = { headFontFace: titleFont, bodyFontFace: bodyFont, lang: "en-US" };
  pptx.defineLayout({ name: "LAYOUT_WIDE", width: W, height: H });
  return pptx;
}

let pptx;

function bg(s, img, variant = "default") {
  s.background = { color: C.navy };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: C.navy }, line: { transparency: 100 } });
  if (img && fs.existsSync(img)) s.addImage({ path: img, x: 0, y: 0, w: W, h: H });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: variant === "clean" ? C.navy : C.navy, transparency: variant === "clean" ? 7 : 22 }, line: { transparency: 100 } });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.12, h: H, fill: { color: C.green }, line: { transparency: 100 } });
  s.addShape(pptx.ShapeType.rect, { x: 0.12, y: 0, w: 0.025, h: H, fill: { color: C.cyan }, line: { transparency: 100 } });
}

function text(s, val, x, y, w, h, opt = {}) {
  s.addText(val, {
    x, y, w, h,
    margin: opt.margin ?? 0,
    fontFace: opt.fontFace || bodyFont,
    fontSize: opt.size || 16,
    color: opt.color || C.white,
    bold: opt.bold || false,
    italic: opt.italic || false,
    fit: opt.fit || "shrink",
    breakLine: false,
    align: opt.align || "left",
    valign: opt.valign || "mid",
    paraSpaceAfterPt: 0,
    breakLine: false,
  });
}

function title(s, n, t, sub) {
  text(s, String(n).padStart(2, "0"), 0.55, 0.42, 0.5, 0.18, { size: 8.5, color: C.cyan2, fontFace: monoFont, bold: true });
  s.addShape(pptx.ShapeType.line, { x: 1.08, y: 0.51, w: 1.22, h: 0, line: { color: C.green2, width: 2.2 } });
  text(s, t, 0.62, 0.82, 8.9, 0.5, { size: 27, color: C.cream, fontFace: titleFont, fit: "shrink" });
  if (sub) text(s, sub, 0.64, 1.36, 8.15, 0.22, { size: 10.2, color: C.gray, fontFace: monoFont });
  text(s, "NNU · SatGPT Pro", 10.45, 0.42, 2.25, 0.18, { size: 8.5, color: C.cream, fontFace: monoFont, align: "right" });
}

function notes(s, val) {
  s.addNotes(val.split("\n").map(x => x.trim()).filter(Boolean));
}

function node(s, val, x, y, w, h, opt = {}) {
  const accent = opt.accent || C.cyan;
  s.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h,
    rectRadius: 0.05,
    fill: { color: opt.fill || C.panel, transparency: opt.transparency ?? 2 },
    line: { color: accent, width: opt.lineWidth || 1.1, transparency: opt.lineTrans ?? 0 },
    shadow: opt.shadow ? { type: "outer", color: "000000", opacity: 0.18, blur: 2, angle: 45, distance: 1 } : undefined,
  });
  text(s, val, x + 0.12, y + 0.05, w - 0.24, h - 0.1, { size: opt.size || 11.5, color: opt.color || C.cream, fontFace: opt.fontFace || bodyFont, bold: opt.bold ?? true, align: "center", fit: "shrink" });
}

function chip(s, val, x, y, w, accent = C.cyan) {
  s.addShape(pptx.ShapeType.roundRect, { x, y, w, h: 0.3, rectRadius: 0.06, fill: { color: accent, transparency: 84 }, line: { color: accent, width: 0.9, transparency: 15 } });
  text(s, val, x + 0.07, y + 0.075, w - 0.14, 0.12, { size: 7.9, color: C.cream, fontFace: monoFont, align: "center" });
}

function arrow(s, x1, y1, x2, y2, color = C.cyan, width = 1.4) {
  s.addShape(pptx.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color, width, endArrowType: "triangle" } });
}

function rule(s, x, y, w, color = C.green2) {
  s.addShape(pptx.ShapeType.line, { x, y, w, h: 0, line: { color, width: 2.5 } });
}

function brandLogo(s, assets, x = 9.8, y = 6.62, w = 2.45) {
  if (assets.logo && fs.existsSync(assets.logo)) {
    s.addImage({ path: assets.logo, x, y, w, h: 0.38, transparency: 6 });
  } else {
    text(s, "NANJING NORMAL UNIVERSITY", x, y, w, 0.18, { size: 8, color: C.cream, fontFace: monoFont, align: "right" });
  }
}

function addFooter(s, assets) {
  s.addShape(pptx.ShapeType.line, { x: 0.62, y: 7.04, w: 12.1, h: 0, line: { color: "243244", width: 0.8, transparency: 5 } });
  brandLogo(s, assets);
}

function codeRef(s, val) {
  text(s, val, 7.15, 6.23, 5.1, 0.18, { size: 7.3, color: C.muted, fontFace: monoFont, align: "right" });
}

function mapEvidence(s, x, y, w, h) {
  s.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: "07111F" }, line: { color: C.cyan, width: 1.2 } });
  for (let i = 0; i < 8; i++) {
    s.addShape(pptx.ShapeType.line, { x: x + 0.12, y: y + 0.22 + i * h / 9, w: w - 0.24, h: 0, line: { color: "1D4ED8", width: 0.4, transparency: 65 } });
  }
  s.addShape(pptx.ShapeType.arc, { x: x + 0.28, y: y + 0.25, w: w * 0.72, h: h * 0.62, line: { color: C.cyan, width: 2, transparency: 20 } });
  s.addShape(pptx.ShapeType.arc, { x: x + 0.58, y: y + 0.5, w: w * 0.55, h: h * 0.45, line: { color: C.red, width: 2.2, transparency: 15 } });
  s.addShape(pptx.ShapeType.rect, { x: x + w * 0.12, y: y + h * 0.58, w: w * 0.58, h: h * 0.18, fill: { color: C.cyan, transparency: 62 }, line: { transparency: 100 } });
  s.addShape(pptx.ShapeType.rect, { x: x + w * 0.38, y: y + h * 0.34, w: w * 0.44, h: h * 0.16, fill: { color: C.red, transparency: 58 }, line: { transparency: 100 } });
}

async function build() {
  const assets = await prepareAssets();
  pptx = createDeck();

  // 1 Cover
  {
    const s = pptx.addSlide();
    bg(s, assets.cover);
    s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 6.9, h: H, fill: { color: C.navy, transparency: 5 }, line: { transparency: 100 } });
    text(s, "Human-in-the-Loop\nGeospatial Agent Design", 0.78, 1.18, 6.25, 1.34, { size: 33, color: C.cream, fontFace: titleFont, fit: "shrink" });
    text(s, "for SatGPT Pro Flood Analysis", 0.82, 2.78, 5.6, 0.36, { size: 20, color: C.cyan2, fontFace: titleFont });
    rule(s, 0.82, 3.36, 2.35, C.green2);
    text(s, "Making AI-assisted flood mapping controllable,\nreviewable, and executable", 0.82, 3.75, 5.75, 0.52, { size: 14.2, color: C.gray });
    chip(s, "10 MIN TECHNICAL TALK", 0.82, 5.35, 1.78, C.green2);
    chip(s, "EARTH ENGINE EXECUTION", 2.82, 5.35, 2.05, C.cyan);
    chip(s, "MAP EVIDENCE", 5.08, 5.35, 1.35, C.red);
    brandLogo(s, assets, 0.82, 6.55, 2.55);
    notes(s, "今天不重复介绍 SatGPT 平台，而是聚焦一个技术问题：在洪水遥感分析中，如何让 AI Agent 的输出可控、可检查、可执行。");
  }

  // 2 Loop
  {
    const s = pptx.addSlide(); bg(s, assets.mapSoft, "clean"); title(s, 2, "Human-in-the-Loop Is a Control Loop", "AI proposes → Human reviews → System executes → Results feed back");
    s.addShape(pptx.ShapeType.ellipse, { x: 3.1, y: 1.78, w: 5.2, h: 4.0, fill: { color: C.navy, transparency: 100 }, line: { color: "25435E", width: 1.8 } });
    s.addShape(pptx.ShapeType.ellipse, { x: 4.45, y: 2.63, w: 2.5, h: 1.85, fill: { color: C.navy, transparency: 8 }, line: { color: C.green2, width: 1.4 } });
    text(s, "decision\nboundary", 5.02, 3.15, 1.38, 0.52, { size: 18, color: C.cream, fontFace: titleFont, align: "center" });
    const pts = [
      ["AI proposes", 1.15, 2.05, C.cyan],
      ["Human reviews", 4.55, 1.25, C.red],
      ["System executes", 8.4, 2.05, C.green2],
      ["Results feed back", 4.45, 5.38, C.yellow],
    ];
    pts.forEach(p => node(s, p[0], p[1], p[2], 2.1, 0.52, { accent: p[3], size: 12.2, shadow: true }));
    arrow(s, 3.25, 2.32, 4.45, 1.62, C.cyan, 1.5);
    arrow(s, 6.66, 1.62, 8.35, 2.32, C.red, 1.5);
    arrow(s, 9.1, 2.62, 6.5, 5.34, C.green2, 1.5);
    arrow(s, 4.45, 5.62, 2.32, 2.62, C.yellow, 1.5);
    text(s, "HITL places human judgment inside the AI decision loop, especially where uncertainty and responsibility matter.", 0.86, 6.12, 7.8, 0.35, { size: 15.5, color: C.gray });
    text(s, "Not a “confirm button”.\nA feedback control system.", 9.15, 5.28, 2.65, 0.62, { size: 18, color: C.cream, fontFace: titleFont });
    addFooter(s, assets); notes(s, "HITL 的 “loop” 来自反馈回路，不是简单“人在旁边看一下”。AI 提出假设，人类审查关键点，系统再执行动作，结果还能反向影响下一次流程。");
  }

  // 3 Disaster assumptions
  {
    const s = pptx.addSlide(); bg(s, assets.mapSoft, "clean"); title(s, 3, "Flood Mapping Is Not Just Text Generation", "A flood request hides execution-critical assumptions.");
    node(s, "Flood analysis\nrequest", 4.9, 3.02, 2.35, 0.88, { accent: C.red, size: 17, fill: "172033", shadow: true });
    const items = [["event", 1.2, 1.85, C.red], ["dates", 5.2, 1.62, C.yellow], ["spatial scope", 9.15, 1.85, C.cyan], ["datasets", 2.05, 5.25, C.green2], ["workflow", 8.65, 5.25, C.gray]];
    items.forEach(([v,x,y,c]) => { node(s, v, x, y, 1.75, 0.48, { accent: c, size: 12.3 }); arrow(s, x + 0.88, y + 0.48, 6.05, 3.05, c, 1.1); });
    s.addShape(pptx.ShapeType.line, { x: 0.95, y: 6.05, w: 5.4, h: 0, line: { color: C.red, width: 2.4 } });
    text(s, "If one assumption is wrong, the map evidence can become misleading.", 0.95, 6.28, 7.4, 0.32, { size: 17.5, color: C.cream, fontFace: titleFont });
    addFooter(s, assets); notes(s, "普通聊天错了只是文本不准；洪水制图里，时间窗口、AOI、数据源错一个，地图证据就可能误导。灾害遥感属于高风险 AI 辅助决策场景，不适合完全黑箱自动化。");
  }

  // 4 Design question
  {
    const s = pptx.addSlide(); bg(s, assets.mapDark); title(s, 4, "How Can SatGPT Pro Implement HITL?", "Insert a control layer between LLM assumptions and Earth Engine execution.");
    const xs = [0.8, 3.0, 5.2, 7.4, 9.6];
    const labs = ["Natural-language\nrequest", "LLM\nassumptions", "Human review\ncheckpoint", "Earth Engine\nexecution", "Map\nevidence"];
    labs.forEach((v,i)=> node(s, v, xs[i], 3.0, 1.65, 0.82, { accent: i===2?C.red:C.cyan, size: 10.8, fill: i===2?"241927":C.panel, shadow: true }));
    for (let i=0;i<4;i++) arrow(s, xs[i]+1.65, 3.41, xs[i+1]-0.06, 3.41, i===1?C.red:C.cyan, 1.6);
    text(s, "The checkpoint converts uncertain language into confirmed spatial analysis parameters.", 0.92, 5.36, 7.85, 0.35, { size: 18, color: C.cream, fontFace: titleFont });
    mapEvidence(s, 9.42, 4.76, 2.45, 1.35);
    addFooter(s, assets); notes(s, "这里的核心问题不是“怎么做一个确认弹窗”，而是如何在 LLM 和 GEE 执行之间插入一个控制层，把不确定的自然语言输出变成确认后的空间分析参数。");
  }

  // 5 LangGraph
  {
    const s = pptx.addSlide(); bg(s, assets.mapSoft, "clean"); title(s, 5, "From Conversation to Stateful Workflow", "LangGraph turns one chat into typed workflow responsibilities.");
    const steps = ["intent_node", "chat_node", "extraction_node", "pre_confirmation_node", "confirmation_node", "processing_node"];
    steps.forEach((v,i)=> {
      const x=0.72+i*2.05;
      node(s, v, x, 3.05, 1.66, 0.56, { accent: i===4?C.red:C.green2, size: 8.8, fill: i===4?"261827":C.panel });
      if(i<steps.length-1) arrow(s, x+1.66, 3.33, x+2.0, 3.33, i===3?C.red:C.green2, 1.1);
    });
    text(s, "State is the important part: each node narrows the next decision instead of asking the LLM to solve everything at once.", 0.88, 4.55, 7.95, 0.46, { size: 15.2, color: C.gray });
    if (fs.existsSync(GLOBE_ICON)) s.addImage({ path: GLOBE_ICON, x: 9.35, y: 2.15, w: 1.25, h: 1.25, transparency: 8 });
    text(s, "LangGraph\nStateGraph", 9.2, 3.62, 2.05, 0.52, { size: 22, color: C.cream, fontFace: titleFont, align: "center" });
    codeRef(s, "agent/flood_agent.py"); addFooter(s, assets); notes(s, "LangGraph 把一次聊天拆成任务流水线。每个节点职责明确：判断意图、对话/搜索、抽取结构化参数、准备确认、等待用户、执行报告和 GEE code 生成。");
  }

  // 6 Assumptions externalized
  {
    const s = pptx.addSlide(); bg(s, assets.mapSoft, "clean"); title(s, 6, "The Review Checkpoint Exposes AI Assumptions", "Hidden guesses become editable parameters.");
    text(s, "Hidden assumptions", 1.0, 2.1, 3.2, 0.22, { size: 13, color: C.muted, fontFace: monoFont });
    text(s, "Reviewable parameters", 7.0, 2.1, 3.2, 0.22, { size: 13, color: C.cyan2, fontFace: monoFont });
    node(s, "Free-form answer\nwith implicit choices", 1.05, 3.12, 2.8, 1.02, { accent: C.muted, size: 15, fill: C.ink });
    arrow(s, 4.05, 3.62, 6.3, 3.62, C.red, 2.2);
    ["Event name", "Event description", "Location", "Pre / peak / post dates", "Resolved AOI", "Recommended layers"].forEach((v,i)=>{
      node(s, v, 6.58+(i%2)*2.55, 2.58+Math.floor(i/2)*0.78, 2.05, 0.43, { accent: i>=4?C.red:C.cyan, size: 9.2, fill: "101B2D" });
    });
    text(s, "Experts review variables, not prose.", 1.05, 5.58, 5.9, 0.36, { size: 20, color: C.cream, fontFace: titleFont });
    codeRef(s, "confirmation_node · EventConfirmation.js"); addFooter(s, assets); notes(s, "这一页讲“显式化”。AI 原本藏在回答里的判断，被拆成一组可检查参数。专家看到的不是一段自然语言，而是事件、时间、空间、图层这些可修正变量。");
  }

  // 7 beyond AOI
  {
    const s = pptx.addSlide(); bg(s, assets.mapDark); title(s, 7, "Reviewing Where and What to Compute", "HITL controls spatial scope, temporal window, and layer selection.");
    const blocks = [["spatial scope", "AOI / resolved boundary", C.cyan], ["temporal window", "pre · peak · post", C.yellow], ["dataset selection", "layers + execution profiles", C.green2]];
    blocks.forEach(([h,b,c],i)=>{
      const x=0.95+i*4.05;
      rule(s, x, 2.42, 2.2, c);
      text(s, h, x, 2.72, 2.8, 0.28, { size: 20, color: C.cream, fontFace: titleFont });
      text(s, b, x, 3.14, 2.7, 0.22, { size: 11.4, color: C.gray });
      if(i===0) mapEvidence(s, x, 4.02, 2.35, 1.2);
      if(i===1){ s.addShape(pptx.ShapeType.line,{x:x+0.15,y:4.63,w:2.3,h:0,line:{color:c,width:2.4}}); [0.15,1.12,2.45].forEach((dx,j)=>s.addShape(pptx.ShapeType.ellipse,{x:x+dx,y:4.52,w:0.2,h:0.2,fill:{color:j===1?C.red:c},line:{color:j===1?C.red:c}})); }
      if(i===2){ [0,0.22,0.44].forEach((dy,j)=>s.addShape(pptx.ShapeType.rect,{x:x+0.16+j*0.18,y:4.05+dy,w:2.25,h:0.62,fill:{color:c,transparency:80-j*8},line:{color:c,width:1}})); }
    });
    text(s, "The contribution is not “AOI upload”. It is forcing where and what to compute into the same review loop.", 0.96, 5.92, 8.8, 0.42, { size: 15.5, color: C.gray });
    addFooter(s, assets); notes(s, "AOI 本身不是贡献点，搜索/上传/手绘只是入口。真正重要的是：空间范围和数据层选择都必须进入确认流程。HITL 控制的不只是 where，也包括 what to compute。");
  }

  // 8 Dataset registry
  {
    const s = pptx.addSlide(); bg(s, assets.mapSoft, "clean"); title(s, 8, "Dataset Registry Constrains LLM Output to Executable Assets", "The registry is the execution contract between language and GEE.");
    const labs = ["registry", "recommended layers", "render_layer()", "GEE tile URL"];
    [0.9,3.35,6.05,8.65].forEach((x,i)=>{ node(s, labs[i], x, 3.05, i===1?1.85:1.55, 0.55, { accent: [C.green2,C.cyan,C.yellow,C.red][i], size: 10.5 }); if(i<3) arrow(s, x+(i===1?1.85:1.55),3.33,[3.28,5.96,8.58][i],3.33,[C.green2,C.cyan,C.yellow][i],1.4); });
    ["asset_id", "selection_profile", "render_profile", "legend_spec", "execution_profile"].forEach((v,i)=>chip(s,v,0.96+i*2.18,4.62,1.76,i===4?C.red:C.cyan));
    text(s, "This prevents the model from merely saying “use Sentinel-1”; it must select assets the system can actually execute.", 0.98, 5.58, 8.7, 0.38, { size: 15.6, color: C.gray });
    if (fs.existsSync(DOC_ICON)) s.addImage({ path: DOC_ICON, x: 10.78, y: 2.65, w: 0.85, h: 0.85, transparency: 14 });
    codeRef(s, "flood_dataset_service.py · flood_dataset_registry.json"); addFooter(s, assets); notes(s, "普通 LLM 会说“可以用 Sentinel-1”。这里更进一步：系统用 registry 把数据集变成可执行资产，包含 asset id、渲染规则、图例、执行条件，避免 LLM 凭空编数据。");
  }

  // 9 Execution evidence
  {
    const s = pptx.addSlide(); bg(s, assets.mapDark); title(s, 9, "Controlled Execution Produces Map Evidence", "Confirmed parameters drive inspectable spatial outputs.");
    const steps = ["confirmed event", "AOI", "selected layers", "GEE processing", "tile URLs", "map visualization", "report / GEE code"];
    let x=0.72; steps.forEach((v,i)=>{ const w=i===2||i===6?1.5:1.14; node(s,v,x,2.58,w,0.52,{accent:i>=3?C.red:C.cyan,size:8.2,fill:i>=3?"211A27":C.panel}); if(i<steps.length-1) arrow(s,x+w,2.84,x+w+0.25,2.84,i>=2?C.red:C.cyan,1.05); x+=w+0.31; });
    mapEvidence(s, 3.2, 3.62, 4.1, 1.92);
    text(s, "The final output is not just a report. It is map evidence the expert can inspect.", 0.92, 5.92, 8.2, 0.38, { size: 18, color: C.cream, fontFace: titleFont });
    codeRef(s, "gee_service.py · AgentPanel.js"); addFooter(s, assets); notes(s, "最终输出不只是报告文本，而是可检查的地图证据。Agent 的价值不是“回答得像专家”，而是把确认后的参数送入 Earth Engine，生成可以被专家复核的空间结果。");
  }

  // 10 Demo
  {
    const s = pptx.addSlide(); bg(s, assets.mapSoft, "clean"); title(s, 10, "Demo: One HITL-Controlled Flood Analysis Flow", "One chain is enough: ask → extract → confirm → render → export.");
    const demo = [["01","Ask for a concrete flood analysis"],["02","Agent extracts event parameters"],["03","Human confirms event, AOI, and layers"],["04","GEE renders map evidence"]];
    demo.forEach(([n,t],i)=>{ const x=0.82+i*3.05; s.addShape(pptx.ShapeType.rect,{x,y:2.18,w:2.55,h:2.65,fill:{color:"0B1324",transparency:4},line:{color:i===2?C.red:C.cyan,width:1.2}}); text(s,n,x+0.16,2.38,0.45,0.18,{size:11,color:i===2?C.red:C.cyan,fontFace:monoFont,bold:true}); s.addShape(pptx.ShapeType.line,{x:x+0.2,y:3.08,w:2.1,h:0,line:{color:"324256",width:1}}); s.addShape(pptx.ShapeType.line,{x:x+0.2,y:3.34,w:1.55,h:0,line:{color:"324256",width:1}}); if(i===3) mapEvidence(s,x+0.32,3.0,1.85,1.05); text(s,t,x+0.18,4.08,2.18,0.38,{size:11.4,color:C.cream,fit:"shrink"}); });
    text(s, "5. Export report / GEE code", 0.94, 5.63, 4.2, 0.28, { size: 18, color: C.gray, fontFace: titleFont });
    text(s, "Replace these placeholders with real UI captures after the live demo flow is stable.", 0.96, 6.12, 7.6, 0.22, { size: 10, color: C.muted, fontFace: monoFont });
    addFooter(s, assets); notes(s, "Demo 只展示一条链路，不展开所有功能。目标是证明 HITL 如何把 AI 假设变成地图结果。");
  }

  // 11 Closing
  {
    const s = pptx.addSlide(); bg(s, assets.campus || assets.mapDark);
    title(s, 11, "Toward Controllable AI-Assisted Geospatial Workflows", "The goal is faster expert work, not expert replacement.");
    text(s, "The goal is not to replace geospatial experts,\nbut to make AI-assisted flood analysis more explicit,\ncontrollable, and reproducible.", 0.92, 2.45, 6.9, 1.28, { size: 26, color: C.cream, fontFace: titleFont, fit: "shrink" });
    ["explicit", "controllable", "reproducible"].forEach((v,i)=>chip(s,v,0.96+i*1.62,4.42,1.36,i===1?C.red:C.green2));
    if (fs.existsSync(CHART_ICON)) s.addImage({ path: CHART_ICON, x: 9.2, y: 2.42, w: 1.22, h: 1.22, transparency: 8 });
    text(s, "language → parameters → execution → evidence", 8.1, 4.1, 3.5, 0.25, { size: 12, color: C.cyan2, fontFace: monoFont, align: "center" });
    addFooter(s, assets); notes(s, "SatGPT Pro 的关键不是让 AI 完全自动替代专家，而是让专家工作流更快、更显式、更可复现。HITL 是把 LLM 不确定性接入真实遥感工作流的关键控制机制。");
  }

  await pptx.writeFile({ fileName: PPTX });
  await renderStoryboard(assets);
  console.log(PPTX);
  console.log(PREVIEW);
}

function svgSlide(i, title, subtitle) {
  return `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
  <defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#07111F"/><stop offset="1" stop-color="#0B2135"/></linearGradient></defs>
  <rect width="1920" height="1080" fill="url(#g)"/>
  <rect x="0" y="0" width="22" height="1080" fill="#007A4D"/><rect x="22" y="0" width="5" height="1080" fill="#18A0FB"/>
  <path d="M980 820 C1150 720 1320 880 1500 760 S1750 690 1920 780 L1920 1080 L980 1080Z" fill="#102238" opacity=".9"/>
  <line x1="90" y1="165" x2="330" y2="165" stroke="#00A86B" stroke-width="6"/>
  <text x="90" y="105" fill="#67E8F9" font-family="Cascadia Mono, monospace" font-size="24">${String(i).padStart(2,"0")}</text>
  <text x="90" y="255" fill="#EEF6E8" font-family="Aptos Display, Calibri, sans-serif" font-size="56">${escape(title)}</text>
  <text x="90" y="330" fill="#CBD5E1" font-family="Aptos, Calibri, sans-serif" font-size="30">${escape(subtitle)}</text>
  <circle cx="1510" cy="500" r="170" fill="none" stroke="#18A0FB" stroke-width="6" opacity=".52"/>
  <circle cx="1510" cy="500" r="95" fill="none" stroke="#EF4444" stroke-width="6" opacity=".78"/>
  <text x="1540" y="970" text-anchor="end" fill="#EEF6E8" font-family="Cascadia Mono, monospace" font-size="22">NNU · SatGPT Pro</text>
  </svg>`;
}

async function renderStoryboard() {
  const slides = [
    ["Human-in-the-Loop Geospatial Agent Design", "for SatGPT Pro Flood Analysis"],
    ["Human-in-the-Loop Is a Control Loop", "AI proposes → Human reviews → System executes → Results feed back"],
    ["Flood Mapping Is Not Just Text Generation", "event · dates · spatial scope · datasets · workflow"],
    ["How Can SatGPT Pro Implement HITL?", "language → assumptions → review checkpoint → Earth Engine → evidence"],
    ["From Conversation to Stateful Workflow", "intent_node → chat_node → extraction_node → confirmation_node"],
    ["The Review Checkpoint Exposes AI Assumptions", "hidden guesses become editable parameters"],
    ["Reviewing Where and What to Compute", "spatial scope · temporal window · dataset selection"],
    ["Dataset Registry Constrains LLM Output", "asset_id · render_profile · legend_spec · execution_profile"],
    ["Controlled Execution Produces Map Evidence", "confirmed parameters drive GEE outputs"],
    ["Demo: One HITL-Controlled Flood Analysis Flow", "ask → extract → confirm → render → export"],
    ["Toward Controllable AI-Assisted Geospatial Workflows", "explicit · controllable · reproducible"],
  ];
  const pngs = [];
  for (let i = 0; i < slides.length; i++) {
    const p = path.join(PREVIEW, `slide_${String(i + 1).padStart(2, "0")}.png`);
    await sharp(Buffer.from(svgSlide(i + 1, slides[i][0], slides[i][1]))).png().toFile(p);
    pngs.push(p);
  }
  const thumbs = await Promise.all(pngs.map(p => sharp(p).resize(384, 216).toBuffer()));
  const cols = 4, rows = 3, tw = 384, th = 216, gap = 18;
  await sharp({ create: { width: cols * tw + (cols + 1) * gap, height: rows * th + (rows + 1) * gap, channels: 4, background: "#07111F" } })
    .composite(thumbs.map((input, i) => ({ input, left: gap + (i % cols) * (tw + gap), top: gap + Math.floor(i / cols) * (th + gap) })))
    .png().toFile(path.join(PREVIEW, "contact_sheet.png"));
}

function escape(s) {
  return String(s).replace(/[<>&"']/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" }[c]));
}

build().catch(err => { console.error(err); process.exit(1); });
