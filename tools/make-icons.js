'use strict';

/**
 * Icon generator.
 *
 * Reads the source logo and derives the square icon masters Windows needs plus
 * the natural-aspect copy the UI shows. A non-square source must be padded, never
 * stretched: Windows icons and installers assume a square canvas, so a 1.5:1
 * artwork fed in directly would come out distorted.
 *
 * Run with: npm run icons
 */

const { app, BrowserWindow } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const SOURCE = path.join(ROOT, 'logo.png');

const OUT = {
  icoMaster: path.join(ROOT, 'build', 'icon.png'), // electron-builder -> .ico
  windowIcon: path.join(ROOT, 'assets', 'logo-square.png'), // BrowserWindow icon
  uiLogo: path.join(ROOT, 'renderer', 'assets', 'logo.png') // top bar, natural aspect
};

const ANALYSIS = { rows: 40, cols: 76 };

// This tool opens and closes throwaway windows; without this, Electron quits the
// moment the first one closes and the run ends before anything is written.
app.on('window-all-closed', () => {});

async function analyseAndRender() {
  const dataUrl = 'data:image/png;base64,' + fs.readFileSync(SOURCE).toString('base64');

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      width: 400,
      height: 300,
      webPreferences: { offscreen: false }
    });

    win.webContents.once('did-finish-load', async () => {
      try {
        const result = await win.webContents.executeJavaScript(
          `(async () => {
            const img = new Image();
            img.src = ${JSON.stringify(dataUrl)};
            await img.decode();

            const W = img.naturalWidth, H = img.naturalHeight;
            const src = document.createElement('canvas');
            src.width = W; src.height = H;
            const sg = src.getContext('2d', { willReadFrequently: true });
            sg.drawImage(img, 0, 0);
            const px = sg.getImageData(0, 0, W, H).data;

            const A = (x, y) => px[(y * W + x) * 4 + 3];

            // Tight bounding box of anything not fully transparent.
            const TH = 8;
            let minX = W, minY = H, maxX = -1, maxY = -1, opaque = 0;
            for (let y = 0; y < H; y++) {
              for (let x = 0; x < W; x++) {
                if (A(x, y) > TH) {
                  opaque++;
                  if (x < minX) minX = x;
                  if (y < minY) minY = y;
                  if (x > maxX) maxX = x;
                  if (y > maxY) maxY = y;
                }
              }
            }
            if (maxX < 0) { minX = 0; minY = 0; maxX = W - 1; maxY = H - 1; }

            // Coarse alpha picture so the artwork's shape can be checked in text.
            const rows = ${ANALYSIS.rows}, cols = ${ANALYSIS.cols};
            const ramp = ' .:-=+*#%@';
            const pic = [];
            for (let r = 0; r < rows; r++) {
              let line = '';
              for (let c = 0; c < cols; c++) {
                const x0 = Math.floor((c / cols) * W), x1 = Math.max(x0 + 1, Math.floor(((c + 1) / cols) * W));
                const y0 = Math.floor((r / rows) * H), y1 = Math.max(y0 + 1, Math.floor(((r + 1) / rows) * H));
                let sum = 0, n = 0;
                for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { sum += A(x, y); n++; }
                const v = n ? sum / n / 255 : 0;
                line += ramp[Math.min(ramp.length - 1, Math.round(v * (ramp.length - 1)))];
              }
              pic.push(line);
            }

            // Dominant opaque colours (5-bit quantised).
            const hist = new Map();
            for (let y = 0; y < H; y += 3) {
              for (let x = 0; x < W; x += 3) {
                const o = (y * W + x) * 4;
                if (px[o + 3] <= 128) continue;
                const k = ((px[o] >> 3) << 10) | ((px[o + 1] >> 3) << 5) | (px[o + 2] >> 3);
                hist.set(k, (hist.get(k) || 0) + 1);
              }
            }
            const total = [...hist.values()].reduce((a, b) => a + b, 0) || 1;
            const colours = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, n]) => {
              const r = (k >> 10) & 31, g = (k >> 5) & 31, b = k & 31;
              const hex = '#' + [r, g, b].map((v) => (v << 3).toString(16).padStart(2, '0')).join('');
              return { hex, pct: +(100 * n / total).toFixed(1) };
            });

            const cw = maxX - minX + 1, ch = maxY - minY + 1;

            // Natural-aspect copy for the UI (trimmed, capped at 1024 wide).
            const uiScale = Math.min(1, 1024 / cw);
            const uiW = Math.max(1, Math.round(cw * uiScale));
            const uiH = Math.max(1, Math.round(ch * uiScale));
            const ui = document.createElement('canvas');
            ui.width = uiW; ui.height = uiH;
            const ug = ui.getContext('2d');
            ug.imageSmoothingQuality = 'high';
            ug.drawImage(src, minX, minY, cw, ch, 0, 0, uiW, uiH);

            /**
             * Square icon master.
             *
             * Two source shapes are handled, because both have been delivered:
             *
             *  - self-contained: the artwork brings its own background (a plain
             *    square, or a round badge whose bounding box fills the canvas with
             *    only the corners transparent), so it is centre-cropped to square
             *    and used edge to edge;
             *  - transparent line art: a bare transparent icon would vanish on a
             *    dark Windows taskbar and a non-square source would be squashed by
             *    the .ico conversion, so it is padded onto a mint plate.
             *
             * The test is the bounding box plus how dense the artwork is inside it -
             * not the raw alpha ratio, which misreads the transparent corners of a
             * round badge as "transparent artwork" and would double-background it on
             * a plate.
             */
            const bboxCoversCanvas = cw >= W - 2 && ch >= H - 2;
            const densityInBox = opaque / (cw * ch);
            const selfContained = bboxCoversCanvas && densityInBox >= 0.8;
            const square = (size, { forcePlate = false, noPlate = false } = {}) => {
              const plate = !noPlate && (forcePlate || !selfContained);
              const cv = document.createElement('canvas');
              cv.width = size; cv.height = size;
              const g = cv.getContext('2d');
              g.imageSmoothingQuality = 'high';

              if (plate) {
                const m = Math.round(size * 0.055);
                const r = Math.round(size * 0.21);
                const x = m, y = m, w = size - 2 * m, h = size - 2 * m;
                const grad = g.createLinearGradient(0, y, 0, y + h);
                grad.addColorStop(0, '#d6f2e0');
                grad.addColorStop(1, '#8ed3b5');
                g.beginPath();
                g.moveTo(x + r, y);
                g.arcTo(x + w, y, x + w, y + h, r);
                g.arcTo(x + w, y + h, x, y + h, r);
                g.arcTo(x, y + h, x, y, r);
                g.arcTo(x, y, x + w, y, r);
                g.closePath();
                g.fillStyle = grad;
                g.fill();
                g.lineWidth = Math.max(1, Math.round(size * 0.008));
                g.strokeStyle = 'rgba(12, 32, 24, 0.35)';
                g.stroke();
              }

              if (selfContained && !forcePlate) {
                // Centre-crop to square, then fill the canvas edge to edge.
                const side = Math.min(cw, ch);
                const sx = minX + (cw - side) / 2;
                const sy = minY + (ch - side) / 2;
                g.drawImage(src, sx, sy, side, side, 0, 0, size, size);
              } else {
                // Fit inside the plate (or the whole canvas when unplated).
                const box = plate ? 0.68 : 1;
                const s = Math.min((size * box) / cw, (size * box) / ch);
                const dw = Math.round(cw * s), dh = Math.round(ch * s);
                g.drawImage(src, minX, minY, cw, ch, Math.round((size - dw) / 2), Math.round((size - dh) / 2), dw, dh);
              }
              return cv.toDataURL('image/png');
            };

            // Never upscale: a master larger than the artwork invents no detail.
            const masterSize = Math.max(256, Math.min(1024, Math.min(cw, ch)));

            return {
              width: W, height: H,
              bbox: { x: minX, y: minY, w: cw, h: ch },
              opaquePct: +(100 * opaque / (W * H)).toFixed(1),
              selfContained,
              bboxCoversCanvas: bboxCoversCanvas,
              densityInBox: +densityInBox.toFixed(3),
              masterSize,
              contentAspect: +(cw / ch).toFixed(3),
              colours,
              picture: pic,
              ui: { w: uiW, h: uiH, png: ui.toDataURL('image/png') },
              iconMaster: square(masterSize, { noPlate: ${JSON.stringify(!!process.env.HOTSOUND_NO_PLATE)} }),
              iconWindow: square(Math.min(512, masterSize), { noPlate: ${JSON.stringify(!!process.env.HOTSOUND_NO_PLATE)} })
            };
          })()`,
          true
        );
        win.destroy();
        resolve(result);
      } catch (err) {
        win.destroy();
        reject(err);
      }
    });

    win.loadURL('data:text/html,<html><body></body></html>');
  });
}

