const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const pptxPath = "E:\\GMS\\Flood\\SatGPT-app\\outputs\\SatGPT_HITL_Geospatial_Agent_Talk.pptx";
const outPath = "E:\\GMS\\Flood\\SatGPT-app\\outputs\\SatGPT_HITL_Geospatial_Agent_Talk_preview\\openxml_qa.json";
const EMU_PER_IN = 914400;
const W = 13.333;
const H = 7.5;
const issues = [];

(async () => {
  const zip = await JSZip.loadAsync(fs.readFileSync(pptxPath));
  const names = Object.keys(zip.files);
  const slideEntries = names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const notesEntries = names.filter(n => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));

  for (const name of slideEntries) {
    const xml = await zip.files[name].async("string");
    const id = name.match(/slide(\d+)\.xml/)[1];
    const re = /<a:off x="(-?\d+)" y="(-?\d+)"\/><a:ext cx="(-?\d+)" cy="(-?\d+)"/g;
    let m;
    while ((m = re.exec(xml))) {
      const x = Number(m[1]) / EMU_PER_IN;
      const y = Number(m[2]) / EMU_PER_IN;
      const w = Number(m[3]) / EMU_PER_IN;
      const h = Number(m[4]) / EMU_PER_IN;
      if (x < -0.02 || y < -0.02 || x + w > W + 0.02 || y + h > H + 0.02) {
        issues.push({ slide: Number(id), x, y, w, h, reason: "object outside slide bounds" });
      }
    }
  }

  const report = {
    pptxPath,
    slideCount: slideEntries.length,
    notesCount: notesEntries.length,
    mediaCount: names.filter(n => /^ppt\/media\//.test(n)).length,
    issues,
  };

  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
})();
