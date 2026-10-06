// Renders every silhouette in every pose to outputs/silhouettes.png for review.
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

import { SILHOUETTE_IDS, shapesToSvg, silhouetteShapes } from "../components/frame/silhouettes.ts";

const poses = ["perched", "up", "mid", "down", "glide"];
const cells = SILHOUETTE_IDS.map(
  (id) =>
    `<div class="row"><h2>${id}</h2>${poses
      .map(
        (pose) =>
          `<figure><svg viewBox="0 0 100 100" width="150" height="150">${shapesToSvg(
            silhouetteShapes(id, pose),
            "#182b25",
          )}<line x1="0" y1="92" x2="100" y2="92" stroke="#c98536" stroke-width="0.4"/></svg><figcaption>${pose}</figcaption></figure>`,
      )
      .join("")}</div>`,
).join("");
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#f2efe5;font:14px Georgia,serif;color:#182b25;padding:24px}
.row{display:flex;align-items:center;gap:8px;border-bottom:1px solid #cad5ce}
h2{width:120px;font-weight:400;font-size:18px;margin:0}
figure{margin:0;text-align:center}figcaption{font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#7d9788}
</style>${cells}`;
await mkdir("outputs", { recursive: true });
await writeFile("outputs/silhouettes.html", html);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 980, height: 2800 }, deviceScaleFactor: 1 });
await page.setContent(html);
await page.screenshot({ path: "outputs/silhouettes.png", fullPage: true });
await browser.close();
console.log("wrote outputs/silhouettes.png");
