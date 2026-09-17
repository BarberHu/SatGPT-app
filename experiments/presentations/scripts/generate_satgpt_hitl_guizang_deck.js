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
const ASSETS = path.join(OUT, "satgpt_hitl_guizang_assets");
const TEMPLATE_ASSETS = path.join(OUT, "nsnu_template_assets");
const PPTX_PATH = path.join(OUT, "SatGPT_HITL_Geospatial_Agent_Talk.pptx");
const QA_PATH = path.join(PREVIEW, "qa_report.json");

const W = 13.333;
const H = 7.5;
const EMU_PER_IN = 914400;

const C = {
  navy: "0B1220",
  navy2: "07111F",
  panel: "101827",
  panel2: "162235",
  cyan: "18A0FB",
  cyan2: "67E8F9",
  red: "EF4444",
  gray: "E5E7EB",
  slate: "94A3B8",
  green: "0B7A53",
  green2: "22C55E",
  yellow: "F59E0B",
  white: "FFFFFF",
  black: "000000",
};

const fontHead = "Aptos Display";
const fontBody = "Aptos";
const fontMono = "Cascadia Mono";

const qa = {
  toolchain: "guizang-ppt-skill visual method + PptxGenJS editable PPTX + Sharp PNG preview/contact sheet + JSZip OpenXML QA",
  pptxPath: PPTX_PATH,
  previewPath: PREVIEW,
  contactSheetPath: path.join(PREVIEW, "contact_sheet.png"),
  slideCount: 0,
  notesCount: 0,
  checks: {
    bounds: [],
    textBoxGeometry: [],
    estimatedOverflow: [],
    contrast: [],
  },
  verdict: "pending",
};

let pptx;
let tracked = [];
let notesCounter = 0;

const CHINESE_NOTES = [
  ["\u8bb2\u6cd5\uff1a\u672c\u9875\u805a\u7126 HITL \u7684\u6280\u672f\u610f\u4e49\uff0c\u4e0d\u5c55\u5f00 SatGPT \u5e73\u53f0\u4ecb\u7ecd\uff1b\u91cd\u70b9\u662f\u6d2a\u6c34\u5236\u56fe\u5982\u4f55\u53ef\u63a7\u3001\u53ef\u5ba1\u67e5\u3001\u53ef\u6267\u884c\u3002"],
  ["\u8bb2\u6cd5\uff1aHITL \u4e0d\u662f\u4e00\u4e2a confirm button\uff0c\u800c\u662f AI proposes\u3001Human reviews\u3001System executes\u3001Results feedback \u7684\u63a7\u5236\u95ed\u73af\u3002"],
  ["\u8bb2\u6cd5\uff1a\u6d2a\u6c34\u5236\u56fe\u4e0d\u662f\u6587\u672c\u751f\u6210\uff1b\u4e00\u4e2a\u8bf7\u6c42\u91cc\u9690\u542b event\u3001dates\u3001spatial scope\u3001datasets\u3001workflow \u7b49\u5173\u952e\u5047\u8bbe\u3002"],
  ["\u8bb2\u6cd5\uff1aSatGPT Pro \u7684\u8bbe\u8ba1\u95ee\u9898\u662f\u5728 LLM assumptions \u548c Earth Engine execution \u4e4b\u95f4\u653e\u5165 human review checkpoint\u3002"],
  ["\u8bb2\u6cd5\uff1aflood_agent.py \u7684 StateGraph \u628a\u5bf9\u8bdd\u62c6\u6210 intent\u3001chat\u3001extraction\u3001confirmation\u3001processing \u7b49\u72b6\u6001\u8282\u70b9\u3002"],
  ["\u8bb2\u6cd5\uff1aconfirmation_node \u548c EventConfirmation.js \u628a AI \u5047\u8bbe\u66b4\u9732\u4e3a\u53ef\u7f16\u8f91\u53c2\u6570\uff1aevent\u3001location\u3001dates\u3001AOI\u3001layers\u3002"],
  ["\u8bb2\u6cd5\uff1aHITL \u4e0d\u53ea\u662f\u5ba1\u67e5 AOI\uff0c\u800c\u662f\u540c\u65f6\u5ba1\u67e5 where to compute \u548c what to compute\u3002"],
  ["\u8bb2\u6cd5\uff1aflood_dataset_registry.json \u662f\u6267\u884c\u5408\u540c\uff1basset_id\u3001render_profile\u3001legend_spec\u3001execution_profile \u7ea6\u675f LLM \u8f93\u51fa\u3002"],
  ["\u8bb2\u6cd5\uff1agee_service.py \u628a\u786e\u8ba4\u53c2\u6570\u8f6c\u6210 tile_url\uff0cAgentPanel.js \u628a tile_url \u53d8\u6210\u53ef\u68c0\u67e5\u7684\u5730\u56fe\u8bc1\u636e\u3002"],
  ["\u8bb2\u6cd5\uff1aDemo \u53ea\u8d70\u4e00\u6761\u94fe\uff1aAsk\u3001Extract\u3001Confirm\u3001Render\u3001Export\uff1b\u907f\u514d\u5f00\u653e\u5f0f\u529f\u80fd\u6f2b\u6e38\u3002"],
  ["\u8bb2\u6cd5\uff1a\u7ed3\u8bba\u56de\u5230\u6838\u5fc3\uff1aAI \u4e0d\u662f\u66ff\u4ee3 GIS \u4e13\u5bb6\uff0c\u800c\u662f\u8ba9\u6d2a\u6c34\u5206\u6790\u66f4\u663e\u6027\u3001\u53ef\u63a7\u3001\u53ef\u590d\u73b0\u3002"],
];

function ensureCleanDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
}

function hexToRgb(hex) {
  const s = hex.replace("#", "");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(v => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function escXml(s) {
  return String(s).replace(/[<>&"']/g, ch => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "\"": "&quot;", "'": "&apos;" }[ch]));
}

function rng(seed) {
  let x = seed >>> 0;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) / 4294967296);
  };
}

