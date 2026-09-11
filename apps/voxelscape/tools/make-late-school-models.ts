// One-off generator for the rm-stacker models the built-in "Late to School"
// demo wears: its furniture and fixtures, the small items the game hands out,
// and the neighbourhood's characters. Props and items are written in the
// indexed-png format `make-demo-models.ts` uses; the characters are written as
// six RGBA face paintings the stacker solver carves into a figure, the format
// `scripts/make-npc-models.mjs` builds. Run with
// `node --experimental-transform-types tools/make-late-school-models.ts` from
// this app; it writes into `public/models/`.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "fast-png";
import JSZip from "jszip";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "public", "models");
mkdirSync(out, { recursive: true });

type RGB = [number, number, number];

// --- indexed props and items, as `make-demo-models.ts` writes them ---

/** The palette png is always this many texels; the ray marcher samples it at 32. */
const PALETTE_LENGTH = 32;

type Painter = (x: number, y: number) => number;

interface Model {
  name: string;
  /** Voxel extents, in the order width (x), height (y), depth (z). */
  size: [number, number, number];
  /** Index 0 is unused; every drawn cell names an index from 1 up. */
  palette: RGB[];
  /** Paint the front side; other sides use index 1 unless `top`/`bottom` say. */
  front?: Painter;
  top?: number;
  bottom?: number;
}

const sideBitmap = (
  width: number,
  height: number,
  index: number,
  paint?: Painter,
) => {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = paint?.(x, y) ?? index;
    }
  }
  return { width, height, data };
};

const palettePng = (palette: RGB[]): Uint8Array => {
  const data = new Uint8Array(PALETTE_LENGTH * 4);
  for (let i = 0; i < PALETTE_LENGTH; i++) {
    const [r, g, b] = palette[i] ?? [0, 0, 0];
    const at = i << 2;
    data[at] = r;
    data[at + 1] = g;
    data[at + 2] = b;
    data[at + 3] = 255;
  }
  return encode({
    width: PALETTE_LENGTH,
    height: 1,
    data,
    channels: 4,
    depth: 8,
  });
};

const writeModel = async (model: Model): Promise<void> => {
  const [w, h, d] = model.size;
  const top = model.top ?? 1;
  const bottom = model.bottom ?? 1;
  const zip = new JSZip();
  const sides = {
    front: sideBitmap(w, h, 1, model.front),
    back: sideBitmap(w, h, 1),
    left: sideBitmap(d, h, 1),
    right: sideBitmap(d, h, 1),
    top: sideBitmap(w, d, top),
    bottom: sideBitmap(w, d, bottom),
  };
  for (const [kind, bitmap] of Object.entries(sides)) {
    zip.file(
      `${kind}.png`,
      encode({
        width: bitmap.width,
        height: bitmap.height,
        data: bitmap.data,
        channels: 1,
        depth: 8,
      }),
    );
  }
  zip.file("palette.png", palettePng(model.palette));
  writeFileSync(
    join(out, `${model.name}.zip`),
    await zip.generateAsync({ type: "uint8array" }),
  );
  console.log(`wrote ${model.name}.zip`);
};

const BLACK: RGB = [0, 0, 0];
const WOOD: RGB = [140, 100, 65];
const DARK_WOOD: RGB = [100, 70, 45];
const GREY: RGB = [150, 155, 160];
const DARK_GREY: RGB = [70, 74, 78];
const PAPER: RGB = [235, 235, 225];

