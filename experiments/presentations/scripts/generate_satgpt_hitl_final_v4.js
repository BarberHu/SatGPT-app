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
const ASSETS = path.join(OUT, "satgpt_hitl_final_v4_assets");
const PPTX = path.join(OUT, "SatGPT_HITL_Geospatial_Agent_Talk.pptx");
const QA = path.join(PREVIEW, "qa_report.json");

const W = 13.333;
const H = 7.5;
const C = {
  paper: "F6F7F2",
  paper2: "ECEFE7",
  ink: "0B1220",
  text: "132033",
  muted: "64748B",
  hair: "C9D3C6",
  green: "0B7A53",
  blue: "18A0FB",
  red: "EF4444",
  amber: "F59E0B",
  white: "FFFFFF",
  dark: "07111F",
};
const FH = "Aptos Display";
const FB = "Aptos";
const FM = "Cascadia Mono";

let pptx;
let no = 0;
const obj = [];

const NOTES = [
  ["\u8bb2\u6cd5\uff1a\u5f00\u573a\u4e0d\u4ecb\u7ecd SatGPT \u5e73\u53f0\uff0c\u53ea\u5efa\u7acb\u4e00\u4e2a\u547d\u9898\uff1a\u6d2a\u6c34\u5236\u56fe\u4e2d\u7684 AI \u5fc5\u987b\u53ef\u63a7\u3001\u53ef\u5ba1\u67e5\u3001\u53ef\u6267\u884c\u3002"],
  ["\u8bb2\u6cd5\uff1aHITL \u662f\u63a7\u5236\u95ed\u73af\uff0c\u4e0d\u662f\u786e\u8ba4\u6309\u94ae\u3002AI \u63d0\u8bae\uff0c\u4eba\u5ba1\u67e5\uff0c\u7cfb\u7edf\u6267\u884c\uff0c\u7ed3\u679c\u518d\u56de\u5230\u4eba\u7684\u5224\u65ad\u91cc\u3002"],
  ["\u8bb2\u6cd5\uff1a\u6d2a\u6c34\u5236\u56fe\u8bf7\u6c42\u80cc\u540e\u6709\u4e94\u7c7b\u9690\u542b\u5047\u8bbe\uff1a\u4e8b\u4ef6\u3001\u65f6\u95f4\u3001\u7a7a\u95f4\u8303\u56f4\u3001\u6570\u636e\u96c6\u548c\u6267\u884c\u6d41\u7a0b\u3002"],
  ["\u8bb2\u6cd5\uff1aSatGPT Pro \u7684\u8bbe\u8ba1\u95ee\u9898\u662f\u5728 LLM assumptions \u548c Earth Engine execution \u4e4b\u95f4\u653e\u4e00\u4e2a human review checkpoint\u3002"],
  ["\u8bb2\u6cd5\uff1aflood_agent.py \u91cc\u7684 StateGraph \u628a\u5bf9\u8bdd\u7ec4\u7ec7\u6210\u72b6\u6001\u673a\uff0cconfirmation_node \u662f\u4eba\u673a\u534f\u540c\u7684\u95f8\u95e8\u3002"],
  ["\u8bb2\u6cd5\uff1aconfirmation_node \u548c EventConfirmation.js \u628a AI \u7684\u9690\u542b\u5224\u65ad\u66b4\u9732\u6210\u53ef\u7f16\u8f91\u7684 event\u3001location\u3001dates\u3001AOI\u3001layers\u3002"],
  ["\u8bb2\u6cd5\uff1aHITL \u4e0d\u53ea\u662f AOI\uff0c\u800c\u662f\u540c\u65f6\u63a7\u5236 where\u3001when\u3001what to compute\u3002"],
  ["\u8bb2\u6cd5\uff1aregistry \u662f\u8bed\u8a00\u548c\u6267\u884c\u7684\u5408\u540c\uff0c\u5b83\u8ba9 LLM \u8f93\u51fa\u843d\u5230\u771f\u6b63\u53ef\u6267\u884c\u7684 asset\u3001render\u3001legend \u548c execution profile\u3002"],
  ["\u8bb2\u6cd5\uff1agee_service.py \u4ea7\u751f tile_url\uff0cAgentPanel.js \u628a tile_url \u53d8\u6210\u5730\u56fe\u8bc1\u636e\u3002\u6700\u7ec8\u4ea7\u7269\u4e0d\u662f\u6587\u672c\uff0c\u800c\u662f\u53ef\u68c0\u67e5\u7684\u7a7a\u95f4\u8bc1\u636e\u3002"],
  ["\u8bb2\u6cd5\uff1aDemo \u53ea\u8d70\u4e00\u6761\u94fe\uff1aAsk\u3001Extract\u3001Confirm\u3001Render\u3001Export\u3002\u4e0d\u505a\u529f\u80fd\u6f2b\u6e38\u3002"],
  ["\u8bb2\u6cd5\uff1a\u6536\u675f\u5230\u4e00\u53e5\u8bdd\uff1aAI \u4e0d\u66ff\u4ee3 GIS \u4e13\u5bb6\uff0c\u800c\u662f\u8ba9\u6d2a\u6c34\u5206\u6790\u66f4\u663e\u6027\u3001\u53ef\u63a7\u3001\u53ef\u590d\u73b0\u3002"],
];