async function generateAssets() {
  fs.mkdirSync(ASSETS, { recursive: true });
  const satellite = path.join(ASSETS, "satellite_flood_background.png");
  const evidence = path.join(ASSETS, "map_evidence_panel.png");
  const softMap = path.join(ASSETS, "soft_map_texture.png");
  const logoSrc = path.join(TEMPLATE_ASSETS, "image2.png");
  const logo = path.join(ASSETS, "nnu_logo_trimmed.png");

  const rnd = rng(20260513);
  let land = "";
  for (let i = 0; i < 75; i++) {
    const x = Math.round(rnd() * 1920);
    const y = Math.round(rnd() * 1080);
    const w = 80 + Math.round(rnd() * 260);
    const h = 50 + Math.round(rnd() * 220);
    const c = ["#143022", "#1f3d2d", "#243b34", "#334155", "#1e293b"][Math.floor(rnd() * 5)];
    land += `<ellipse cx="${x}" cy="${y}" rx="${w}" ry="${h}" fill="${c}" opacity="${0.18 + rnd() * 0.28}"/>`;
  }
  let grid = "";
  for (let x = 0; x <= 1920; x += 120) grid += `<line x1="${x}" y1="0" x2="${x}" y2="1080" stroke="#18A0FB" stroke-opacity=".10" stroke-width="1"/>`;
  for (let y = 0; y <= 1080; y += 120) grid += `<line x1="0" y1="${y}" x2="1920" y2="${y}" stroke="#18A0FB" stroke-opacity=".10" stroke-width="1"/>`;

  const satSvg = `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".78" numOctaves="3" seed="9"/><feColorMatrix type="saturate" values=".25"/><feBlend mode="screen" in2="SourceGraphic"/></filter>
    <radialGradient id="scan" cx="66%" cy="38%" r="80%"><stop offset="0" stop-color="#113B4D"/><stop offset=".58" stop-color="#0B1220"/><stop offset="1" stop-color="#07111F"/></radialGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#scan)"/>
  <g filter="url(#grain)" opacity=".9">${land}</g>
  <path d="M-40 760 C240 620 410 730 610 570 S900 330 1130 430 1410 690 1970 470" fill="none" stroke="#18A0FB" stroke-width="92" stroke-opacity=".34"/>
  <path d="M-30 795 C260 660 440 780 650 610 S910 390 1135 485 1440 735 1960 535" fill="none" stroke="#67E8F9" stroke-width="26" stroke-opacity=".45"/>
  <path d="M660 550 C850 480 1050 530 1215 610 1330 666 1455 730 1605 700 1440 850 1180 895 965 825 780 764 672 695 550 710Z" fill="#EF4444" opacity=".48"/>
  <path d="M715 578 C880 535 1030 577 1188 645 1300 694 1395 728 1512 715" fill="none" stroke="#FCA5A5" stroke-width="16" stroke-opacity=".48"/>
  ${grid}
  <rect width="1920" height="1080" fill="#0B1220" opacity=".28"/>
  <rect x="0" y="0" width="760" height="1080" fill="#07111F" opacity=".72"/>
  </svg>`;
  await sharp(Buffer.from(satSvg)).png().toFile(satellite);

  const evidenceSvg = `<svg width="1200" height="720" xmlns="http://www.w3.org/2000/svg">
  <rect width="1200" height="720" fill="#07111F"/>
  <g opacity=".25">${grid.replaceAll("1920", "1200").replaceAll("1080", "720")}</g>
  <path d="M20 510 C180 410 330 520 490 390 S750 205 920 286 1040 470 1190 405" fill="none" stroke="#18A0FB" stroke-width="58" stroke-opacity=".40"/>
  <path d="M420 360 C555 315 690 352 830 430 915 474 1015 492 1100 462 1000 600 790 632 632 570 505 522 435 470 345 482Z" fill="#EF4444" opacity=".56"/>
  <rect x="34" y="34" width="240" height="90" rx="10" fill="#0B1220" opacity=".88" stroke="#18A0FB"/>
  <text x="58" y="72" fill="#E5E7EB" font-family="Aptos, Arial" font-size="25">Flood extent</text>
  <text x="58" y="106" fill="#94A3B8" font-family="Cascadia Mono, monospace" font-size="17">GEE tile evidence</text>
  <rect x="930" y="42" width="210" height="120" rx="10" fill="#0B1220" opacity=".88" stroke="#22C55E"/>
  <text x="958" y="84" fill="#E5E7EB" font-family="Cascadia Mono, monospace" font-size="20">AOI</text>
  <text x="958" y="119" fill="#67E8F9" font-family="Cascadia Mono, monospace" font-size="18">verified</text>
  </svg>`;
  await sharp(Buffer.from(evidenceSvg)).png().toFile(evidence);

  const softSvg = satSvg.replace('opacity=".72"', 'opacity=".18"').replace('opacity=".28"', 'opacity=".58"');
  await sharp(Buffer.from(softSvg)).blur(1.6).png().toFile(softMap);

  if (fs.existsSync(logoSrc)) {
    await sharp(logoSrc).trim({ background: "#ffffff" }).resize({ width: 900 }).png().toFile(logo);
  }
  return { satellite, evidence, softMap, logo };
}

function initDeck() {
  pptx = new PptxGenJS();
  pptx.layout = "LAYOUT_WIDE";
  pptx.defineLayout({ name: "LAYOUT_WIDE", width: W, height: H });
  pptx.author = "SatGPT Pro";
  pptx.company = "Nanjing Normal University";
  pptx.subject = "Human-in-the-Loop Geospatial Agent Design for SatGPT Pro Flood Analysis";
  pptx.title = "Human-in-the-Loop Geospatial Agent Design";
  pptx.lang = "en-US";
  pptx.theme = { headFontFace: fontHead, bodyFontFace: fontBody, lang: "en-US" };
}

function track(slideNo, kind, x, y, w, h, text = "", opts = {}) {
  tracked.push({ slideNo, kind, x, y, w, h, text, opts });
}

function addText(s, slideNo, value, x, y, w, h, opts = {}) {
  const fontSize = opts.size || 16;
  const color = opts.color || C.gray;
  const bg = opts.bg || C.navy;
  const ratio = contrast(color, bg);
  if (ratio < 4.2 && fontSize < 18) {
    qa.checks.contrast.push({ slide: slideNo, text: String(value).slice(0, 42), ratio: Number(ratio.toFixed(2)), color, bg });
  }
  const estimatedChars = Math.max(8, Math.floor((w * 96) / (fontSize * 0.53)));
  const lines = String(value).split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / estimatedChars)), 0);
  const estimatedHeight = lines * fontSize * 1.22 / 72;
  if (estimatedHeight > h * 1.12) {
    qa.checks.estimatedOverflow.push({ slide: slideNo, text: String(value).slice(0, 54), estimatedHeight: Number(estimatedHeight.toFixed(2)), boxHeight: h });
  }
  s.addText(value, {
    x, y, w, h,
    margin: opts.margin ?? 0.03,
    fontFace: opts.fontFace || fontBody,
    fontSize,
    color,
    bold: Boolean(opts.bold),
    italic: Boolean(opts.italic),
    align: opts.align || "left",
    valign: opts.valign || "mid",
    fit: "shrink",
    breakLine: false,
    paraSpaceAfterPt: opts.paraSpaceAfterPt || 0,
  });
  track(slideNo, "text", x, y, w, h, value, opts);
}