const MODELS: Model[] = [
  // --- the school ---
  {
    name: "desk",
    size: [14, 6, 10],
    palette: [BLACK, WOOD, DARK_WOOD, GREY],
    front: (_x, y) => (y <= 1 ? 3 : 2),
    top: 1,
  },
  {
    name: "chair",
    size: [6, 6, 6],
    palette: [BLACK, GREY, DARK_GREY, WOOD],
    top: 1,
  },
  {
    name: "locker",
    size: [8, 14, 6],
    palette: [BLACK, [70, 110, 160], [40, 70, 110], [220, 225, 230]],
    front: (x, y) => (y === 11 ? 3 : x === 4 ? 2 : 1),
    top: 2,
  },
  {
    name: "cafeteria-table",
    size: [20, 5, 8],
    palette: [BLACK, [200, 205, 210], GREY, DARK_GREY],
    top: 1,
  },
  {
    name: "poster",
    size: [10, 12, 1],
    palette: [BLACK, PAPER, [200, 60, 60], [40, 40, 46]],
    front: (x, y) => (y >= 3 && y <= 8 && x >= 2 && x <= 7 ? 3 : 1),
  },

  // --- Bean Bros. ---
  {
    name: "slushie-machine",
    size: [10, 14, 6],
    palette: [BLACK, [235, 238, 242], [70, 120, 200], [240, 200, 60]],
    front: (x, y) => (x >= 2 && x <= 7 && y >= 3 && y <= 8 ? 3 : 1),
    top: 2,
  },
  {
    name: "beanbag",
    size: [10, 6, 10],
    palette: [BLACK, [110, 75, 45], [80, 55, 35], [60, 40, 25]],
    top: 2,
  },

  // --- the arcade ---
  {
    name: "arcade",
    size: [10, 16, 6],
    palette: [BLACK, [40, 42, 52], [20, 22, 30], [90, 200, 240]],
    front: (x, y) => (x >= 2 && x <= 7 && y >= 9 && y <= 13 ? 3 : 1),
    top: 2,
  },
  {
    name: "boarded-machine",
    size: [10, 16, 6],
    palette: [BLACK, [90, 65, 40], [60, 42, 26], [40, 42, 52]],
    front: (_x, y) => (y % 4 === 0 ? 2 : 1),
  },
  {
    name: "dumpster",
    size: [14, 8, 8],
    palette: [BLACK, [70, 110, 70], [45, 80, 45], [30, 34, 30]],
    top: 2,
  },

  // --- the street ---
  {
    name: "gate",
    size: [24, 14, 4],
    palette: [BLACK, [90, 95, 100], [60, 62, 66], [180, 185, 190]],
    front: (x) => (x % 4 === 0 ? 3 : 1),
  },
  {
    name: "flower",
    size: [4, 6, 4],
    palette: [BLACK, [70, 140, 60], [240, 200, 60], [200, 160, 40]],
    front: (_x, y) => (y >= 4 ? 3 : 1),
    top: 3,
  },
  {
    name: "mailbox",
    size: [6, 10, 6],
    palette: [BLACK, [70, 110, 200], [40, 70, 150], [120, 125, 130]],
    front: (x, y) => (y >= 6 && x === 2 ? 3 : 1),
    top: 2,
  },
  {
    name: "phone",
    size: [5, 8, 3],
    palette: [BLACK, [50, 52, 58], [30, 32, 38], [200, 205, 210]],
    front: (x, y) => (x >= 1 && x <= 3 && y >= 2 && y <= 6 ? 3 : 1),
  },
  {
    name: "door",
    size: [10, 16, 3],
    palette: [BLACK, WOOD, DARK_WOOD, [220, 200, 90]],
    front: (x, y) => (x === 8 && y === 7 ? 3 : 1),
  },
  {
    name: "mirror",
    size: [8, 12, 2],
    palette: [BLACK, [120, 125, 130], [190, 205, 215], [90, 95, 100]],
    front: (x, y) => (x >= 1 && x <= 6 && y >= 2 && y <= 9 ? 3 : 1),
  },
  {
    name: "bookshelf",
    size: [10, 14, 4],
    palette: [BLACK, WOOD, [200, 60, 60], [60, 110, 200]],
    front: (_x, y) => (y % 5 === 0 ? 2 : y % 5 === 2 ? 3 : 1),
    top: 2,
  },
  {
    name: "lemonade-stand",
    size: [12, 9, 8],
    palette: [BLACK, [230, 200, 60], [180, 150, 40], WOOD],
    front: (x, y) => (y >= 6 && x >= 3 && x <= 8 ? 3 : 1),
    top: 2,
  },
  {
    name: "bus-stop",
    size: [10, 12, 4],
    palette: [BLACK, [70, 74, 78], [40, 42, 46], [230, 235, 240]],
    front: (x, y) => (x >= 1 && x <= 8 && y >= 7 && y <= 10 ? 3 : 1),
  },

  // --- small items ---
  {
    name: "plush",
    size: [5, 6, 4],
    palette: [BLACK, [240, 140, 60], [200, 100, 40], [40, 40, 46]],
    front: (x, y) => (x >= 1 && x <= 3 && y >= 3 && y <= 4 ? 3 : 1),
  },
  {
    name: "banana",
    size: [6, 3, 3],
    palette: [BLACK, [240, 220, 60], [200, 180, 40], [120, 100, 30]],
    front: (x, y) => (y === 1 && x >= 1 && x <= 4 ? 3 : 1),
  },
  {
    name: "slushie",
    size: [4, 8, 4],
    palette: [BLACK, [230, 235, 240], [240, 210, 80], [180, 150, 50]],
    front: (_x, y) => (y >= 3 ? 2 : 1),
    top: 2,
  },
  {
    name: "pizza",
    size: [8, 2, 8],
    palette: [BLACK, [230, 190, 90], [200, 60, 50], [240, 240, 230]],
    top: 1,
    bottom: 1,
  },
  {
    name: "hotdog",
    size: [8, 4, 4],
    palette: [BLACK, [230, 190, 120], [170, 70, 60], [240, 220, 80]],
    top: 2,
    bottom: 1,
  },
  {
    name: "salad",
    size: [6, 5, 6],
    palette: [BLACK, [70, 140, 60], [200, 205, 210], [200, 60, 50]],
    top: 1,
    bottom: 2,
  },
  {
    name: "taco",
    size: [6, 5, 6],
    palette: [BLACK, [230, 190, 90], [160, 110, 60], [70, 140, 60]],
    top: 1,
    bottom: 1,
  },
  {
    name: "historybook",
    size: [7, 9, 2],
    palette: [BLACK, [150, 60, 50], [240, 235, 220], [200, 170, 60]],
    front: (x, y) => (x >= 1 && x <= 5 && y >= 2 && y <= 6 ? 2 : 1),
  },
  {
    name: "key",
    size: [6, 6, 2],
    palette: [BLACK, [220, 180, 60], [180, 140, 40], [120, 90, 30]],
    front: (x, y) => (x === 1 && y >= 1 && y <= 4 ? 2 : 1),
  },
  {
    name: "roaster",
    size: [4, 12, 4],
    palette: [BLACK, [150, 110, 70], [200, 205, 210], [120, 80, 50]],
    front: (_x, y) => (y <= 2 ? 3 : 1),
  },
  {
    name: "matches",
    size: [3, 6, 2],
    palette: [BLACK, [200, 60, 50], [240, 240, 230], [60, 50, 40]],
    front: (_x, y) => (y <= 2 ? 3 : 1),
  },
  {
    name: "hat",
    size: [7, 4, 7],
    palette: [BLACK, [60, 110, 200], [40, 80, 160], [240, 240, 240]],
    top: 1,
    bottom: 2,
  },
  {
    name: "lemonade",
    size: [4, 8, 4],
    palette: [BLACK, [235, 238, 242], [240, 210, 80], [200, 170, 60]],
    front: (_x, y) => (y >= 3 ? 2 : 1),
    top: 2,
  },
  {
    name: "foodbag",
    size: [8, 10, 4],
    palette: [BLACK, [150, 110, 70], [110, 80, 50], [80, 55, 35]],
    front: (x, y) => (y >= 6 && x >= 2 && x <= 5 ? 3 : 1),
  },
  {
    name: "bean",
    size: [4, 4, 4],
    palette: [BLACK, [110, 75, 45], [80, 55, 35], [60, 40, 25]],
    top: 2,
    bottom: 2,
  },
];