function writeDataUrl(file, dataUrl) {
  const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return fs.statSync(file).size;
}

/** Load the written files back and measure their shape. */
async function inspectWritten(files) {
  const payload = files.map((f) => ({
    file: f,
    dataUrl: 'data:image/png;base64,' + fs.readFileSync(f).toString('base64')
  }));

  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({ show: false, width: 300, height: 200 });
    win.webContents.once('did-finish-load', async () => {
      try {
        const out = await win.webContents.executeJavaScript(
          `(async () => {
             const items = ${JSON.stringify(payload)};
             const results = [];
             for (const item of items) {
               const img = new Image();
               img.src = item.dataUrl;
               await img.decode();
               const w = img.naturalWidth, h = img.naturalHeight;
               const cv = document.createElement('canvas');
               cv.width = w; cv.height = h;
               const g = cv.getContext('2d', { willReadFrequently: true });
               g.drawImage(img, 0, 0);
               const px = g.getImageData(0, 0, w, h).data;
               const at = (x, y) => {
                 const o = (y * w + x) * 4;
                 return { a: px[o + 3], rgb: '#' + [px[o], px[o + 1], px[o + 2]].map((v) => v.toString(16).padStart(2, '0')).join('') };
               };
               const inset = Math.max(1, Math.round(w * 0.03));
               const corners = [at(0, 0), at(w - 1, 0), at(0, h - 1), at(w - 1, h - 1), at(inset, inset)];
               let opaque = 0;
               for (let i = 3; i < px.length; i += 4) if (px[i] > 8) opaque++;
               results.push({
                 file: item.file,
                 w, h,
                 cornerAlpha: corners.map((c) => c.a),
                 centre: at(Math.floor(w / 2), Math.floor(h / 2)).rgb,
                 opaquePct: +(100 * opaque / (w * h)).toFixed(1)
               });
             }
             return results;
           })()`,
          true
        );
        win.destroy();
        resolve(out);
      } catch (err) {
        win.destroy();
        reject(err);
      }
    });
    win.loadURL('data:text/html,<html><body></body></html>');
  });
}

