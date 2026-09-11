// The bursts a place script sets off, ported from the `Explosion` model in
// `apps/melty-karts`: one mesh of billboard particles scattered over a sphere,
// each drifting outward along its own direction as it ages, with a
// ember-to-spark radial gradient and an additive blend. Like the fire beside
// it, all motion runs in the vertex shader and the geometry is baked once; the
// one deviation is sizing, which is in world units so a blast's `mesh.scale`
// sets its radius rather than its pixel footprint.
import type { Node, UniformNode } from "@random-mesh/rmsl";
import { float, mix, smoothstep, vec2, vec3, vec4 } from "@random-mesh/rmsl";
import {
  Blending,
  BufferAttribute,
  BufferGeometry,
  Builder,
  Group,
  Mesh,
  NodeMaterial,
  Scene,
  Side,
} from "@random-mesh/rmsl/scene";
import type { ScriptedExplosion } from "../world/explosion-blast";

/** How many billboards make one burst. */
const BURST_COUNT = 160;
/** How long one burst is drawn, in seconds. */
const BURST_SECONDS = 0.85;
/** The age every particle reaches full expansion and zero opacity at, in seconds. */
const PARTICLE_LIFE = 0.8;
/** The greatest head start any particle gets, in seconds. */
const PARTICLE_STAGGER = 0.15;
/** How far a particle drifts from the centre, in local units at the base scale. */
const BURST_DRIFT = 0.5;
/** How wide one particle billboard is, in local units at the base scale. */
const PARTICLE_SIZE: [number, number] = [0.08, 0.2];
/** How many bursts may animate at once before the oldest material is reused. */
const MATERIAL_POOL = 8;

/** One random point on the unit sphere, the direction a particle flies. */
const spherePoint = (): [number, number, number] => {
  const u = Math.random();
  const v = Math.random();
  const theta = 2 * Math.PI * u;
  const sqrtTerm = Math.sqrt(v * (1 - v));
  return [
    2 * sqrtTerm * Math.cos(theta),
    2 * sqrtTerm * Math.sin(theta),
    2 * v - 1,
  ];
};

/**
 * One burst's particle geometry in local space around its centre: `BURST_COUNT`
 * quads of four billboard corner vertices, each carrying an outward drift, a
 * phase offset, a size, and a lifetime. Written once and never touched — the
 * shader does all the animating.
 */
