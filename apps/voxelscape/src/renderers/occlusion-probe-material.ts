// The flat colour pass the hardware occlusion culler draws into its offscreen
// target. One material is shared by every chunk's probes (terrain and water
// get one instance each, differing only in whether they write depth), so the
// whole probe scene compiles exactly two programs whatever the window holds.
// The fragment writes the slot id straight out: no lighting, no texture, no
// fog, so the pixel the readback collects is exactly the chunk that won the
// depth test there.
//
// The id is the same for every vertex a probe mesh draws, so it is a uniform
// the mesh sets before it draws rather than a colour on each of its vertices.
import { mat3, vec4, type Node, type UniformNode } from "@random-mesh/rmsl";
import { Builder, NodeMaterial } from "@random-mesh/rmsl/scene";

/**
 * A material that paints whatever it draws in one slot's packed id. The
 * renderer packs a material's uniforms once per object, so a mesh seats the
 * id it belongs to before each of its draws.
 */
export interface SlotColoured {
  /** The slot id being drawn, packed into three 0..1 channels. */
  slotColor: [number, number, number];
}

export class OcclusionProbeMaterial
  extends NodeMaterial
  implements SlotColoured
{
  slotColor: [number, number, number] = [0, 0, 0];

  private slotColorUniform: UniformNode<"vec3"> | undefined;

  protected setup(b: Builder): void {
    this.slotColorUniform = b.materialUniform(
      "slotColor",
      "vec3",
      () => this.slotColor,
    );
  }

  protected buildVertexBody(b: Builder): Node<"vec4"> {
    const position4 = vec4(b.position, 1);
    const localPosition = b.instancing
      ? b.instanceMatrix.mul(position4)
      : position4;
    const worldPosition = b.modelMatrix.mul(localPosition);
    b.positionWorld.assign(worldPosition.xyz);
    let normal: Node<"vec3"> = b.normal;
    if (b.instancing) {
      normal = mat3(b.instanceMatrix).mul(normal);
    }
    b.normalWorld.assign(b.normalMatrix.mul(normal).normalize());
    b.uvVarying.assign(b.uv);
    if (b.instancingColor) {
      b.instanceColorVarying.assign(b.instanceColor);
    }
    return b.projectionMatrix.mul(b.viewMatrix.mul(worldPosition));
  }

  protected buildFragmentBody(b: Builder): Node<"vec4"> {
    return vec4(
      this.slotColorUniform ??
        b.materialUniform("slotColor", "vec3", () => this.slotColor),
      1,
    );
  }
}
