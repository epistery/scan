// The epistery base field, painted to a canvas.
//
// Same constants and same geometry as ../../art/base_rings.html — 58x58
// tiles of 14px, arcs driven by Twinkle Twinkle, treble in green and bass
// in rust. Drawn rather than loaded so it stays sharp however far you zoom.

const TILE = 14;
const COLS = 58;
const ROWS = 58;
const CENTER_X = COLS / 2;
const CENTER_Y = ROWS / 2;

export const BASE_SIZE = TILE * COLS; // 812

const TREBLE = [
  1,1,5,5,6,6,5, 4,4,3,3,2,2,1, 5,5,4,4,3,3,2, 5,5,4,4,3,3,2,
  1,1,5,5,6,6,5, 4,4,3,3,2,2,1,
  1,2,3,4,5,5,5,6,6,6,5,5, 4,5,4,3,3,4,3,2,2,3,2,1,
  1,2,1,5,6,5,6,7,6,5, 4,5,4,3,4,3,2,3,2,1
].map(n => (n - 1) / 7);
const BASS = [
  1,3,5,3,1,3,5,3,4,6,1,6,4,6, 4,6,1,6,5,7,2,7,5,7,2,7,1,3,
  5,3,1,5,4,2,7,4,3,1,6,3,2,7,5,2, 5,3,1,5,4,2,7,4,3,1,6,3,2,7,5,2,
  1,3,5,3,1,3,5,3,4,6,1,6,4,6, 4,6,1,6,5,7,2,7,5,7,2,7,1,3,
  1,5,3,5,1,5,3,5,4,1,6,1,5,2,7,2, 1,5,3,5,6,3,1,3,4,1,6,1,5,2,7,1
].map(n => (n - 1) / 7);
const TREBLE_RHYTHM = [
  1,1,1,1,1,1,2, 1,1,1,1,1,1,2, 1,1,1,1,1,1,2, 1,1,1,1,1,1,2,
  1,1,1,1,1,1,2, 1,1,1,1,1,1,2,
  0.5,0.5,0.5,0.5,1,0.5,0.5,1,0.5,0.5,1,2, 0.5,0.5,0.5,0.5,1,0.5,0.5,1,0.5,0.5,1,2,
  0.5,0.25,0.25,1,0.5,0.5,0.5,0.5,1,2, 0.5,0.25,0.25,1,0.5,0.5,0.5,0.5,1,2
].map(n => n / 2);
const BASS_RHYTHM =
  new Array(88).fill(0.5).concat(new Array(32).fill(0.25)).map(n => n * 1.5);

function intervals(arr) {
  const out = [0];
  for (let i = 1; i < arr.length; i++) out.push(Math.abs(arr[i] - arr[i - 1]));
  return out;
}
const TREBLE_INT = intervals(TREBLE);
const BASS_INT = intervals(BASS);

const GREEN = ['#2d5016', '#4a7c59', '#6a9a6d'];
const RUST = ['#8b6f65', '#b08878', '#c9a89a'];
const FLOOR = '#fffffe';

// Ulam-style block spiral: the order the pattern unwinds from center.
function spiralIndex(x, y) {
  const dx = x - CENTER_X;
  const dy = y - CENTER_Y;
  const ring = Math.max(Math.abs(dx), Math.abs(dy));
  if (ring === 0) return 0;
  const prevTotal = (2 * ring - 1) * (2 * ring - 1);
  let pos;
  if (dx === ring && dy > -ring) pos = dy + ring;
  else if (dy === ring) pos = 2 * ring + (ring - dx);
  else if (dx === -ring) pos = 4 * ring + (ring - dy);
  else pos = 6 * ring + (dx + ring);
  return prevTotal + pos;
}

function musicalParams(x, y) {
  const i = spiralIndex(x, y);
  const trebleIdx = i % TREBLE.length;
  const bassIdx = i % BASS.length;
  const treblePitch = TREBLE[trebleIdx];
  const bassPitch = BASS[bassIdx];
  const treblePitch2 = TREBLE[(i + 7) % TREBLE.length];
  const bassPitch2 = BASS[(i + 11) % BASS.length];
  const trebleRhythmVal = TREBLE_RHYTHM[i % TREBLE_RHYTHM.length];
  const bassRhythmVal = BASS_RHYTHM[i % BASS_RHYTHM.length];
  const harmonyInterval = Math.abs(treblePitch - bassPitch);
  return {
    rotationFactor: (treblePitch - bassPitch) + (treblePitch2 - bassPitch2) * 0.3,
    weightFactor: (trebleRhythmVal * 1.2 + bassRhythmVal * 0.8) / 2,
    complexityFactor: (TREBLE_INT[trebleIdx] + BASS_INT[bassIdx]) / 2,
    arcLayers: harmonyInterval < 0.3 ? 3 : harmonyInterval < 0.5 ? 2 : 1,
    phrasePos: (i % 7) / 7,
    treblePitch, bassPitch,
    sizeMultiplier: 0.2 + treblePitch * 1.5 + (1 - bassPitch) * 0.5
  };
}