// --- the neighbourhood's characters, as RGBA face paintings ---

const GRID = 24;
/** The depth window every column spans, so a figure is a slab of solid voxels. */
const Z0 = 8;
const Z1 = 16;

/** The three silhouettes a character may be built from, as column heights. */
const SHAPES = {
  adult: [
    [7, 16, 13],
    [9, 14, 17],
    [10, 13, 21],
  ] as Array<[number, number, number]>,
  kid: [
    [8, 15, 10],
    [10, 13, 13],
    [11, 12, 16],
  ] as Array<[number, number, number]>,
  tall: [
    [7, 16, 15],
    [9, 14, 20],
    [10, 13, 23],
  ] as Array<[number, number, number]>,
};

interface Npc {
  file: string;
  shape: keyof typeof SHAPES;
  /** Bands top-down: below this height, this colour. The last covers the head. */
  bands: Array<[number, RGB]>;
  /** The head's skin colour, drawn over the top four rows of its columns. */
  skin: RGB;
  /** The first column and row of the head, for the face features. */
  headX: number;
  headY: number;
  /** One eye colour, painted at the two head columns. */
  eye: RGB;
}

const heightsOf = (parts: Array<[number, number, number]>): number[] => {
  const heights = new Array(GRID).fill(0);
  for (const [x0, x1, height] of parts) {
    for (let x = x0; x <= x1; x++) {
      heights[x] = Math.max(heights[x], height);
    }
  }
  return heights;
};