function bg(s, slideNo, assets, mode = "dark") {
  s.background = { color: C.navy };
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: H, fill: { color: C.navy }, line: { transparency: 100 } });
  const img = mode === "cover" ? assets.satellite : assets.softMap;
  s.addImage({ path: img, x: 0, y: 0, w: W, h: H });
  s.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: W, h: H,
    fill: { color: C.navy, transparency: mode === "light" ? 8 : 20 },
    line: { transparency: 100 },
  });
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.13, h: H, fill: { color: C.green }, line: { transparency: 100 } });
  s.addShape(pptx.ShapeType.rect, { x: 0.13, y: 0, w: 0.035, h: H, fill: { color: C.cyan }, line: { transparency: 100 } });
  track(slideNo, "background", 0, 0, W, H);
}

function footer(s, slideNo, assets) {
  s.addShape(pptx.ShapeType.line, { x: 0.62, y: 7.02, w: 12.05, h: 0, line: { color: "243244", width: 0.8, transparency: 4 } });
  addText(s, slideNo, "NNU / GIS / SatGPT Pro", 0.68, 7.13, 2.6, 0.16, { size: 7.8, color: C.slate, fontFace: fontMono });
  if (assets.logo && fs.existsSync(assets.logo)) {
    s.addImage({ path: assets.logo, x: 10.38, y: 6.83, w: 2.15, h: 0.35, transparency: 8 });
  } else {
    addText(s, slideNo, "NANJING NORMAL UNIVERSITY", 9.75, 7.13, 2.8, 0.16, { size: 7.6, color: C.gray, fontFace: fontMono, align: "right" });
  }
}

function header(s, slideNo, title, subtitle, assets) {
  addText(s, slideNo, String(slideNo).padStart(2, "0"), 0.62, 0.43, 0.45, 0.18, { size: 8.5, color: C.cyan2, fontFace: fontMono, bold: true });
  s.addShape(pptx.ShapeType.line, { x: 1.12, y: 0.52, w: 1.18, h: 0, line: { color: C.green2, width: 2.2 } });
  addText(s, slideNo, title, 0.64, 0.82, 9.2, 0.46, { size: 26, color: C.gray, fontFace: fontHead, bg: C.navy });
  if (subtitle) addText(s, slideNo, subtitle, 0.66, 1.36, 8.9, 0.22, { size: 9.6, color: C.slate, fontFace: fontMono, bg: C.navy });
  addText(s, slideNo, "Human-in-the-Loop Geospatial Agent", 9.22, 0.43, 3.1, 0.18, { size: 7.8, color: C.slate, fontFace: fontMono, align: "right" });
  footer(s, slideNo, assets);
}

function node(s, slideNo, text, x, y, w, h, opts = {}) {
  const accent = opts.accent || C.cyan;
  s.addShape(opts.shape || pptx.ShapeType.roundRect, {
    x, y, w, h,
    rectRadius: 0.04,
    fill: { color: opts.fill || C.panel, transparency: opts.transparency ?? 0 },
    line: { color: accent, width: opts.lineWidth || 1.15, transparency: opts.lineTransparency ?? 0 },
    shadow: opts.shadow ? { type: "outer", color: "000000", opacity: 0.16, blur: 2, angle: 45, distance: 1 } : undefined,
  });
  addText(s, slideNo, text, x + 0.1, y + 0.04, w - 0.2, h - 0.08, {
    size: opts.size || 11,
    color: opts.color || C.gray,
    fontFace: opts.fontFace || fontBody,
    bold: opts.bold ?? true,
    align: opts.align || "center",
    bg: opts.fill || C.panel,
  });
  track(slideNo, "node", x, y, w, h, text, opts);
}

function chip(s, slideNo, text, x, y, w, accent = C.cyan) {
  s.addShape(pptx.ShapeType.roundRect, {
    x, y, w, h: 0.31,
    rectRadius: 0.06,
    fill: { color: accent, transparency: 84 },
    line: { color: accent, width: 0.8, transparency: 10 },
  });
  addText(s, slideNo, text, x + 0.07, y + 0.06, w - 0.14, 0.16, { size: 7.8, color: C.gray, fontFace: fontMono, align: "center", bg: C.navy });
}

function arrow(s, x1, y1, x2, y2, color = C.cyan, width = 1.3) {
  s.addShape(pptx.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color, width, endArrowType: "triangle" } });
}

function mapPanel(s, slideNo, assets, x, y, w, h) {
  s.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: C.navy2 }, line: { color: C.cyan, width: 1.2 } });
  s.addImage({ path: assets.evidence, x: x + 0.04, y: y + 0.04, w: w - 0.08, h: h - 0.08 });
  track(slideNo, "map", x, y, w, h);
}

function addCodeRef(s, slideNo, ref) {
  addText(s, slideNo, ref, 7.25, 6.46, 5.0, 0.18, { size: 7.1, color: C.slate, fontFace: fontMono, align: "right" });
}

function addNotes(s, lines) {
  const replacement = CHINESE_NOTES[notesCounter];
  notesCounter += 1;
  s.addNotes(replacement || lines);
}

function slide01(assets) {
  const n = 1;
  const s = pptx.addSlide();
  bg(s, n, assets, "cover");
  s.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 6.9, h: H, fill: { color: C.navy2, transparency: 3 }, line: { transparency: 100 } });
  addText(s, n, "Human-in-the-Loop\nGeospatial Agent Design", 0.78, 1.14, 6.2, 1.34, { size: 33, color: C.gray, fontFace: fontHead });
  addText(s, n, "for SatGPT Pro Flood Analysis", 0.82, 2.78, 5.75, 0.34, { size: 19.5, color: C.cyan2, fontFace: fontHead });
  s.addShape(pptx.ShapeType.line, { x: 0.82, y: 3.34, w: 2.35, h: 0, line: { color: C.green2, width: 2.7 } });
  addText(s, n, "Making AI-assisted flood mapping controllable,\nreviewable, and executable", 0.82, 3.74, 5.55, 0.55, { size: 14.3, color: C.gray });
  chip(s, n, "10 MIN TECHNICAL TALK", 0.82, 5.34, 1.78, C.green2);
  chip(s, n, "EARTH ENGINE", 2.82, 5.34, 1.45, C.cyan);
  chip(s, n, "MAP EVIDENCE", 4.48, 5.34, 1.38, C.red);
  footer(s, n, assets);
  addNotes(s, [
    "开场不介绍 SatGPT 平台全貌，直接把问题收束到 HITL：人类判断如何进入地理空间 Agent 的控制链。",
    "这页要建立基调：AI 辅助制图的价值不是更会聊天，而是把洪水分析变成可审查、可执行、可复现的工作流。",
  ]);
}