app.whenReady().then(async () => {
  if (!fs.existsSync(SOURCE)) {
    console.error('Missing source logo at ' + SOURCE);
    app.exit(1);
    return;
  }

  let r;
  try {
    r = await analyseAndRender();
  } catch (err) {
    console.error('Icon generation failed: ' + err.message);
    app.exit(1);
    return;
  }

  console.log(`Source: ${path.relative(ROOT, SOURCE)}  ${r.width}x${r.height}`);
  console.log(`Opaque content: ${r.bbox.w}x${r.bbox.h} at (${r.bbox.x},${r.bbox.y})  aspect ${r.contentAspect}`);
  console.log(`Pixels with alpha: ${r.opaquePct}% of the canvas`);
  console.log(`Bounding box fills the canvas: ${r.bboxCoversCanvas}   density inside it: ${r.densityInBox}`);
  console.log(`Source kind: ${r.selfContained ? 'self-contained -> centre-cropped to square, used edge to edge' : 'transparent line art -> padded onto a mint plate'}`);
  console.log('\nAlpha preview (dark = transparent, @ = solid):');
  for (const line of r.picture) console.log('  |' + line + '|');

  const sizes = [
    [OUT.icoMaster, r.iconMaster],
    [OUT.windowIcon, r.iconWindow],
    [OUT.uiLogo, r.ui.png]
  ];
  console.log('\nWritten:');
  for (const [file, dataUrl] of sizes) {
    const bytes = writeDataUrl(file, dataUrl);
    console.log(`  ${path.relative(ROOT, file).replace(/\\/g, '/')}  ${(bytes / 1024).toFixed(1)} KB`);
  }
  console.log(`  (UI copy is ${r.ui.w}x${r.ui.h}; square masters are ${r.masterSize}px and ${Math.min(512, r.masterSize)}px)`);

  // Read the results back and check the shape survived. This is the check that
  // catches a self-contained badge being given a plate it does not need, which
  // leaves a coloured square behind a round mark.
  let check;
  try {
    check = await inspectWritten(sizes.map(([file]) => file));
  } catch (err) {
    console.error('Verification failed to run: ' + err.message);
    app.exit(1);
    return;
  }

  console.log('\nVerified output (corner alpha / centre pixel):');
  for (const f of check) {
    console.log(`  ${path.relative(ROOT, f.file).replace(/\\/g, '/')}  ${f.w}x${f.h}  corners a=${f.cornerAlpha.join(',')}  centre ${f.centre}  opaque ${f.opaquePct}%`);
  }

  const problems = [];
  if (r.selfContained) {
    // The artwork supplies its own background, so nothing may be added behind it.
    for (const f of check) {
      if (f.cornerAlpha.some((a) => a > 8)) {
        problems.push(`${path.basename(f.file)}: corners are opaque, so something was drawn behind the artwork`);
      }
    }
  }
  const master = check[0];
  const winIcon = check[1];
  if (master.w !== master.h || winIcon.w !== winIcon.h) problems.push('a square master came out non-square');

  if (problems.length) {
    console.error('\nICON CHECK FAILED:');
    for (const p of problems) console.error('  - ' + p);
    app.exit(1);
    return;
  }
  console.log('Icon check: OK');

  app.exit(0);
});