const buildBurstGeometry = (): BufferGeometry => {
  const positions = new Float32Array(BURST_COUNT * 4 * 3);
  const corners = new Float32Array(BURST_COUNT * 4 * 2);
  const drifts = new Float32Array(BURST_COUNT * 4 * 3);
  const lives = new Float32Array(BURST_COUNT * 4);
  const offsets = new Float32Array(BURST_COUNT * 4);
  const sizes = new Float32Array(BURST_COUNT * 4);
  const uvs = new Float32Array(BURST_COUNT * 4 * 2);
  const indices = new Uint16Array(BURST_COUNT * 6);
  const CORNER: ReadonlyArray<readonly [number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let i = 0; i < BURST_COUNT; i++) {
    const [dx, dy, dz] = spherePoint();
    const px = dx * 0.02;
    const py = dy * 0.02;
    const pz = dz * 0.02;
    const size =
      PARTICLE_SIZE[0] + Math.random() * (PARTICLE_SIZE[1] - PARTICLE_SIZE[0]);
    const offset = Math.random() * PARTICLE_STAGGER;
    const v0 = i * 4;
    for (let j = 0; j < 4; j++) {
      const vi = v0 + j;
      const vs = vi * 3;
      const ct = vi * 2;
      positions[vs] = px;
      positions[vs + 1] = py;
      positions[vs + 2] = pz;
      corners[ct] = CORNER[j][0];
      corners[ct + 1] = CORNER[j][1];
      drifts[vs] = dx * BURST_DRIFT;
      drifts[vs + 1] = dy * BURST_DRIFT;
      drifts[vs + 2] = dz * BURST_DRIFT;
      lives[vi] = PARTICLE_LIFE;
      offsets[vi] = offset;
      sizes[vi] = size;
      uvs[ct] = (CORNER[j][0] + 1) / 2;
      uvs[ct + 1] = (CORNER[j][1] + 1) / 2;
    }
    indices[i * 6 + 0] = v0;
    indices[i * 6 + 1] = v0 + 1;
    indices[i * 6 + 2] = v0 + 2;
    indices[i * 6 + 3] = v0;
    indices[i * 6 + 4] = v0 + 2;
    indices[i * 6 + 5] = v0 + 3;
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute("particlePos", new BufferAttribute(positions, 3));
  geometry.setAttribute("corner", new BufferAttribute(corners, 2));
  geometry.setAttribute("drift", new BufferAttribute(drifts, 3));
  geometry.setAttribute("life", new BufferAttribute(lives, 1));
  geometry.setAttribute("offset", new BufferAttribute(offsets, 1));
  geometry.setAttribute("size", new BufferAttribute(sizes, 1));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
};

/**
 * The additive burst material: each particle flies outward as it ages, and the
 * ember-to-flame-to-spark gradient fades it in and out. The material is
 * self-lit, and its clock is advanced per burst so a fresh blast starts at the
 * beginning of the animation.
 */
class ExplosionMaterial extends NodeMaterial {
  /** The burst's age in seconds, from 0 at the moment it started. */
  time = 0;

  private timeUniform: UniformNode<"float"> | undefined;

  constructor() {
    super();
    this.transparent = true;
    this.depthWrite = false;
    this.side = Side.DoubleSide;
    this.blending = Blending.AdditiveBlending;
  }

  protected setup(b: Builder, _scene: Scene): void {
    this.timeUniform = b.materialUniform("time", "float", () => this.time);
  }

  protected buildVertexBody(b: Builder): Node<"vec4"> {
    const time = (this.timeUniform ?? float(0)).toVar();
    const pos = b.attribute("particlePos", "vec3");
    const corner = b.attribute("corner", "vec2");
    const drift = b.attribute("drift", "vec3");
    const life = b.attribute("life", "float");
    const offset = b.attribute("offset", "float");
    const size = b.attribute("size", "float");
    const uv = b.attribute("uv", "vec2");

    // Each particle runs its own age once, from the centre outward, and the
    // fade masks its start and end; it never loops, so a burst stays gone.
    const lifeT = time.add(offset).div(life).clamp(float(0), float(1)).toVar();
    const fadeIn = smoothstep(float(0), float(0.08), lifeT);
    const fadeOut = float(1).sub(smoothstep(float(0.35), float(1), lifeT));
    const fade = fadeIn.mul(fadeOut).toVar();
    const heat = float(1).sub(lifeT).toVar();

    // The particle flies outward along its own direction as it ages.
    const animLocal = pos.add(drift.mul(lifeT)).toVar();
    const mvPos = b.viewMatrix
      .mul(b.modelMatrix.mul(vec4(animLocal, float(1))))
      .toVar();
    const offset2 = corner.mul(size.mul(fade)).toVar();
    const billboard = mvPos.xyz
      .add(vec3(offset2.x, offset2.y, float(0)))
      .toVar();

    b.varying("vUv", "vec2").assign(uv);
    b.varying("vFade", "float").assign(fade);
    b.varying("vHeat", "float").assign(heat);
    return b.projectionMatrix.mul(vec4(billboard, mvPos.w));
  }

  protected buildFragmentBody(b: Builder): Node<"vec4"> {
    const uv = b.varying("vUv", "vec2");
    const fade = b.varying("vFade", "float");
    const heat = b.varying("vHeat", "float");

    // A radial gradient from the quad's centre: ember at the cool edge, flame
    // toward the core, with a hot spark where the heat is high, cut to a disc
    // so the corners stay transparent.
    const centered = uv.sub(vec2(0.5)).toVar();
    const ptDist = centered.length().toVar();
    const circleAlpha = ptDist
      .lessThanEqual(float(0.5))
      .select(float(1), float(0));
    const core = float(1).sub(smoothstep(float(0), float(0.28), ptDist));
    const edge = float(1).sub(smoothstep(float(0.12), float(0.5), ptDist));

    const ember = vec3(1.0, 0.22, 0.02);
    const flame = vec3(1.0, 0.55, 0.08);
    const spark = vec3(1.0, 0.95, 0.55);
    const heatClamped = heat.mul(float(1.2)).clamp(float(0), float(1));
    const color = mix(ember, flame, heatClamped);
    const finalColor = mix(color, spark, core);
    const alpha = edge.mul(fade).mul(circleAlpha).toVar();

    return vec4(finalColor, alpha);
  }
}

/** One blast's mesh, the material it animates, and the moment it started. */
interface Burst {
  mesh: Mesh;
  material: ExplosionMaterial;
  started: number;
}

/**
 * Draws the blasts a place script set off. The set reconciles against the
 * host's explosion list every tick, the same way `FireFigures` reconciles the
 * fires; a blast whose id is dispatched again is lit afresh. Materials are
 * pooled, so a run that sets off many blasts compiles a fixed number of
 * shaders rather than one per blast.
 */
export class ExplosionFigures {
  /** The scene group the blasts draw in; add it to the world's scene. */
  readonly group = new Group();

  private readonly geometry = buildBurstGeometry();
  private readonly materials: ExplosionMaterial[] = [];
  private readonly free: ExplosionMaterial[] = [];
  private readonly bursts = new Map<string, Burst>();
  /** The `at` each id was last burst at, so a re-dispatch lights it again. */
  private readonly lit = new Map<string, number>();
  private time = 0;

  constructor(private readonly explosions: () => ScriptedExplosion[]) {}

  /** Advances the burst clock and refills the mesh set from the host. */
  tick(dt: number): void {
    this.time += dt;
    const current = this.explosions();
    const present = new Set<string>();
    for (const explosion of current) {
      present.add(explosion.id);
      if (this.lit.get(explosion.id) === explosion.at) {
        continue;
      }
      this.lit.set(explosion.id, explosion.at);
      this.start(explosion);
    }
    for (const [id, burst] of this.bursts) {
      const age = this.time - burst.started;
      if (age >= BURST_SECONDS) {
        this.discard(id);
        continue;
      }
      burst.material.time = age;
    }
    for (const id of [...this.lit.keys()]) {
      if (!present.has(id)) {
        this.lit.delete(id);
      }
    }
  }

  /** Removes every burst, leaving the set ready for a fresh script. */
  clear(): void {
    for (const id of [...this.bursts.keys()]) {
      this.discard(id);
    }
    this.lit.clear();
  }

  private start(explosion: ScriptedExplosion): void {
    this.discard(explosion.id);
    const material = this.takeMaterial();
    material.time = 0;
    const mesh = new Mesh(this.geometry, material);
    mesh.position.set(explosion.x, explosion.y, explosion.z);
    mesh.scale.setScalar(explosion.radius);
    this.group.add(mesh);
    this.bursts.set(explosion.id, { mesh, material, started: this.time });
  }

  private discard(id: string): void {
    const burst = this.bursts.get(id);
    if (burst === undefined) {
      return;
    }
    this.group.remove(burst.mesh);
    this.bursts.delete(id);
    this.free.push(burst.material);
  }

  /** A free material, a new one while the pool has room, or the oldest's. */
  private takeMaterial(): ExplosionMaterial {
    const free = this.free.pop();
    if (free !== undefined) {
      return free;
    }
    if (this.materials.length < MATERIAL_POOL) {
      const material = new ExplosionMaterial();
      this.materials.push(material);
      return material;
    }
    const oldest = [...this.bursts.entries()].sort(
      (a, b) => a[1].started - b[1].started,
    )[0];
    if (oldest === undefined) {
      return this.materials[0];
    }
    this.discard(oldest[0]);
    return this.free.pop() as ExplosionMaterial;
  }
}
