import {
  atlasGridOf,
  buildVoxelTileConfig,
  loadTileTexture,
  parseTileAtlasXml,
  type VoxelTiles,
} from "./atlas";
import type { TriangleRenderer } from "./triangle-renderer";

// Served from the site's own root, the same folder every other address in
// this application is built from (see `vite.config.ts`'s `base`).
const TILE_URL = `${import.meta.env.BASE_URL}spritesheets/spritesheet_tiles.png`;
const XML_URL = `${import.meta.env.BASE_URL}spritesheets/spritesheet_tiles.xml`;

export interface LoadVoxelTilesOptions {
  tileUrl?: string;
  xmlUrl?: string;
  customVoxelTiles?: Record<number, VoxelTiles>;
}

/**
 * Loads the tile spritesheet (one 2D GPU texture) plus its atlas XML, and
 * applies the resulting per-voxel tile config to `renderer`. Failures
 * are logged and swallowed — voxels stay flat blue rather than blocking
 * startup.
 */
export const loadVoxelTiles = async (
  renderer: TriangleRenderer,
  options?: LoadVoxelTilesOptions,
): Promise<void> => {
  const tileUrl = options?.tileUrl ?? TILE_URL;
  const xmlUrl = options?.xmlUrl ?? XML_URL;
  try {
    const [loaded, xmlRes] = await Promise.all([
      loadTileTexture(tileUrl),
      fetch(xmlUrl),
    ]);
    if (!xmlRes.ok) {
      throw new Error(`failed to load "${xmlUrl}": ${xmlRes.status}`);
    }
    const atlas = parseTileAtlasXml(await xmlRes.text());
    const grid = atlasGridOf(atlas, loaded.width, loaded.height);
    if (grid === null) {
      throw new Error(
        "[atlas] the sheet's tiles are not one size on a grid, which is the only layout a tile index can name",
      );
    }
    const voxelTiles = buildVoxelTileConfig(
      atlas,
      grid,
      options?.customVoxelTiles,
    );
    renderer.setTiles(voxelTiles, loaded.texture, grid);
  } catch (err) {
    console.warn(
      "[atlas] spritesheet not applied; voxels stay flat blue.",
      err,
    );
  }
};