function clean(d) { fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true }); }
function add() { no += 1; return pptx.addSlide(); }
function rec(kind, x, y, w, h, text = "") { obj.push({ slide: no, kind, x, y, w, h, text }); }
function text(s, v, x, y, w, h, o = {}) {
  s.addText(v, { x, y, w, h, margin: o.margin ?? 0.01, fit: "shrink", fontFace: o.fontFace || FB, fontSize: o.size || 14, color: o.color || C.text, bold: !!o.bold, italic: !!o.italic, align: o.align || "left", valign: o.valign || "mid", breakLine: false, paraSpaceAfterPt: 0 });
  rec("text", x, y, w, h, v);
}
function shape(s, x, y, w, h, fill, line = null, radius = false, tr = 0) {
  s.addShape(radius ? pptx.ShapeType.roundRect : pptx.ShapeType.rect, { x, y, w, h, rectRadius: 0.03, fill: { color: fill, transparency: tr }, line: line ? { color: line, width: 1 } : { transparency: 100 } });
  rec("shape", x, y, w, h);
}
function ln(s, x1, y1, x2, y2, color = C.hair, w = 1, arrow = false) {
  s.addShape(pptx.ShapeType.line, { x: x1, y: y1, w: x2 - x1, h: y2 - y1, line: { color, width: w, endArrowType: arrow ? "triangle" : undefined } });
}
function header(s, title, sub, a, dark = false) {
  text(s, title, 0.64, 0.48, 8.7, 0.42, { size: 22, fontFace: FH, color: dark ? C.white : C.ink, bold: true });
  text(s, sub || "", 0.66, 0.98, 8.2, 0.2, { size: 7.5, fontFace: FM, color: dark ? "A9B8C6" : C.muted });
  ln(s, 0.64, 1.28, 2.1, 1.28, dark ? C.blue : C.green, 2);
  footer(s, a, dark);
}
function footer(s, a, dark = false) {
  ln(s, 0.64, 7.0, 12.0, 7.0, dark ? "263A50" : C.hair, 0.8);
  text(s, "NNU GIS · SatGPT Pro", 0.66, 7.12, 2.4, 0.14, { size: 6.8, fontFace: FM, color: dark ? "9FB0C2" : C.muted });
  text(s, String(no).padStart(2, "0"), 12.16, 7.12, 0.32, 0.14, { size: 6.8, fontFace: FM, color: dark ? "9FB0C2" : C.muted, align: "right" });
  if (a.logo) s.addImage({ path: a.logo, x: 10.18, y: 6.78, w: 1.8, h: 0.3, transparency: dark ? 12 : 0 });
}
function bg(s, dark = false) { s.background = { color: dark ? C.dark : C.paper }; shape(s, 0, 0, W, H, dark ? C.dark : C.paper); }
function node(s, v, x, y, w, h, color, fill = C.white, tc = C.ink) {
  shape(s, x, y, w, h, fill, color, true);
  text(s, v, x + 0.08, y + 0.04, w - 0.16, h - 0.08, { size: 9, fontFace: FB, color: tc, bold: true, align: "center" });
}
function mono(s, v, x, y, w, h, color = C.green) { text(s, v, x, y, w, h, { size: 7.6, fontFace: FM, color, bold: true }); }