function slide02(assets) {
  const n = 2;
  const s = pptx.addSlide();
  bg(s, n, assets, "light");
  header(s, n, "Human-in-the-Loop Is a Control Loop", "AI proposes -> Human reviews -> System executes -> Results feed back", assets);
  s.addShape(pptx.ShapeType.ellipse, { x: 3.25, y: 1.82, w: 5.28, h: 4.05, fill: { color: C.navy, transparency: 100 }, line: { color: "2B4258", width: 1.8 } });
  node(s, n, "AI proposes", 1.05, 2.1, 2.0, 0.56, { accent: C.cyan, shadow: true });
  node(s, n, "Human reviews", 4.78, 1.62, 2.05, 0.56, { accent: C.red, fill: "251926", shadow: true });
  node(s, n, "System executes", 8.75, 2.1, 2.15, 0.56, { accent: C.green2, shadow: true });
  node(s, n, "Results feed back", 4.63, 5.34, 2.35, 0.56, { accent: C.yellow, shadow: true });
  node(s, n, "decision\nboundary", 4.75, 2.78, 2.25, 1.34, { accent: C.green2, fill: C.navy2, size: 17, fontFace: fontHead });
  arrow(s, 3.05, 2.38, 4.78, 1.9, C.cyan, 1.5);
  arrow(s, 6.84, 1.9, 8.72, 2.38, C.red, 1.5);
  arrow(s, 9.55, 2.68, 6.72, 5.34, C.green2, 1.5);
  arrow(s, 4.65, 5.52, 2.48, 2.66, C.yellow, 1.5);
  addText(s, n, "HITL is not a decorative confirm button. It is a feedback control system for high-consequence assumptions.", 0.86, 6.04, 8.2, 0.6, { size: 15.5, color: C.gray });
  addNotes(s, [
    "先解释 HITL 为什么叫 loop：它不是一次性审批，而是 AI 提议、人类审查、系统执行、结果反馈的闭环。",
    "类比 FPS 游戏：AI 像自动瞄准给出建议，但开火权和目标识别边界必须由人控制，尤其在灾害制图这种高后果任务里。",
  ]);
}

function slide03(assets) {
  const n = 3;
  const s = pptx.addSlide();
  bg(s, n, assets, "light");
  header(s, n, "Flood Mapping Is Not Just Text Generation", "A flood analysis request hides assumptions: event, dates, spatial scope, datasets, execution workflow.", assets);
  node(s, n, "Flood analysis\nrequest", 4.94, 3.0, 2.35, 0.88, { accent: C.red, fill: "241927", size: 17, fontFace: fontHead, shadow: true });
  const items = [
    ["event\nunderstanding", 1.05, 1.95, C.red],
    ["dates", 5.15, 1.62, C.yellow],
    ["spatial\nscope", 9.18, 1.95, C.cyan],
    ["datasets", 1.75, 5.15, C.green2],
    ["execution\nworkflow", 8.75, 5.15, C.gray],
  ];
  items.forEach(([label, x, y, col]) => {
    node(s, n, label, x, y, 1.78, 0.62, { accent: col, size: 11.2 });
    arrow(s, x + 0.89, y + 0.62, 6.1, 3.04, col, 1.05);
  });
  addText(s, n, "If one hidden assumption is wrong, the final map can look precise while being conceptually wrong.", 0.95, 5.98, 8.55, 0.62, { size: 17.5, color: C.gray, fontFace: fontHead });
  addNotes(s, [
    "强调灾害制图和普通文本生成的本质区别：文本错了通常是语义问题，地图错了会带来空间决策误导。",
    "这页只讲一个观点：洪水分析请求背后藏着多个默认假设，HITL 的技术意义就是把这些假设显性化。",
  ]);
}

function slide04(assets) {
  const n = 4;
  const s = pptx.addSlide();
  bg(s, n, assets, "dark");
  header(s, n, "How Can SatGPT Pro Implement HITL?", "Natural-language request -> LLM assumptions -> Human review checkpoint -> Earth Engine execution -> Map evidence", assets);
  const xs = [0.82, 3.0, 5.18, 7.55, 9.88];
  const labels = ["Natural-language\nrequest", "LLM\nassumptions", "Human review\ncheckpoint", "Earth Engine\nexecution", "Map\nevidence"];
  labels.forEach((label, i) => node(s, n, label, xs[i], 3.0, i === 2 ? 1.92 : 1.58, 0.82, { accent: i === 2 ? C.red : C.cyan, fill: i === 2 ? "251926" : C.panel, size: 10.6, shadow: true }));
  for (let i = 0; i < 4; i++) arrow(s, xs[i] + (i === 2 ? 1.92 : 1.58), 3.41, xs[i + 1] - 0.06, 3.41, i === 1 ? C.red : C.cyan, 1.55);
  addText(s, n, "The checkpoint is the conversion layer from uncertain language to confirmed geospatial parameters.", 0.95, 5.32, 7.85, 0.62, { size: 17.5, color: C.gray, fontFace: fontHead });
  mapPanel(s, n, assets, 9.35, 4.76, 2.55, 1.38);
  addNotes(s, [
    "这一页回答设计问题：SatGPT Pro 不应该让 LLM 直接驱动 GEE，而是在 LLM 假设和 Earth Engine 执行之间放一个审查点。",
    "宏观上这是控制层，微观上就是后面会看到的 confirmation_node 和前端确认面板。",
  ]);
}

function slide05(assets) {
  const n = 5;
  const s = pptx.addSlide();
  bg(s, n, assets, "light");
  header(s, n, "From Conversation to Stateful Workflow", "intent_node -> chat_node -> extraction_node -> pre_confirmation_node -> confirmation_node -> processing_node", assets);
  const steps = ["intent_node", "chat_node", "extraction_node", "pre_confirmation_node", "confirmation_node", "processing_node"];
  steps.forEach((step, i) => {
    const x = 0.7 + i * 2.05;
    node(s, n, step, x, 3.02, 1.66, 0.56, { accent: i === 4 ? C.red : C.green2, fill: i === 4 ? "251926" : C.panel, size: 8.6 });
    if (i < steps.length - 1) arrow(s, x + 1.66, 3.3, x + 1.98, 3.3, i === 3 ? C.red : C.green2, 1.1);
  });
  addText(s, n, "State matters: each node narrows the next decision instead of asking the LLM to solve everything in one prompt.", 0.88, 4.52, 8.25, 0.62, { size: 15.2, color: C.gray });
  node(s, n, "StateGraph\n+ interrupt", 9.35, 4.35, 2.25, 0.92, { accent: C.cyan, fill: C.navy2, size: 16, fontFace: fontHead });
  addCodeRef(s, n, "agent/flood_agent.py: StateGraph, pre_confirmation_node, confirmation_node");
  addNotes(s, [
    "这里不逐行讲代码，只把代码作为证据：flood_agent.py 里明确有 StateGraph，以及 intent/chat/extraction/pre_confirmation/confirmation/processing 这些节点。",
    "LangGraph 的价值是把聊天拆成状态机，不是让 LLM 一口气完成全部空间分析。",
  ]);
}