const bandColor = (bands: Array<[number, RGB]>, y: number): RGB => {
  for (const [above, color] of bands) {
    if (y < above) {
      return color;
    }
  }
  return bands[bands.length - 1][1];
};

const blank = (): Array<Array<RGB | null>> =>
  Array.from({ length: GRID }, () => new Array<RGB | null>(GRID).fill(null));

const figurePng = (cells: Array<Array<RGB | null>>): Uint8Array => {
  const data = new Uint8Array(GRID * GRID * 4);
  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      const color = cells[y][x];
      if (color === null) {
        continue;
      }
      const o = (y * GRID + x) * 4;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = 255;
    }
  }
  return encode({ width: GRID, height: GRID, data });
};

const put = (
  cells: Array<Array<RGB | null>>,
  x: number,
  y: number,
  color: RGB,
) => {
  cells[y][x] = color;
};

const writeFigure = async (npc: Npc): Promise<void> => {
  const heights = heightsOf(SHAPES[npc.shape]);
  const front = blank();
  const back = blank();
  const left = blank();
  const right = blank();
  const top = blank();
  const bottom = blank();
  const headRows = (y: number): boolean => y >= npc.headY && y < npc.headY + 4;

  for (let y = 0; y < GRID; y++) {
    for (let x = 0; x < GRID; x++) {
      if (heights[x] <= y) {
        continue;
      }
      const body = bandColor(npc.bands, y);
      const head = headRows(y) && x >= npc.headX && x <= npc.headX + 5;
      let color = head ? npc.skin : body;
      if (
        head &&
        (x === npc.headX + 2 || x === npc.headX + 3) &&
        y === npc.headY + 1
      ) {
        color = npc.eye;
      }
      put(front, x, GRID - 1 - y, color);
      put(back, GRID - 1 - x, GRID - 1 - y, body);
    }
    if (!heights.some((h) => h > y)) {
      continue;
    }
    const sideColor = headRows(y) ? npc.skin : bandColor(npc.bands, y);
    for (let z = Z0; z < Z1; z++) {
      put(left, z, GRID - 1 - y, sideColor);
      put(right, z, GRID - 1 - y, sideColor);
    }
  }

  for (let x = 0; x < GRID; x++) {
    if (heights[x] === 0) {
      continue;
    }
    for (let z = Z0; z < Z1; z++) {
      put(top, x, z, bandColor(npc.bands, heights[x] - 1));
      put(bottom, x, z, bandColor(npc.bands, 0));
    }
  }

  const zip = new JSZip();
  zip.file("front.png", figurePng(front));
  zip.file("back.png", figurePng(back));
  zip.file("left.png", figurePng(left));
  zip.file("right.png", figurePng(right));
  zip.file("top.png", figurePng(top));
  zip.file("bottom.png", figurePng(bottom));
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  writeFileSync(join(out, npc.file), bytes);
  console.log(`wrote ${npc.file} (${bytes.length} bytes)`);
};