async function makeAssets() {
  clean(ASSETS); clean(PREVIEW); fs.mkdirSync(OUT, { recursive: true });
  const srcA = path.join(ROOT, "satgpt-agent-panel-mode-toggle.png");
  const srcB = path.join(ROOT, "satgpt-panel-compact-toggle.png");
  const logoSrc = path.join(OUT, "nsnu_template_assets", "image2.png");
  const logo = path.join(ASSETS, "logo.png");
  const mapWide = path.join(ASSETS, "map-wide.png");
  const mapDark = path.join(ASSETS, "map-dark.png");
  const uiRight = path.join(ASSETS, "ui-right.png");
  const uiLeft = path.join(ASSETS, "ui-left.png");
  if (fs.existsSync(logoSrc)) await sharp(logoSrc).trim({ background: "#ffffff" }).resize({ width: 900 }).png().toFile(logo);
  await sharp(srcB).resize(1920, 1080, { fit: "cover" }).modulate({ brightness: 1.02, saturation: 0.9 }).png().toFile(mapWide);
  await sharp(srcB).resize(1920, 1080, { fit: "cover" }).modulate({ brightness: 0.48, saturation: 0.55 }).composite([{ input: Buffer.from(`<svg width="1920" height="1080"><rect width="1920" height="1080" fill="#07111F" opacity=".38"/></svg>`), left: 0, top: 0 }]).png().toFile(mapDark);
  await sharp(srcA).extract({ left: 845, top: 12, width: 420, height: 875 }).resize(520, 1080, { fit: "contain", background: "#F6F7F2" }).png().toFile(uiRight);
  await sharp(srcA).extract({ left: 0, top: 5, width: 350, height: 890 }).resize(500, 1080, { fit: "contain", background: "#F6F7F2" }).png().toFile(uiLeft);
  return { logo: fs.existsSync(logo) ? logo : null, mapWide, mapDark, uiRight, uiLeft };
}