function slide06(assets) {
  const n = 6;
  const s = pptx.addSlide();
  bg(s, n, assets, "light");
  header(s, n, "The Review Checkpoint Exposes AI Assumptions", "The checkpoint turns hidden guesses into editable review parameters.", assets);
  node(s, n, "confirmation_node\ninterrupt()", 0.96, 2.48, 2.4, 0.78, { accent: C.red, fill: "251926", size: 14, fontFace: fontMono, shadow: true });
  arrow(s, 3.36, 2.87, 4.35, 2.87, C.red, 1.55);
  s.addShape(pptx.ShapeType.rect, { x: 4.38, y: 1.85, w: 7.35, h: 3.7, fill: { color: C.panel, transparency: 2 }, line: { color: C.cyan, width: 1.2 } });
  addText(s, n, "Review surface", 4.66, 2.12, 1.8, 0.26, { size: 16, color: C.gray, fontFace: fontHead, bg: C.panel });
  const fields = ["Event name", "Event description", "Location", "Pre / peak / post dates", "Resolved AOI", "Recommended layers"];
  fields.forEach((field, i) => node(s, n, field, 4.68 + (i % 2) * 3.25, 2.62 + Math.floor(i / 2) * 0.72, 2.68, 0.42, { accent: i >= 4 ? C.red : C.cyan, size: 9.2, fill: "0F1B2D" }));
  addText(s, n, "Experts review variables, not prose.", 0.98, 5.72, 5.65, 0.36, { size: 20, color: C.gray, fontFace: fontHead });
  addCodeRef(s, n, "agent/flood_agent.py: confirmation_node / frontend/src/components/EventConfirmation.js");
  addNotes(s, [
    "这页是 HITL 的核心：不是让专家读一段 AI 解释，而是把 event、description、location、date、AOI、layers 变成可编辑字段。",
    "前端 EventConfirmation.js 里能看到字段编辑、AOI 绑定、图层勾选和 Confirm/Cancel，这就是人类审查真正落地的位置。",
  ]);
}

function slide07(assets) {
  const n = 7;
  const s = pptx.addSlide();
  bg(s, n, assets, "dark");
  header(s, n, "Reviewing Where and What to Compute", "HITL reviews spatial scope, temporal window, and dataset/layer selection.", assets);
  const blocks = [
    ["spatial scope", "AOI / resolved boundary", C.cyan],
    ["temporal window", "pre -> peak -> post", C.yellow],
    ["dataset selection", "layers + execution profiles", C.green2],
  ];
  blocks.forEach(([h, b, col], i) => {
    const x = 0.95 + i * 4.05;
    s.addShape(pptx.ShapeType.line, { x, y: 2.32, w: 2.1, h: 0, line: { color: col, width: 2.5 } });
    addText(s, n, h, x, 2.62, 2.86, 0.38, { size: 19.5, color: C.gray, fontFace: fontHead });
    addText(s, n, b, x, 3.08, 2.72, 0.22, { size: 11.0, color: C.slate, bg: C.navy });
    if (i === 0) mapPanel(s, n, assets, x, 3.86, 2.42, 1.28);
    if (i === 1) {
      s.addShape(pptx.ShapeType.line, { x: x + 0.18, y: 4.5, w: 2.35, h: 0, line: { color: col, width: 2.2 } });
      [0.18, 1.18, 2.48].forEach((dx, j) => s.addShape(pptx.ShapeType.ellipse, { x: x + dx, y: 4.4, w: 0.2, h: 0.2, fill: { color: j === 1 ? C.red : col }, line: { color: j === 1 ? C.red : col } }));
      addText(s, n, "pre        peak       post", x + 0.05, 4.75, 2.8, 0.18, { size: 8, color: C.slate, fontFace: fontMono });
    }
    if (i === 2) {
      ["DSWX", "GFD", "JRC"].forEach((t, j) => node(s, n, t, x + 0.18, 3.9 + j * 0.42, 2.02, 0.3, { accent: col, size: 8.3, fill: "102033" }));
    }
  });
  addText(s, n, "The contribution is not just AOI upload. It is forcing where and what to compute into the same review loop.", 0.96, 5.86, 9.0, 0.56, { size: 15.4, color: C.gray });
  addNotes(s, [
    "这里要纠正一个常见误区：HITL 不等于用户画 AOI。AOI 只是 where，真正要控制的是 where 和 what to compute 同时进入审查。",
    "SatGPT Pro 的价值是把空间范围、时间窗口和数据图层放在一个确认界面里，而不是分散在多个隐式默认值中。",
  ]);
}

function slide08(assets) {
  const n = 8;
  const s = pptx.addSlide();
  bg(s, n, assets, "light");
  header(s, n, "Dataset Registry Constrains LLM Output to Executable Assets", "The registry is the execution contract between language and GEE.", assets);
  const labels = ["registry", "recommended layers", "render_layer()", "GEE tile URL"];
  const xs = [0.9, 3.35, 6.02, 8.62];
  labels.forEach((label, i) => {
    node(s, n, label, xs[i], 3.02, i === 1 ? 1.85 : 1.55, 0.56, { accent: [C.green2, C.cyan, C.yellow, C.red][i], size: 10.5 });
    if (i < 3) arrow(s, xs[i] + (i === 1 ? 1.85 : 1.55), 3.3, xs[i + 1] - 0.06, 3.3, [C.green2, C.cyan, C.yellow][i], 1.4);
  });
  ["asset_id", "selection_profile", "render_profile", "legend_spec", "execution_profile"].forEach((v, i) => chip(s, n, v, 0.96 + i * 2.18, 4.58, 1.72, i === 4 ? C.red : C.cyan));
  addText(s, n, "This prevents the model from merely saying \"use Sentinel-1\"; it must select assets the system can execute.", 0.98, 5.46, 8.65, 0.58, { size: 15.5, color: C.gray });
  addCodeRef(s, n, "agent/flood_dataset_service.py / agent/config/flood_dataset_registry.json");
  addNotes(s, [
    "registry 是语言和执行之间的合同。LLM 不能只说用 Sentinel-1，而要落到 asset_id、render_profile、legend_spec、execution_profile。",
    "这就是 flood_dataset_registry.json 的技术意义：它把模型输出约束成 GEE 可以执行、前端可以渲染、用户可以理解的资产。",
  ]);
}

function slide09(assets) {
  const n = 9;
  const s = pptx.addSlide();
  bg(s, n, assets, "dark");
  header(s, n, "Controlled Execution Produces Map Evidence", "confirmed event + AOI + selected layers -> GEE processing -> tile URLs -> map visualization -> report / GEE code", assets);
  const steps = ["confirmed event", "AOI", "selected layers", "GEE processing", "tile URLs", "map visualization", "report / GEE code"];
  let x = 0.72;
  steps.forEach((step, i) => {
    const w = i === 2 || i === 6 ? 1.5 : 1.14;
    node(s, n, step, x, 2.5, w, 0.52, { accent: i >= 3 ? C.red : C.cyan, fill: i >= 3 ? "211A27" : C.panel, size: 8.0 });
    if (i < steps.length - 1) arrow(s, x + w, 2.76, x + w + 0.25, 2.76, i >= 2 ? C.red : C.cyan, 1.05);
    x += w + 0.31;
  });
  mapPanel(s, n, assets, 3.18, 3.5, 4.3, 2.02);
  addText(s, n, "The final output is not just a report. It is map evidence the expert can inspect.", 0.92, 5.9, 8.35, 0.36, { size: 18, color: C.gray, fontFace: fontHead });
  addCodeRef(s, n, "agent/gee_service.py / frontend/src/components/AgentPanel.js");
  addNotes(s, [
    "这页把后端和前端串起来：gee_service.py 生成 tile_url，AgentPanel.js 负责推荐图层渲染、图例、导出 GEE code 和报告入口。",
    "关键观点：受控执行的产物不是漂亮文本，而是地图证据。专家可以看、可以质疑、可以复现。",
  ]);
}