const SKIN: RGB = [238, 200, 160];
const NPCS: Npc[] = [
  {
    file: "npc-laugh.zip",
    shape: "adult",
    bands: [
      [4, [60, 50, 40]],
      [13, [200, 55, 45]],
      [17, SKIN],
      [GRID, [180, 40, 35]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-alex.zip",
    shape: "adult",
    bands: [
      [4, [40, 60, 40]],
      [13, [70, 150, 80]],
      [17, SKIN],
      [GRID, [50, 120, 60]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-james.zip",
    shape: "adult",
    bands: [
      [4, [30, 30, 34]],
      [13, [40, 110, 60]],
      [17, SKIN],
      [GRID, [30, 90, 50]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-bully.zip",
    shape: "tall",
    bands: [
      [4, [40, 40, 46]],
      [13, [90, 90, 100]],
      [17, SKIN],
      [GRID, [40, 40, 46]],
    ],
    skin: [220, 180, 140],
    headX: 9,
    headY: 15,
    eye: [20, 20, 20],
  },
  {
    file: "npc-nerd.zip",
    shape: "kid",
    bands: [
      [4, [50, 70, 150]],
      [11, [230, 150, 60]],
      [15, SKIN],
      [GRID, [240, 220, 90]],
    ],
    skin: SKIN,
    headX: 10,
    headY: 12,
    eye: [30, 28, 28],
  },
  {
    file: "npc-homeless.zip",
    shape: "adult",
    bands: [
      [4, [70, 60, 50]],
      [13, [110, 90, 70]],
      [17, [200, 170, 140]],
      [GRID, [60, 50, 40]],
    ],
    skin: [200, 170, 140],
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-brit.zip",
    shape: "adult",
    bands: [
      [4, [60, 50, 40]],
      [13, [120, 80, 50]],
      [17, SKIN],
      [GRID, [90, 60, 40]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-brett.zip",
    shape: "adult",
    bands: [
      [4, [60, 50, 40]],
      [13, [60, 110, 170]],
      [17, SKIN],
      [GRID, [40, 80, 130]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-brad.zip",
    shape: "adult",
    bands: [
      [4, [50, 40, 60]],
      [13, [130, 80, 170]],
      [17, SKIN],
      [GRID, [90, 50, 120]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-sleepa.zip",
    shape: "adult",
    bands: [
      [4, [120, 80, 110]],
      [13, [230, 150, 190]],
      [17, SKIN],
      [GRID, [180, 100, 150]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-champ.zip",
    shape: "tall",
    bands: [
      [4, [60, 50, 40]],
      [13, [200, 60, 50]],
      [17, SKIN],
      [GRID, [230, 200, 60]],
    ],
    skin: [220, 180, 140],
    headX: 9,
    headY: 15,
    eye: [30, 28, 28],
  },
  {
    file: "npc-teacher.zip",
    shape: "adult",
    bands: [
      [4, [50, 60, 50]],
      [13, [70, 130, 90]],
      [17, SKIN],
      [GRID, [50, 100, 70]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-lemonade.zip",
    shape: "adult",
    bands: [
      [4, [80, 70, 40]],
      [13, [230, 200, 70]],
      [17, SKIN],
      [GRID, [180, 150, 50]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-obby.zip",
    shape: "adult",
    bands: [
      [4, [60, 50, 90]],
      [13, [180, 70, 170]],
      [17, SKIN],
      [GRID, [120, 50, 130]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-anomaly.zip",
    shape: "tall",
    bands: [
      [4, [15, 12, 18]],
      [13, [35, 20, 35]],
      [17, [30, 25, 35]],
      [GRID, [10, 8, 12]],
    ],
    skin: [30, 25, 35],
    headX: 9,
    headY: 15,
    eye: [220, 40, 40],
  },
  {
    file: "npc-littlebro.zip",
    shape: "kid",
    bands: [
      [4, [50, 70, 150]],
      [11, [80, 150, 220]],
      [15, SKIN],
      [GRID, [60, 110, 180]],
    ],
    skin: SKIN,
    headX: 10,
    headY: 12,
    eye: [30, 28, 28],
  },
  {
    file: "npc-pothead.zip",
    shape: "adult",
    bands: [
      [4, [60, 50, 40]],
      [13, [150, 150, 155]],
      [17, SKIN],
      [GRID, [90, 90, 95]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 13,
    eye: [30, 28, 28],
  },
  {
    file: "npc-santa.zip",
    shape: "tall",
    bands: [
      [4, [40, 40, 46]],
      [13, [200, 55, 45]],
      [17, SKIN],
      [GRID, [240, 240, 240]],
    ],
    skin: SKIN,
    headX: 9,
    headY: 15,
    eye: [30, 28, 28],
  },
];

for (const model of MODELS) {
  await writeModel(model);
}
for (const npc of NPCS) {
  await writeFigure(npc);
}