function slide1(a) {
  const s = add(); s.addImage({ path: a.mapDark, x: 0, y: 0, w: W, h: H }); shape(s, 0, 0, 5.05, H, C.paper); ln(s, 5.05, 0, 5.05, H, C.green, 2.4);
  text(s, "Human-in-the-Loop\nGeospatial Agent\nDesign", 0.72, 1.06, 4.0, 1.52, { size: 29, fontFace: FH, color: C.ink, bold: true });
  text(s, "for SatGPT Pro Flood Analysis", 0.74, 2.8, 3.7, 0.28, { size: 15.5, fontFace: FH, color: C.green, bold: true });
  text(s, "Making AI-assisted flood mapping controllable,\nreviewable, and executable", 0.76, 3.45, 3.9, 0.48, { size: 12, color: C.muted });
  mono(s, "10 MIN TECHNICAL TALK", 0.76, 5.28, 1.7, 0.18); mono(s, "MAP EVIDENCE", 2.72, 5.28, 1.2, 0.18, C.red);
  footer(s, a); s.addNotes(NOTES[0]);
}
function slide2(a) {
  const s = add(); bg(s); header(s, "Human-in-the-Loop Is a Control Loop", "AI proposes -> Human reviews -> System executes -> Results feed back", a);
  node(s, "AI proposes", 1.18, 3.08, 1.7, 0.46, C.blue); node(s, "Human reviews", 5.45, 1.92, 2.0, 0.46, C.red); node(s, "System executes", 10.25, 3.08, 2.0, 0.46, C.green); node(s, "Results feed back", 5.22, 5.62, 2.42, 0.46, C.amber);
  ln(s, 2.88, 3.31, 5.45, 2.15, C.blue, 1.4, true); ln(s, 7.45, 2.15, 10.25, 3.31, C.red, 1.4, true); ln(s, 10.85, 3.55, 7.25, 5.62, C.green, 1.4, true); ln(s, 5.22, 5.84, 2.46, 3.55, C.amber, 1.4, true);
  text(s, "decision\nboundary", 5.45, 3.42, 1.95, 0.62, { size: 22, fontFace: FH, bold: true, align: "center" });
  text(s, "HITL is a feedback control system for assumptions with spatial consequences.", 0.92, 6.35, 7.7, 0.36, { size: 17, fontFace: FH, bold: true }); s.addNotes(NOTES[1]);
}
function slide3(a) {
  const s = add(); bg(s); header(s, "Flood Mapping Is Not Just Text Generation", "A flood request hides event, dates, spatial scope, datasets, and execution workflow.", a);
  text(s, "A single request\ncontains five hidden\ndecisions.", 0.86, 2.05, 4.75, 1.15, { size: 30, fontFace: FH, bold: true });
  text(s, "If one assumption is wrong, the map can look precise while being conceptually wrong.", 0.9, 3.62, 4.4, 0.46, { size: 13.5, color: C.muted });
  [["event", C.red], ["dates", C.amber], ["spatial scope", C.blue], ["datasets", C.green], ["execution workflow", C.ink]].forEach(([v, c], i) => { const y = 2.0 + i * 0.72; ln(s, 7.0, y + 0.18, 8.42, y + 0.18, c, 3); text(s, v, 8.72, y, 2.7, 0.32, { size: 18, fontFace: FH, color: c, bold: true }); });
  shape(s, 6.58, 5.65, 4.85, 0.52, C.paper2); text(s, "\"Map the flood impact.\"", 6.82, 5.78, 3.1, 0.18, { size: 14, fontFace: FM }); s.addNotes(NOTES[2]);
}
function slide4(a) {
  const s = add(); bg(s); header(s, "How Can SatGPT Pro Implement HITL?", "Language -> assumptions -> review checkpoint -> Earth Engine -> map evidence", a);
  const xs = [0.78, 3.05, 5.18, 7.85, 10.2], labs = ["Natural-language\nrequest", "LLM\nassumptions", "Human review\ncheckpoint", "Earth Engine\nexecution", "Map\nevidence"];
  labs.forEach((v, i) => node(s, v, xs[i], 3.15, i === 2 ? 2.0 : 1.55, 0.65, i === 2 ? C.red : C.ink));
  for (let i = 0; i < 4; i++) ln(s, xs[i] + (i === 2 ? 2.0 : 1.55), 3.48, xs[i + 1] - 0.06, 3.48, i === 1 ? C.red : C.ink, 1.2, true);
  text(s, "The checkpoint converts uncertain language into confirmed geospatial parameters.", 0.9, 5.24, 7.2, 0.4, { size: 20, fontFace: FH, bold: true }); s.addNotes(NOTES[3]);
}
function slide5(a) {
  const s = add(); bg(s); header(s, "From Conversation to Stateful Workflow", "LangGraph turns one chat into typed workflow responsibilities.", a);
  ["intent", "chat", "extraction", "pre-confirm", "confirmation", "processing"].forEach((v, i) => { const x = 0.78 + i * 2.02; mono(s, String(i + 1).padStart(2, "0"), x, 2.45, 0.32, 0.14, i === 4 ? C.red : C.green); node(s, v, x, 2.86, 1.48, 0.46, i === 4 ? C.red : C.green); if (i < 5) ln(s, x + 1.48, 3.09, x + 1.92, 3.09, i === 3 ? C.red : C.green, 1.1, true); });
  text(s, "State is the design tool: each node narrows what the next node is allowed to decide.", 0.9, 4.78, 5.7, 0.48, { size: 18, fontFace: FH, bold: true });
  text(s, "Code evidence: agent/flood_agent.py", 7.65, 5.1, 3.2, 0.16, { size: 7.5, fontFace: FM, color: C.muted }); s.addNotes(NOTES[4]);
}
function slide6(a) {
  const s = add(); bg(s); header(s, "The Review Checkpoint Exposes AI Assumptions", "Hidden guesses become editable parameters.", a);
  shape(s, 0.92, 2.0, 4.0, 4.18, C.white, C.hair, true); text(s, "Review surface", 1.2, 2.3, 2.2, 0.28, { size: 19, fontFace: FH, bold: true });
  ["Event name", "Description", "Location", "Pre / peak / post dates", "Resolved AOI", "Recommended layers"].forEach((v, i) => { const y = 2.93 + i * 0.44; ln(s, 1.25, y + 0.13, 1.58, y + 0.13, i >= 4 ? C.red : C.blue, 2); text(s, v, 1.78, y, 2.5, 0.24, { size: 12.2 }); });
  text(s, "Experts review\nvariables,\nnot prose.", 5.45, 3.08, 2.2, 1.1, { size: 24, fontFace: FH, color: C.red, bold: true });
  s.addImage({ path: a.uiRight, x: 8.3, y: 1.55, w: 2.38, h: 4.85 }); text(s, "Code evidence: confirmation_node / EventConfirmation.js", 5.45, 4.62, 3.1, 0.16, { size: 7.3, fontFace: FM, color: C.muted }); s.addNotes(NOTES[5]);
}
function slide7(a) {
  const s = add(); bg(s); header(s, "Reviewing Where and What to Compute", "HITL reviews spatial scope, temporal window, and dataset/layer selection.", a);
  s.addImage({ path: a.mapWide, x: 0.86, y: 2.0, w: 3.8, h: 2.15 }); text(s, "spatial scope", 0.9, 4.55, 2.0, 0.3, { size: 18, fontFace: FH, color: C.blue, bold: true });
  ln(s, 5.55, 3.12, 8.05, 3.12, C.amber, 3); [5.55, 6.8, 8.05].forEach((x, i) => shape(s, x - 0.06, 3.06, 0.12, 0.12, i === 1 ? C.red : C.amber, null, true)); text(s, "temporal window", 5.38, 4.55, 2.25, 0.3, { size: 18, fontFace: FH, color: C.amber, bold: true });
  ["DSWX", "Global Flood DB", "JRC Water", "HydroSHEDS"].forEach((v, i) => node(s, v, 9.1, 2.18 + i * 0.52, 2.3, 0.32, C.green)); text(s, "dataset selection", 9.05, 4.55, 2.4, 0.3, { size: 18, fontFace: FH, color: C.green, bold: true });
  text(s, "HITL controls where, when, and what to compute.", 0.92, 5.85, 6.8, 0.36, { size: 21, fontFace: FH, bold: true }); s.addNotes(NOTES[6]);
}
function slide8(a) {
  const s = add(); bg(s); header(s, "Dataset Registry Constrains LLM Output to Executable Assets", "The registry is the execution contract between language and GEE.", a);
  [["asset_id", "which Earth Engine asset can be called"], ["selection_profile", "when it should be recommended"], ["render_profile", "how the layer should be visualized"], ["legend_spec", "how users read the map"], ["execution_profile", "how GEE should execute it"]].forEach(([k, v], i) => { const y = 1.9 + i * 0.72; ln(s, 0.95, y + 0.34, 11.5, y + 0.34, C.hair, 0.8); text(s, k, 1.05, y, 2.8, 0.32, { size: 16, fontFace: FM, color: i === 4 ? C.red : C.green, bold: true }); text(s, v, 4.35, y, 5.8, 0.32, { size: 14.5 }); });
  text(s, "This prevents the model from merely saying \"use Sentinel-1\".", 1.05, 6.02, 6.2, 0.35, { size: 20, fontFace: FH, bold: true }); text(s, "Code evidence: flood_dataset_service.py / flood_dataset_registry.json", 7.2, 6.18, 4.5, 0.16, { size: 7.3, fontFace: FM, color: C.muted, align: "right" }); s.addNotes(NOTES[7]);
}
function slide9(a) {
  const s = add(); bg(s, true); s.addImage({ path: a.mapDark, x: 0, y: 0, w: W, h: H }); shape(s, 0, 0, W, H, C.dark, null, false, 12); header(s, "Controlled Execution Produces Map Evidence", "confirmed event + AOI + selected layers -> GEE processing -> tile URLs -> visualization", a, true);
  shape(s, 0.85, 1.78, 6.0, 3.25, C.dark, C.blue, false, 20); s.addImage({ path: a.mapWide, x: 0.95, y: 1.88, w: 5.8, h: 3.05 });
  ["confirmed\nparameters", "GEE\nprocessing", "tile URLs", "map\nevidence", "report /\nGEE code"].forEach((v, i) => node(s, v, 8.15, 1.95 + i * 0.62, 1.7, 0.44, i < 2 ? C.blue : C.red, C.dark, C.white));
  text(s, "Map evidence is the artifact experts can inspect.", 0.95, 5.62, 6.6, 0.38, { size: 23, fontFace: FH, color: C.white, bold: true }); text(s, "Code evidence: gee_service.py / AgentPanel.js", 8.15, 5.34, 3.35, 0.16, { size: 7.5, fontFace: FM, color: "A9B8C6" }); s.addNotes(NOTES[8]);
}
function slide10(a) {
  const s = add(); bg(s); header(s, "Demo: One HITL-Controlled Flood Analysis Flow", "Ask -> extract -> confirm -> render -> export", a);
  ["Ask", "Extract", "Confirm", "Render", "Export"].forEach((v, i) => { const x = 0.9 + i * 2.3; mono(s, `0${i + 1}`, x, 2.34, 0.35, 0.14, i === 2 ? C.red : C.green); text(s, v, x, 2.72, 1.3, 0.3, { size: 22, fontFace: FH, bold: true }); ln(s, x, 3.24, x + 1.55, 3.24, i === 2 ? C.red : C.green, 2); if (i < 4) ln(s, x + 1.6, 2.88, x + 2.08, 2.88, C.hair, 1, true); });
  s.addImage({ path: a.uiRight, x: 4.6, y: 4.05, w: 1.6, h: 1.7 }); s.addImage({ path: a.mapWide, x: 6.55, y: 4.05, w: 3.4, h: 1.9 });
  text(s, "Show the control chain, not a feature tour.", 0.95, 5.72, 4.0, 0.35, { size: 19, fontFace: FH, bold: true }); s.addNotes(NOTES[9]);
}
function slide11(a) {
  const s = add(); bg(s); header(s, "Toward Controllable AI-Assisted Geospatial Workflows", "The goal is faster expert work, not expert replacement.", a);
  text(s, "The goal is not to replace\ngeospatial experts.", 0.9, 1.95, 6.2, 0.82, { size: 33, fontFace: FH, bold: true });
  text(s, "It is to make AI-assisted flood analysis\nmore explicit, controllable, and reproducible.", 0.92, 3.38, 7.1, 0.72, { size: 23, fontFace: FH, color: C.green, bold: true });
  ["language", "parameters", "execution", "evidence"].forEach((v, i) => { node(s, v, 0.95 + i * 2.35, 5.22, 1.65, 0.42, i === 3 ? C.red : C.ink); if (i < 3) ln(s, 2.6 + i * 2.35, 5.43, 3.24 + i * 2.35, 5.43, C.hair, 1.1, true); }); s.addNotes(NOTES[10]);
}