function slide10(assets) {
  const n = 10;
  const s = pptx.addSlide();
  bg(s, n, assets, "light");
  header(s, n, "Demo: One HITL-Controlled Flood Analysis Flow", "Ask -> extract event parameters -> confirm event/AOI/layers -> render map evidence -> export report/GEE code", assets);
  const demo = [
    ["01", "Ask", "concrete flood analysis request"],
    ["02", "Extract", "event, location, dates"],
    ["03", "Confirm", "event / AOI / layers"],
    ["04", "Render", "map evidence + exports"],
  ];
  demo.forEach(([num, head, sub], i) => {
    const x = 0.82 + i * 3.05;
    s.addShape(pptx.ShapeType.rect, { x, y: 2.02, w: 2.58, h: 3.05, fill: { color: "0B1324", transparency: 2 }, line: { color: i === 2 ? C.red : C.cyan, width: 1.15 } });
    addText(s, n, num, x + 0.18, 2.26, 0.5, 0.18, { size: 10.5, color: i === 2 ? C.red : C.cyan, fontFace: fontMono, bold: true, bg: "0B1324" });
    addText(s, n, head, x + 0.18, 2.68, 1.6, 0.36, { size: 18, color: C.gray, fontFace: fontHead, bg: "0B1324" });
    if (i === 3) {
      mapPanel(s, n, assets, x + 0.3, 3.12, 1.9, 1.06);
    } else {
      s.addShape(pptx.ShapeType.line, { x: x + 0.24, y: 3.22, w: 2.05, h: 0, line: { color: "334155", width: 1 } });
      s.addShape(pptx.ShapeType.line, { x: x + 0.24, y: 3.52, w: 1.55, h: 0, line: { color: "334155", width: 1 } });
      s.addShape(pptx.ShapeType.rect, { x: x + 0.26, y: 3.86, w: 1.9, h: 0.5, fill: { color: i === 2 ? C.red : C.cyan, transparency: 82 }, line: { color: i === 2 ? C.red : C.cyan, transparency: 8 } });
    }
    addText(s, n, sub, x + 0.18, 4.45, 2.1, 0.34, { size: 10.5, color: C.slate, bg: "0B1324" });
  });
  addText(s, n, "The demo frame is intentionally editable: replace panels with live screenshots after the workflow is stable.", 0.94, 5.96, 8.8, 0.24, { size: 10, color: C.slate, fontFace: fontMono });
  addNotes(s, [
    "Demo 只讲一条链，不展示所有功能。10 分钟技术分享里，最容易失控的是开放式功能漫游。",
    "建议现场按 Ask、Extract、Confirm、Render、Export 五步走，每一步都有明确反馈，像体力劳动一样可推进。",
  ]);
}

function slide11(assets) {
  const n = 11;
  const s = pptx.addSlide();
  bg(s, n, assets, "cover");
  header(s, n, "Toward Controllable AI-Assisted Geospatial Workflows", "The goal is not to replace geospatial experts, but to make AI-assisted flood analysis explicit, controllable, and reproducible.", assets);
  s.addShape(pptx.ShapeType.rect, { x: 0.75, y: 2.1, w: 7.35, h: 2.42, fill: { color: C.navy2, transparency: 4 }, line: { color: "263A50", width: 0.8 } });
  addText(s, n, "The goal is not to replace geospatial experts,\nbut to make AI-assisted flood analysis more explicit,\ncontrollable, and reproducible.", 0.98, 2.36, 6.75, 1.72, { size: 24.5, color: C.gray, fontFace: fontHead, bg: C.navy2 });
  ["explicit", "controllable", "reproducible"].forEach((v, i) => chip(s, n, v, 0.98 + i * 1.62, 4.62, 1.34, i === 1 ? C.red : C.green2));
  node(s, n, "language -> parameters -> execution -> evidence", 8.35, 3.02, 3.35, 0.72, { accent: C.cyan, fill: C.navy2, size: 11.5, fontFace: fontMono });
  addNotes(s, [
    "结尾回到定位：不是替代 GIS 专家，而是让 AI 辅助分析更显性、更可控、更可复现。",
    "这也给后续工作留下接口：更强的数据注册表、更细的权限控制、更完整的证据链审计。",
  ]);
}