// Tapered "pointy lens" arc: out along the inner edge, back along the outer.
function fillArc(ctx, cx, cy, r, startAngle, arcSpan, maxWidth, color) {
  const segments = 20;
  const w = Math.max(0.5, maxWidth);
  ctx.fillStyle = color;
  ctx.beginPath();
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = startAngle + arcSpan * t;
    const taper = Math.sin(t * Math.PI) * w * 0.5;
    const x = cx + Math.cos(a) * (r - taper);
    const y = cy + Math.sin(a) * (r - taper);
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  for (let i = segments; i >= 0; i--) {
    const t = i / segments;
    const a = startAngle + arcSpan * t;
    const taper = Math.sin(t * Math.PI) * w * 0.5;
    ctx.lineTo(cx + Math.cos(a) * (r + taper), cy + Math.sin(a) * (r + taper));
  }
  ctx.closePath();
  ctx.fill();
}

function drawTile(ctx, x, y) {
  const p = musicalParams(x, y);
  const tileSize = TILE * p.sizeMultiplier;
  const cx = x * TILE + TILE / 2;
  const cy = y * TILE + TILE / 2;
  const baseRot = p.rotationFactor * Math.PI * 0.5;
  const trebleIdx = Math.min(2, Math.floor(p.treblePitch * 2.9));
  const bassIdx = Math.min(2, Math.floor(p.bassPitch * 2.9));

  // Primary — treble (green)
  const pR = tileSize * 0.44;
  const pW = 1.2 + p.weightFactor * 2.8;
  const pSpan = Math.PI * 0.5 + p.complexityFactor * 0.3;
  fillArc(ctx, cx, cy, pR, baseRot, pSpan, pW, GREEN[trebleIdx]);
  fillArc(ctx, cx, cy, pR, baseRot + Math.PI, pSpan, pW, GREEN[trebleIdx]);

  // Secondary — bass (rust)
  if (p.arcLayers >= 2) {
    const sR = tileSize * (0.30 + p.bassPitch * 0.12);
    const sW = 0.6 + p.weightFactor * 1.4;
    const sRot = baseRot + p.bassPitch * Math.PI * 0.6;
    fillArc(ctx, cx, cy, sR, sRot + Math.PI * 0.25, Math.PI * 0.45, sW, RUST[bassIdx]);
    fillArc(ctx, cx, cy, sR, sRot + Math.PI * 1.25, Math.PI * 0.45, sW, RUST[bassIdx]);
  }

  // Tertiary — harmonic blend
  if (p.complexityFactor > 0.12 && p.arcLayers >= 3) {
    const tR = tileSize * (0.18 + p.treblePitch * 0.08);
    const tW = 0.4 + p.weightFactor * 0.8;
    const tRot = baseRot - p.bassPitch * Math.PI * 0.4;
    const tSpan = Math.PI * 0.35 + p.complexityFactor * 0.2;
    const tColor = p.treblePitch > p.bassPitch ? GREEN[2] : RUST[2];
    fillArc(ctx, cx, cy, tR, tRot, tSpan, tW, tColor);
    fillArc(ctx, cx, cy, tR, tRot + Math.PI, tSpan, tW, tColor);
  }

  // Phrase-ending dot
  if (p.phrasePos < 0.15) {
    ctx.fillStyle = p.treblePitch > 0.5 ? GREEN[0] : RUST[0];
    ctx.beginPath();
    ctx.arc(cx, cy, tileSize * 0.07 * (1 + p.weightFactor), 0, Math.PI * 2);
    ctx.fill();
  }

  // High-note accents
  if (p.treblePitch > 0.7) {
    fillArc(ctx, cx, cy, tileSize * 0.52, baseRot + Math.PI * 0.5, Math.PI * 0.12,
            0.3 + p.sizeMultiplier * 0.15, GREEN[2]);
  }
  if (p.bassPitch > 0.7) {
    fillArc(ctx, cx, cy, tileSize * 0.48, baseRot - Math.PI * 0.5, Math.PI * 0.12,
            0.25 + p.sizeMultiplier * 0.12, RUST[2]);
  }
}

/**
 * Paint the whole field onto a context. `scale` maps field units to pixels;
 * the context should be BASE_SIZE * scale square. ~3400 tiles, so call once
 * into an offscreen canvas and blit from there.
 */
export function drawField(ctx, scale = 1) {
  ctx.save();
  ctx.scale(scale, scale);
  ctx.fillStyle = FLOOR;
  ctx.fillRect(0, 0, BASE_SIZE, BASE_SIZE);
  const tiles = [];
  for (let y = 0; y < ROWS; y++) {
    for (let x = 0; x < COLS; x++) tiles.push({ x, y, i: spiralIndex(x, y) });
  }
  tiles.sort((a, b) => a.i - b.i);
  for (const t of tiles) drawTile(ctx, t.x, t.y);
  ctx.restore();
}