async function previews() {
  const titles = ["Human-in-the-Loop Geospatial Agent Design","Human-in-the-Loop Is a Control Loop","Flood Mapping Is Not Just Text Generation","How Can SatGPT Pro Implement HITL?","From Conversation to Stateful Workflow","The Review Checkpoint Exposes AI Assumptions","Reviewing Where and What to Compute","Dataset Registry Constrains LLM Output","Controlled Execution Produces Map Evidence","Demo: One HITL-Controlled Flood Analysis Flow","Toward Controllable AI-Assisted Geospatial Workflows"];
  const subs = ["for SatGPT Pro Flood Analysis","AI proposes -> Human reviews -> System executes -> Results feed back","five hidden execution decisions","language -> checkpoint -> execution -> evidence","LangGraph as stateful workflow","editable parameters, not prose","where / when / what to compute","executable assets, not vague recommendations","GEE tile URLs and map visualization","ask -> extract -> confirm -> render -> export","explicit / controllable / reproducible"];
  const svg = (i) => {
    const dark = i === 0 || i === 8;
    const ink = dark ? "#FFFFFF" : "#0B1220";
    const muted = dark ? "#A9B8C6" : "#64748B";
    const box = (x,y,w,h,label,c="#0B7A53") => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${dark?"#102033":"#FFFFFF"}" stroke="${c}" stroke-width="3"/><text x="${x+w/2}" y="${y+h/2+8}" text-anchor="middle" fill="${ink}" font-family="Aptos,Arial" font-size="24" font-weight="700">${label}</text>`;
    const arr = (x1,y1,x2,y2,c="#0B1220") => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="5" marker-end="url(#a)"/>`;
    const map = (x,y,w,h) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#D9F0D2" stroke="#18A0FB" stroke-width="4"/><path d="M${x+25} ${y+h*.7} C${x+w*.23} ${y+h*.45} ${x+w*.42} ${y+h*.72} ${x+w*.6} ${y+h*.42} S${x+w*.8} ${y+h*.24} ${x+w-15} ${y+h*.4}" fill="none" stroke="#18A0FB" stroke-width="22" opacity=".6"/><path d="M${x+w*.36} ${y+h*.48} C${x+w*.52} ${y+h*.36} ${x+w*.66} ${y+h*.5} ${x+w*.78} ${y+h*.58} C${x+w*.63} ${y+h*.74} ${x+w*.44} ${y+h*.69} ${x+w*.3} ${y+h*.6}Z" fill="#EF4444" opacity=".62"/>`;
    let e = "";
    if (i===0) e = `<rect x="0" y="0" width="720" height="1080" fill="#F6F7F2"/><line x1="720" y1="0" x2="720" y2="1080" stroke="#0B7A53" stroke-width="7"/><text x="92" y="610" fill="#0B7A53" font-family="Cascadia Mono" font-size="24">controllable / reviewable / executable</text>${map(980,310,620,330)}`;
    else if (i===1) e = `${box(210,520,260,82,"AI proposes","#18A0FB")}${box(760,340,300,82,"Human reviews","#EF4444")}${box(1320,520,320,82,"System executes","#0B7A53")}${box(750,760,360,82,"Results feed back","#F59E0B")}${arr(470,560,760,382,"#18A0FB")}${arr(1060,382,1320,560,"#EF4444")}${arr(1480,602,1110,760,"#0B7A53")}${arr(750,802,360,602,"#F59E0B")}<text x="910" y="565" text-anchor="middle" fill="#0B1220" font-family="Aptos Display" font-size="42" font-weight="700">decision boundary</text>`;
    else if (i===2) e = `<text x="110" y="460" fill="#0B1220" font-family="Aptos Display" font-size="58" font-weight="800">A single request contains five hidden decisions.</text>${["event","dates","spatial scope","datasets","workflow"].map((l,k)=>`<line x1="1130" y1="${330+k*92}" x2="1360" y2="${330+k*92}" stroke="${["#EF4444","#F59E0B","#18A0FB","#0B7A53","#0B1220"][k]}" stroke-width="7"/><text x="1400" y="${344+k*92}" fill="${["#EF4444","#F59E0B","#18A0FB","#0B7A53","#0B1220"][k]}" font-family="Aptos Display" font-size="34" font-weight="800">${l}</text>`).join("")}`;
    else if (i===3) { const labs=["Request","LLM assumptions","Review checkpoint","GEE execution","Map evidence"]; e=labs.map((l,k)=>box(150+k*340,530,k===2?300:250,74,l,k===2?"#EF4444":"#0B1220")).join("")+labs.slice(0,4).map((_,k)=>arr(400+k*340,567,490+k*340,567,k===1?"#EF4444":"#0B1220")).join(""); }
    else if (i===4) e = `${["intent","chat","extraction","pre-confirm","confirmation","processing"].map((l,k)=>box(105+k*285,520,215,66,l,k===4?"#EF4444":"#0B7A53")).join("")}<text x="125" y="760" fill="#0B1220" font-family="Aptos Display" font-size="44" font-weight="700">State is the design tool.</text>`;
    else if (i===5) e = `<rect x="150" y="310" width="610" height="500" rx="20" fill="#FFFFFF" stroke="#C9D3C6" stroke-width="3"/><text x="200" y="380" fill="#0B1220" font-family="Aptos Display" font-size="40" font-weight="800">Review surface</text>${["Event name","Description","Location","Dates","Resolved AOI","Recommended layers"].map((l,k)=>`<line x1="210" y1="${455+k*55}" x2="260" y2="${455+k*55}" stroke="${k>=4?"#EF4444":"#18A0FB"}" stroke-width="5"/><text x="295" y="${465+k*55}" fill="#0B1220" font-family="Aptos" font-size="24">${l}</text>`).join("")}<text x="930" y="520" fill="#EF4444" font-family="Aptos Display" font-size="54" font-weight="800">Experts review variables, not prose.</text>`;
    else if (i===6) e = `${map(130,330,480,270)}<text x="130" y="690" fill="#18A0FB" font-family="Aptos Display" font-size="40" font-weight="800">spatial scope</text><line x1="780" y1="465" x2="1120" y2="465" stroke="#F59E0B" stroke-width="8"/><circle cx="780" cy="465" r="18" fill="#F59E0B"/><circle cx="950" cy="465" r="24" fill="#EF4444"/><circle cx="1120" cy="465" r="18" fill="#F59E0B"/><text x="760" y="690" fill="#F59E0B" font-family="Aptos Display" font-size="40" font-weight="800">temporal window</text>${["DSWX","Global Flood DB","JRC Water","HydroSHEDS"].map((l,k)=>box(1360,340+k*70,310,48,l,"#0B7A53")).join("")}`;
    else if (i===7) e = `${["asset_id","selection_profile","render_profile","legend_spec","execution_profile"].map((l,k)=>`<line x1="180" y1="${345+k*100}" x2="1560" y2="${345+k*100}" stroke="#C9D3C6" stroke-width="2"/><text x="220" y="${320+k*100}" fill="${k===4?"#EF4444":"#0B7A53"}" font-family="Cascadia Mono" font-size="34" font-weight="800">${l}</text><text x="760" y="${320+k*100}" fill="#0B1220" font-family="Aptos" font-size="30">execution contract field</text>`).join("")}`;
    else if (i===8) e = `${map(120,300,760,380)}${["confirmed parameters","GEE processing","tile URLs","map evidence","report / GEE code"].map((l,k)=>box(1090,300+k*76,340,54,l,k<2?"#18A0FB":"#EF4444")).join("")}<text x="140" y="820" fill="#FFFFFF" font-family="Aptos Display" font-size="44" font-weight="800">Map evidence is the artifact experts can inspect.</text>`;
    else if (i===9) e = `${["Ask","Extract","Confirm","Render","Export"].map((l,k)=>`<text x="${150+k*320}" y="430" fill="${k===2?"#EF4444":"#0B7A53"}" font-family="Cascadia Mono" font-size="24">0${k+1}</text><text x="${150+k*320}" y="500" fill="#0B1220" font-family="Aptos Display" font-size="44" font-weight="800">${l}</text><line x1="${150+k*320}" y1="560" x2="${360+k*320}" y2="560" stroke="${k===2?"#EF4444":"#0B7A53"}" stroke-width="5"/>`).join("")}<text x="150" y="780" fill="#0B1220" font-family="Aptos Display" font-size="42" font-weight="700">Show the control chain, not a feature tour.</text>`;
    else e = `${box(150,360,1250,180,"AI should not replace geospatial experts.","#0B7A53")}<text x="170" y="640" fill="#0B7A53" font-family="Aptos Display" font-size="52" font-weight="800">Make flood analysis explicit, controllable, reproducible.</text>`;
    return `<svg width="1920" height="1080" xmlns="http://www.w3.org/2000/svg"><defs><marker id="a" markerWidth="10" markerHeight="10" refX="8" refY="3" orient="auto"><path d="M0,0 L0,6 L9,3 z" fill="#0B1220"/></marker></defs><rect width="1920" height="1080" fill="${i===0||i===8?"#07111F":"#F6F7F2"}"/><line x1="90" y1="186" x2="310" y2="186" stroke="${i===8?"#18A0FB":"#0B7A53"}" stroke-width="6"/><text x="90" y="140" fill="${i===0||i===8?"#fff":"#0B1220"}" font-family="Aptos Display,Arial" font-size="42" font-weight="800">${titles[i]}</text><text x="94" y="225" fill="${i===0||i===8?"#A9B8C6":"#64748B"}" font-family="Cascadia Mono,monospace" font-size="20">${subs[i]}</text>${e}<text x="1600" y="950" text-anchor="end" fill="${i===0||i===8?"#A9B8C6":"#64748B"}" font-family="Cascadia Mono" font-size="22">NNU GIS · SatGPT Pro</text></svg>`;
  };
  const files = [];
  for (let i=0;i<11;i++){ const p=path.join(PREVIEW,`slide_${String(i+1).padStart(2,"0")}.png`); await sharp(Buffer.from(svg(i))).png().toFile(p); files.push(p); }
  const thumbs = await Promise.all(files.map(p=>sharp(p).resize(480,270).toBuffer()));
  await sharp({create:{width:4*480+5*22,height:3*270+4*22,channels:4,background:"#ECEFE7"}}).composite(thumbs.map((input,i)=>({input,left:22+(i%4)*502,top:22+Math.floor(i/4)*292}))).png().toFile(path.join(PREVIEW,"contact_sheet.png"));
}
async function qa() {
  const zip = await JSZip.loadAsync(fs.readFileSync(PPTX)); const names = Object.keys(zip.files);
  const bounds = obj.filter(o=>o.x < -0.01 || o.y < -0.01 || o.x+o.w > W+0.01 || o.y+o.h > H+0.01);
  const report = { toolchain:"Presentations/scientific design standard + PptxGenJS editable PPTX + Sharp previews + JSZip OpenXML QA", pptxPath:PPTX, previewPath:PREVIEW, contactSheetPath:path.join(PREVIEW,"contact_sheet.png"), slideCount:names.filter(n=>/^ppt\/slides\/slide\d+\.xml$/.test(n)).length, notesCount:names.filter(n=>/^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n)).length, boundsIssues:bounds, verdict:bounds.length?"REVIEW":"PASS" };
  fs.writeFileSync(QA, JSON.stringify(report,null,2), "utf8"); console.log(JSON.stringify(report,null,2));
}
async function main(){ clean(PREVIEW); const a=await makeAssets(); pptx=new PptxGenJS(); pptx.layout="LAYOUT_WIDE"; pptx.defineLayout({name:"LAYOUT_WIDE",width:W,height:H}); pptx.author="SatGPT Pro"; pptx.company="Nanjing Normal University"; pptx.theme={headFontFace:FH,bodyFontFace:FB}; [slide1,slide2,slide3,slide4,slide5,slide6,slide7,slide8,slide9,slide10,slide11].forEach(f=>f(a)); await pptx.writeFile({fileName:PPTX}); await previews(); await qa(); }
main().catch(e=>{console.error(e); process.exit(1);});
