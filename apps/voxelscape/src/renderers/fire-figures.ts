// The world-anchored fire the gasa4 demo ignites in its kitchen, ported from
// the `apps/bomb-bloom` demo beside this workspace. Each blaze is a mesh of a
// shared 96-billboard particle geometry (bomb-bloom's `buildFlameParticles`,
// with twice the billboards and a wider plume): all motion runs in the vertex
// shader on `mod(time + offset, life)`, the quad is a radial
// ember->flame->spark gradient in the fragment shader, and the blend is
// additive so fires glow over whatever is behind them. The one deviation is
// sizing: bomb-bloom sized billboards in viewport pixels, while here they are
// world units so a blaze's `mesh.scale` proportions the whole flame (drift,
// sway, rise, and footprint) at once.
import type { Node, UniformNode } from "@random-mesh/rmsl";
import {
  cos,
  float,
  mix,
  mod,
  sin,
  smoothstep,
  vec2,
  vec3,
  vec4,
} from "@random-mesh/rmsl";
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
import { fireAnchor, type ScriptedFire } from "../world/fire-ember";

/** How many billboards make one flame; twice bomb-bloom's own count. */
const FLAME_COUNT = 96;
/** The world-unit height of the base-scale flame, before `mesh.scale`. */
const FLAME_BASE_HEIGHT = 0.27;
/** How wide one ember billboard is, in world units at the base scale. */
const FLAME_BASE_SIZE: [number, number] = [0.08, 0.18];
/** The greatest drift any particle climbs, in world units at the base scale. */
const FLAME_BASE_RISE: [number, number] = [0.08, 0.14];
/**
 * How much wider than tall a plume draws, about twice what reads as natural:
 * the gasa4 kitchen is dark, so the fire is read by its glow as much as by its
 * silhouette, and a wide soft plume reads hotter than a narrow column.
 */
const FLAME_WIDTH = 2.5;
/**
 * How fast the plume animates against wall-clock seconds. Bomb-bloom's flames
 * are small and busy; scaled onto a room-sized fire the same rates race, so the
 * whole shader clock is slowed to read as a lazy kitchen fire.
 */
const FLAME_SPEED = 0.5;

/**
 * The scale that sets a fire of `height` world units on the base flame: the
 * base model drifts to about `FLAME_BASE_HEIGHT`, so scaling by
 * `height / FLAME_BASE_HEIGHT` makes the plume as tall as the fire is drawn.
 */
const scaleForHeight = (height: number): number =>
  Math.max(0.1, height / FLAME_BASE_HEIGHT);

/**
 * One flame's particle geometry in local space around its base: 96 quads of
 * 4 billboard corner vertices, the attributes bomb-bloom baked. Arrays are
 * written once and never touched — the shader does all the animating.
 */