function previewSvg(slideNo, title, subtitle, kind) {
  const accent = kind === "red" ? "#EF4444" : kind === "green" ? "#22C55E" : "#18A0FB";
  const box = (x, y, w, h, label, color = accent) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#101827" stroke="${color}" stroke-width="3"/><text x="${x + w / 2}" y="${y + h / 2 + 10}" text-anchor="middle" fill="#E5E7EB" font-family="Aptos, Arial" font-size="24">${escXml(label)}</text>`;
  const arr = (x1, y1, x2, y2, color = accent) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="5" marker-end="url(#arrow)"/>`;
  const map = (x, y, w, h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#07111F" stroke="#18A0FB" stroke-width="4"/>
    <path d="M${x + 25} ${y + h * .72} C${x + w * .22} ${y + h * .5} ${x + w * .38} ${y + h * .78} ${x + w * .55} ${y + h * .48} S${x + w * .78} ${y + h * .22} ${x + w - 20} ${y + h * .42}" fill="none" stroke="#18A0FB" stroke-opacity=".55" stroke-width="26"/>
    <path d="M${x + w * .32} ${y + h * .45} C${x + w * .48} ${y + h * .36} ${x + w * .62} ${y + h * .48} ${x + w * .76} ${y + h * .58} ${x + w * .63} ${y + h * .76} ${x + w * .42} ${y + h * .72} ${x + w * .28} ${y + h * .62}Z" fill="#EF4444" opacity=".55"/>`;
  let extra = "";
  if (slideNo === 1) {
    extra = `${map(930, 250, 760, 420)}<text x="90" y="620" fill="#67E8F9" font-family="Cascadia Mono, monospace" font-size="28">controllable / reviewable / executable</text>`;
  } else if (slideNo === 2) {
    extra = `${box(190, 455, 250, 86, "AI proposes", "#18A0FB")}${box(690, 285, 280, 86, "Human reviews", "#EF4444")}${box(1180, 455, 300, 86, "System executes", "#22C55E")}${box(680, 725, 330, 86, "Results feed back", "#F59E0B")}${arr(440, 498, 690, 330, "#18A0FB")}${arr(970, 330, 1180, 498, "#EF4444")}${arr(1330, 545, 980, 725, "#22C55E")}${arr(680, 760, 320, 545, "#F59E0B")}<circle cx="835" cy="520" r="112" fill="none" stroke="#22C55E" stroke-width="5"/><text x="835" y="530" text-anchor="middle" fill="#E5E7EB" font-family="Aptos Display, Arial" font-size="34">decision boundary</text>`;
  } else if (slideNo === 3) {
    extra = `${box(750, 500, 310, 110, "Flood request", "#EF4444")}${box(190, 330, 250, 80, "event", "#EF4444")}${box(760, 275, 250, 80, "dates", "#F59E0B")}${box(1290, 330, 270, 80, "spatial scope", "#18A0FB")}${box(300, 735, 250, 80, "datasets", "#22C55E")}${box(1190, 735, 260, 80, "workflow", "#94A3B8")}${arr(440, 370, 750, 535, "#EF4444")}${arr(885, 355, 900, 500, "#F59E0B")}${arr(1290, 370, 1060, 535, "#18A0FB")}${arr(550, 760, 800, 610, "#22C55E")}${arr(1190, 760, 1010, 610, "#94A3B8")}`;
  } else if (slideNo === 4) {
    const xs = [160, 470, 780, 1130, 1460];
    const labs = ["Request", "LLM assumptions", "Review checkpoint", "GEE execution", "Map evidence"];
    extra = labs.map((l, i) => box(xs[i], 500, i === 2 ? 290 : 245, 90, l, i === 2 ? "#EF4444" : "#18A0FB")).join("") + xs.slice(0, 4).map((x, i) => arr(x + (i === 2 ? 290 : 245), 545, xs[i + 1], 545, i === 1 ? "#EF4444" : "#18A0FB")).join("");
  } else if (slideNo === 5) {
    const labs = ["intent", "chat", "extraction", "pre-confirm", "confirm", "processing"];
    extra = labs.map((l, i) => box(110 + i * 290, 520, 225, 72, l, i === 4 ? "#EF4444" : "#22C55E")).join("") + labs.slice(0, 5).map((_, i) => arr(335 + i * 290, 556, 400 + i * 290, 556, i === 3 ? "#EF4444" : "#22C55E")).join("") + `<text x="1260" y="760" fill="#67E8F9" font-family="Cascadia Mono, monospace" font-size="34">StateGraph + interrupt</text>`;
  } else if (slideNo === 6) {
    extra = `${box(170, 435, 330, 110, "confirmation_node interrupt()", "#EF4444")}${arr(500, 490, 680, 490, "#EF4444")}<rect x="680" y="310" width="780" height="430" fill="#101827" stroke="#18A0FB" stroke-width="4"/><text x="730" y="365" fill="#E5E7EB" font-family="Aptos Display, Arial" font-size="34">Review surface</text>${["Event name","Description","Location","Dates","Resolved AOI","Layers"].map((l,i)=>box(730+(i%2)*330,410+Math.floor(i/2)*95,270,58,l,i>=4?"#EF4444":"#18A0FB")).join("")}`;
  } else if (slideNo === 7) {
    extra = `${box(160, 360, 340, 90, "spatial scope", "#18A0FB")}${map(175, 500, 300, 165)}${box(710, 360, 340, 90, "temporal window", "#F59E0B")}<line x1="760" y1="585" x2="1015" y2="585" stroke="#F59E0B" stroke-width="6"/><circle cx="760" cy="585" r="16" fill="#F59E0B"/><circle cx="895" cy="585" r="20" fill="#EF4444"/><circle cx="1015" cy="585" r="16" fill="#F59E0B"/>${box(1250, 360, 350, 90, "dataset selection", "#22C55E")}${["DSWX","GFD","JRC"].map((l,i)=>box(1290,505+i*70,250,50,l,"#22C55E")).join("")}`;
  } else if (slideNo === 8) {
    const labs = ["registry", "recommended layers", "render_layer()", "GEE tile URL"];
    const xs = [230, 575, 960, 1315];
    extra = labs.map((l, i) => box(xs[i], 500, i === 1 ? 300 : 250, 80, l, ["#22C55E", "#18A0FB", "#F59E0B", "#EF4444"][i])).join("") + xs.slice(0, 3).map((x, i) => arr(x + (i === 1 ? 300 : 250), 540, xs[i + 1], 540, "#18A0FB")).join("") + `<text x="250" y="705" fill="#67E8F9" font-family="Cascadia Mono, monospace" font-size="26">asset_id / selection_profile / render_profile / legend_spec / execution_profile</text>`;
  } else if (slideNo === 9) {
    extra = `${["confirmed event","AOI","layers","GEE","tile URLs","map"].map((l,i)=>box(110+i*270,360,210,62,l,i>=3?"#EF4444":"#18A0FB")).join("")}${[0,1,2,3,4].map(i=>arr(320+i*270,392,380+i*270,392,i>=2?"#EF4444":"#18A0FB")).join("")}${map(640,520,620,300)}`;
  } else if (slideNo === 10) {
    extra = `${["Ask","Extract","Confirm","Render"].map((l,i)=>`<rect x="${150+i*410}" y="340" width="320" height="360" fill="#101827" stroke="${i===2?"#EF4444":"#18A0FB"}" stroke-width="4"/><text x="${185+i*410}" y="410" fill="${i===2?"#EF4444":"#18A0FB"}" font-family="Cascadia Mono" font-size="30">0${i+1}</text><text x="${185+i*410}" y="500" fill="#E5E7EB" font-family="Aptos Display" font-size="42">${l}</text><line x1="${185+i*410}" y1="565" x2="${420+i*410}" y2="565" stroke="#334155" stroke-width="4"/>`).join("")}${map(1410,565,220,110)}`;
  } else if (slideNo === 11) {
    extra = `<rect x="130" y="360" width="940" height="280" fill="#07111F" opacity=".92" stroke="#263A50" stroke-width="3"/><text x="170" y="445" fill="#E5E7EB" font-family="Aptos Display, Arial" font-size="46">AI should not replace geospatial experts.</text><text x="170" y="520" fill="#E5E7EB" font-family="Aptos Display, Arial" font-size="38">It should make analysis explicit, controllable, reproducible.</text>${box(1220, 470, 480, 90, "language -> parameters -> execution -> evidence", "#18A0FB")}`;
  }
  return `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="${accent}"/></marker>
    <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency=".7" numOctaves="2" seed="${slideNo}"/><feColorMatrix type="saturate" values=".18"/><feBlend mode="screen" in2="SourceGraphic"/></filter>
    <linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#07111F"/><stop offset="1" stop-color="#0B2135"/></linearGradient>
  </defs>
  <rect width="1920" height="1080" fill="url(#g)"/>
  <g filter="url(#grain)" opacity=".28"><ellipse cx="1180" cy="620" rx="620" ry="270" fill="#1f3d2d"/><ellipse cx="1450" cy="320" rx="440" ry="210" fill="#263A50"/></g>
  <rect x="0" y="0" width="22" height="1080" fill="#0B7A53"/><rect x="22" y="0" width="6" height="1080" fill="#18A0FB"/>
  <line x1="90" y1="165" x2="330" y2="165" stroke="#22C55E" stroke-width="6"/>
  <text x="90" y="108" fill="#67E8F9" font-family="Cascadia Mono, monospace" font-size="25">${String(slideNo).padStart(2, "0")}</text>
  <text x="90" y="250" fill="#E5E7EB" font-family="Aptos Display, Arial" font-size="56" font-weight="500">${escXml(title)}</text>
  <text x="90" y="322" fill="#94A3B8" font-family="Aptos, Arial" font-size="28">${escXml(subtitle)}</text>
  <path d="M860 770 C1040 640 1210 820 1400 690 S1700 600 1920 720 L1920 1080 L860 1080Z" fill="#102238" opacity=".95"/>
  ${extra}
  <text x="1705" y="970" text-anchor="end" fill="#E5E7EB" font-family="Cascadia Mono, monospace" font-size="22">NNU / SatGPT Pro</text>
  </svg>`;
}

