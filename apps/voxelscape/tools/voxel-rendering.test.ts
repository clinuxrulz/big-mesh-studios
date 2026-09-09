// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  constantsOf,
  framePhases,
  messageKinds,
  pathEdges,
  problemsWith,
  drawingOf,
  vertexAttributes,
} from "./voxel-rendering";

describe("what a vertex carries", () => {
  it("reads the attributes the mesher actually sets", () => {
    expect(vertexAttributes()).toEqual([
      { name: "position", elements: 3 },
      { name: "normal", elements: 3 },
      { name: "uv", elements: 2 },
      { name: "tileIndex", elements: 1 },
      { name: "brightness", elements: 1 },
    ]);
  });

  it("adds up to what the upload budget spends against", () => {
    // The budget paces a frame's uploads against `VERTEX_UPLOAD_BYTES`. An
    // attribute added without changing it makes every estimate wrong by four
    // bytes a vertex, which is the kind of quiet error nothing else here would
    // catch.
    const summed = vertexAttributes().reduce(
      (sum, attribute) => sum + attribute.elements * 4,
      0,
    );
    const declared = Number(
      constantsOf("renderers/triangle-renderer.ts", ["VERTEX_UPLOAD_BYTES"])[0]
        .value,
    );
    expect(summed).toBe(declared);
  });
});

describe("constantsOf", () => {
  it("reads a value as it is written, and the sentence above it", () => {
    const [upload] = constantsOf("renderers/triangle-renderer.ts", [
      "MAX_UPLOAD_BYTES_PER_FRAME",
    ]);
    expect(upload.value).toBe("2 * 1024 * 1024");
    expect(upload.says).toMatch(/bytes of merged geometry one frame/);
  });
});

describe("framePhases", () => {
  it("reads the frame's stages in the order the probe times them", () => {
    const phases = framePhases();
    expect(phases[0]).toBe("player");
    expect(phases.at(-1)).toBe("draw");
    expect(phases).toContain("merge");
  });
});

describe("messageKinds", () => {
  it("finds every kind the world's workers speak", () => {
    expect(messageKinds().map((message) => message.kind)).toEqual([
      "config",
      "fill",
      "fillMesh",
      "mesh",
    ]);
  });
});

describe("pathEdges", () => {
  it("joins the path's own modules and nothing outside it", () => {
    const edges = pathEdges();
    expect(edges).toContainEqual({
      from: "renderers/mesh.ts",
      to: "renderers/plane-merge.ts",
    });
    for (const edge of edges) {
      expect(edge.from).not.toBe(edge.to);
    }
  });
});

describe("the drawing", () => {
  it("holds nothing against the code as it stands", () => {
    expect(problemsWith(drawingOf(), drawingOf())).toEqual([]);
  });
});