const buildFlameGeometry = (): BufferGeometry => {
  const positions = new Float32Array(FLAME_COUNT * 4 * 3);
  const corners = new Float32Array(FLAME_COUNT * 4 * 2);
  const drifts = new Float32Array(FLAME_COUNT * 4 * 3);
  const lives = new Float32Array(FLAME_COUNT * 4);
  const offsets = new Float32Array(FLAME_COUNT * 4);
  const sizes = new Float32Array(FLAME_COUNT * 4);
  const spins = new Float32Array(FLAME_COUNT * 4);
  const uvs = new Float32Array(FLAME_COUNT * 4 * 2);
  const indices = new Uint16Array(FLAME_COUNT * 6);
  const CORNER: ReadonlyArray<readonly [number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ];
  for (let i = 0; i < FLAME_COUNT; i++) {
    const v0 = i * 4;
    // Spawn jittered around the base plus a personal drift, lifetime, phase
    // offset, billboard size, and spin — bomb-bloom's distribution, with the
    // horizontal spread widened by `FLAME_WIDTH`.
    const px = (Math.random() - 0.5) * 0.012 * FLAME_WIDTH;
    const py = Math.random() * 0.01;
    const pz = (Math.random() - 0.5) * 0.012 * FLAME_WIDTH;
    const driftX = (Math.random() - 0.5) * 0.05 * FLAME_WIDTH;
    const driftY =
      FLAME_BASE_RISE[0] +
      Math.random() * (FLAME_BASE_RISE[1] - FLAME_BASE_RISE[0]);
    const driftZ = (Math.random() - 0.5) * 0.05 * FLAME_WIDTH;
    const life = 0.45 + Math.random() * 0.35;
    const offset = Math.random() * life;
    const size =
      FLAME_BASE_SIZE[0] +
      Math.random() * (FLAME_BASE_SIZE[1] - FLAME_BASE_SIZE[0]);
    const spin = Math.random() * Math.PI * 2;
    for (let j = 0; j < 4; j++) {
      const vi = v0 + j;
      const vs = vi * 3;
      const ct = vi * 2;
      positions[vs] = px;
      positions[vs + 1] = py;
      positions[vs + 2] = pz;
      corners[ct] = CORNER[j][0];
      corners[ct + 1] = CORNER[j][1];
      drifts[vs] = driftX;
      drifts[vs + 1] = driftY;
      drifts[vs + 2] = driftZ;
      lives[vi] = life;
      offsets[vi] = offset;
      sizes[vi] = size;
      spins[vi] = spin;
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
  geometry.setAttribute("spin", new BufferAttribute(spins, 1));
  geometry.setAttribute("uv", new BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  return geometry;
};

/**
 * The additive fire material: bomb-bloom's flame vertex/fragment, billboarded
 * in view space with a world-unit size so the mesh scale proportions a whole
 * blaze. Self-lit, so day-night lighting never dims a flame.
 */
class FireMaterial extends NodeMaterial {
  /** Shader-clock seconds; advances each particle's lifetime mod loop. */
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
    const time = (this.timeUniform ?? float(0)).mul(float(FLAME_SPEED)).toVar();
    const pos = b.attribute("particlePos", "vec3");
    const corner = b.attribute("corner", "vec2");
    const drift = b.attribute("drift", "vec3");
    const life = b.attribute("life", "float");
    const offset = b.attribute("offset", "float");
    const size = b.attribute("size", "float");
    const spin = b.attribute("spin", "float");
    const uv = b.attribute("uv", "vec2");

    // Loop a particle through its lifetime; the fade masks the wrap at both
    // ends (bomb-bloom's windows: fade in over [0, 0.08], out over [0.35, 1]).
    const lifeT = mod(time.add(offset), life).div(life).toVar();
    const fadeIn = smoothstep(float(0), float(0.08), lifeT);
    const fadeOut = float(1).sub(smoothstep(float(0.35), float(1), lifeT));
    const fade = fadeIn.mul(fadeOut).toVar();
    const heat = float(1).sub(lifeT).toVar();

    // Drift plus the swirl, flicker, quadratic rise, and wobble bomb-bloom
    // builds its plume out of; all in local units the mesh scale sizes.
    const base = pos.add(drift.mul(lifeT)).toVar();
    const swirl = sin(
      time
        .mul(float(10))
        .add(spin)
        .add(lifeT.mul(float(12))),
    )
      .mul(float(0.012 * FLAME_WIDTH))
      .mul(float(1).sub(lifeT));
    const flicker = sin(time.mul(float(24)).add(spin)).mul(float(0.004));
    const wobble = cos(
      time
        .mul(float(8))
        .add(spin)
        .add(lifeT.mul(float(10))),
    )
      .mul(float(0.006 * FLAME_WIDTH))
      .mul(float(1).sub(lifeT));
    const animLocal = vec3(
      base.x.add(swirl),
      base.y.add(lifeT.mul(lifeT).mul(float(0.12))).add(flicker),
      base.z.add(wobble),
    ).toVar();

    // The mesh's model matrix scales the plume; the quad itself is billboarded
    // along the camera's right and up axes in view space.
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

    // Radial gradient from the quad's centre: ember at the cool edge, flame
    // toward the core, with a hot spark where the heat is high (bomb-bloom's
    // constants, cut-off to a disc so corners stay transparent).
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

/**
 * Draws the blazes a place script lit, one particle-flame mesh per `ScriptedFire`.
 * The material is shared, so a fire is added, scaled, and positioned by its
 * mesh alone; the set reconciles against the host's fire list every tick, the
 * same way `VoxelFigures` reconciles props.
 */
export class FireFigures {
  /** The scene group the blazes draw in; add it to the world's scene. */
  readonly group = new Group();
  private readonly material = new FireMaterial();
  private readonly geometry = buildFlameGeometry();
  private readonly meshes = new Map<string, Mesh>();
  private time = 0;

  constructor(private readonly fires: () => ScriptedFire[]) {}

  /** Advances the shared flame clock and refills the mesh set from the host. */
  tick(dt: number): void {
    this.time += dt;
    this.material.time = this.time;
    const current = this.fires();
    for (const fire of current) {
      let mesh = this.meshes.get(fire.id);
      if (mesh === undefined) {
        mesh = new Mesh(this.geometry, this.material);
        this.group.add(mesh);
        this.meshes.set(fire.id, mesh);
      }
      const scale = scaleForHeight(fire.height);
      const anchor = fireAnchor(fire);
      mesh.position.set(anchor.x, anchor.y, anchor.z);
      mesh.scale.setScalar(scale);
    }
    for (const [id, mesh] of this.meshes) {
      if (!current.some((fire) => fire.id === id)) {
        this.group.remove(mesh);
        this.meshes.delete(id);
      }
    }
  }

  /** Removes every flame, leaving the set ready for a fresh script. */
  clear(): void {
    for (const mesh of this.meshes.values()) {
      this.group.remove(mesh);
    }
    this.meshes.clear();
  }
}