async function renderPreviews() {
  const slides = [
    ["Human-in-the-Loop Geospatial Agent Design", "for SatGPT Pro Flood Analysis", "green"],
    ["Human-in-the-Loop Is a Control Loop", "AI proposes -> Human reviews -> System executes -> Results feed back", "red"],
    ["Flood Mapping Is Not Just Text Generation", "event / dates / spatial scope / datasets / workflow", "red"],
    ["How Can SatGPT Pro Implement HITL?", "language -> assumptions -> review checkpoint -> Earth Engine -> evidence", "cyan"],
    ["From Conversation to Stateful Workflow", "LangGraph nodes and state transitions", "green"],
    ["The Review Checkpoint Exposes AI Assumptions", "hidden guesses become editable parameters", "red"],
    ["Reviewing Where and What to Compute", "spatial scope / temporal window / dataset selection", "green"],
    ["Dataset Registry Constrains LLM Output", "asset_id / render_profile / legend_spec / execution_profile", "cyan"],
    ["Controlled Execution Produces Map Evidence", "confirmed parameters drive inspectable spatial outputs", "red"],
    ["Demo: One HITL-Controlled Flood Analysis Flow", "ask -> extract -> confirm -> render -> export", "cyan"],
    ["Toward Controllable AI-Assisted Geospatial Workflows", "explicit / controllable / reproducible", "green"],
  ];
  const pngs = [];
  for (let i = 0; i < slides.length; i++) {
    const out = path.join(PREVIEW, `slide_${String(i + 1).padStart(2, "0")}.png`);
    await sharp(Buffer.from(previewSvg(i + 1, slides[i][0], slides[i][1], slides[i][2]))).png().toFile(out);
    pngs.push(out);
  }
  const thumbs = await Promise.all(pngs.map(p => sharp(p).resize(480, 270).toBuffer()));
  const cols = 4;
  const rows = 3;
  const tw = 480;
  const th = 270;
  const gap = 22;
  await sharp({
    create: {
      width: cols * tw + (cols + 1) * gap,
      height: rows * th + (rows + 1) * gap,
      channels: 4,
      background: "#07111F",
    },
  }).composite(thumbs.map((input, i) => ({
    input,
    left: gap + (i % cols) * (tw + gap),
    top: gap + Math.floor(i / cols) * (th + gap),
  }))).png().toFile(path.join(PREVIEW, "contact_sheet.png"));
}

function geometryQa() {
  for (const item of tracked) {
    if (item.x < -0.01 || item.y < -0.01 || item.x + item.w > W + 0.01 || item.y + item.h > H + 0.01) {
      qa.checks.bounds.push(item);
    }
  }
  const bySlide = new Map();
  for (const item of tracked.filter(t => t.kind === "text")) {
    if (!bySlide.has(item.slideNo)) bySlide.set(item.slideNo, []);
    bySlide.get(item.slideNo).push(item);
  }
  for (const [slideNo, items] of bySlide) {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        const overlapX = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
        const overlapY = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
        const area = overlapX * overlapY;
        if (area > 0.05) qa.checks.textBoxGeometry.push({ slide: slideNo, a: a.text.slice(0, 32), b: b.text.slice(0, 32), area: Number(area.toFixed(3)) });
      }
    }
  }
}

async function openXmlQa() {
  const zip = await JSZip.loadAsync(fs.readFileSync(PPTX_PATH));
  const names = Object.keys(zip.files);
  const slideEntries = names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const notesEntries = names.filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  qa.slideCount = slideEntries.length;
  qa.notesCount = notesEntries.length;
  for (const name of slideEntries) {
    const xml = await zip.files[name].async("string");
    const id = Number(name.match(/slide(\d+)\.xml/)[1]);
    const re = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(-?\d+)" cy="(-?\d+)"/g;
    let m;
    while ((m = re.exec(xml))) {
      const x = Number(m[1]) / EMU_PER_IN;
      const y = Number(m[2]) / EMU_PER_IN;
      const w = Number(m[3]) / EMU_PER_IN;
      const h = Number(m[4]) / EMU_PER_IN;
      if (x < -0.02 || y < -0.02 || x + w > W + 0.02 || y + h > H + 0.02) {
        qa.checks.bounds.push({ slide: id, x, y, w, h, reason: "OpenXML object outside slide bounds" });
      }
    }
  }
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  ensureCleanDir(PREVIEW);
  ensureCleanDir(ASSETS);
  const assets = await generateAssets();
  initDeck();

  slide01(assets);
  slide02(assets);
  slide03(assets);
  slide04(assets);
  slide05(assets);
  slide06(assets);
  slide07(assets);
  slide08(assets);
  slide09(assets);
  slide10(assets);
  slide11(assets);

  await pptx.writeFile({ fileName: PPTX_PATH });
  await renderPreviews();
  geometryQa();
  await openXmlQa();

  const issueCount = Object.values(qa.checks).reduce((sum, list) => sum + list.length, 0);
  qa.verdict = issueCount === 0 && qa.slideCount === 11 && qa.notesCount === 11 ? "PASS" : "REVIEW";
  fs.writeFileSync(QA_PATH, JSON.stringify(qa, null, 2), "utf8");
  console.log(JSON.stringify({
    pptxPath: PPTX_PATH,
    previewPath: PREVIEW,
    contactSheetPath: qa.contactSheetPath,
    qaPath: QA_PATH,
    verdict: qa.verdict,
    slideCount: qa.slideCount,
    notesCount: qa.notesCount,
    issueCount,
  }, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
