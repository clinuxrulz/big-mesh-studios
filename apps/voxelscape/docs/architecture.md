# What voxelscape is made of

Drawn from the imports under `src` at 862c3e6 by `pnpm architecture`.
Nothing here is written by hand: change the code and run it again.

```mermaid
graph TD
  shell["shell<br/>5 files · 1387 lines"]
  voxelscape["voxelscape<br/>2 files · 1113 lines"]
  world["world<br/>23 files · 5897 lines"]
  renderers["renderers<br/>12 files · 4207 lines"]
  render["render<br/>4 files · 1004 lines"]
  player["player<br/>15 files · 3207 lines"]
  monsters["monsters<br/>6 files · 1638 lines"]
  multiplayer["multiplayer<br/>13 files · 3109 lines"]
  places["places<br/>15 files · 2307 lines"]
  environment["environment<br/>6 files · 1796 lines"]
  atproto["atproto<br/>8 files · 1303 lines"]
  ui["ui<br/>13 files · 1635 lines"]
  atproto --> monsters
  atproto --> places
  atproto --> world
  monsters --> atproto
  monsters --> environment
  monsters --> multiplayer
  monsters --> world
  multiplayer --> monsters
  multiplayer --> player
  places --> environment
  places --> monsters
  places --> world
  player --> environment
  player --> monsters
  player --> renderers
  player --> shell
  player --> world
  renderers --> environment
  renderers --> render
  renderers --> world
  shell --> atproto
  shell --> environment
  shell --> monsters
  shell --> multiplayer
  shell --> places
  shell --> player
  shell --> render
  shell --> renderers
  shell --> ui
  shell --> voxelscape
  shell --> world
  ui --> places
  ui --> player
  ui --> renderers
  ui --> shell
  ui --> voxelscape
  voxelscape --> atproto
  voxelscape --> environment
  voxelscape --> monsters
  voxelscape --> multiplayer
  voxelscape --> places
  voxelscape --> player
  voxelscape --> render
  voxelscape --> renderers
  voxelscape --> shell
  voxelscape --> world
  world --> render
  world --> renderers
```

## The areas

| area          | what it is for                                                         | files | lines |
| ------------- | ---------------------------------------------------------------------- | ----- | ----- |
| `shell`       | the page, the console, and what wires a world into them                | 5     | 1387  |
| `voxelscape`  | one world: its frame, and every part below it                          | 2     | 1113  |
| `world`       | voxels, light, the streaming window, and the workers that fill it      | 23    | 5897  |
| `renderers`   | turning voxels into geometry, and drawing it                           | 12    | 4207  |
| `render`      | the frame loop, the resolution scaler, and the probe that times them   | 4     | 1004  |
| `player`      | the body, its input, its tools and what they do to the world           | 15    | 3207  |
| `monsters`    | what wanders the world and fights the player                           | 6     | 1638  |
| `multiplayer` | other players, over a peer connection                                  | 13    | 3109  |
| `places`      | a published place: its script, its people, and the sandbox they run in | 15    | 2307  |
| `environment` | the sky, the clock, the weather and the sound                          | 6     | 1796  |
| `atproto`     | being signed in, and reading and writing published records             | 8     | 1303  |
| `ui`          | what is drawn over the world in the page                               | 13    | 1635  |

## What reaches into what

| area          | imports from  | modules doing it |
| ------------- | ------------- | ---------------- |
| `atproto`     | `monsters`    | 1                |
| `atproto`     | `places`      | 1                |
| `atproto`     | `world`       | 2                |
| `monsters`    | `atproto`     | 1                |
| `monsters`    | `environment` | 1                |
| `monsters`    | `multiplayer` | 1                |
| `monsters`    | `world`       | 1                |
| `multiplayer` | `monsters`    | 1                |
| `multiplayer` | `player`      | 1                |
| `places`      | `environment` | 1                |
| `places`      | `monsters`    | 1                |
| `places`      | `world`       | 1                |
| `player`      | `environment` | 1                |
| `player`      | `monsters`    | 2                |
| `player`      | `renderers`   | 1                |
| `player`      | `shell`       | 4                |
| `player`      | `world`       | 7                |
| `renderers`   | `environment` | 1                |
| `renderers`   | `render`      | 2                |
| `renderers`   | `world`       | 5                |
| `shell`       | `atproto`     | 4                |
| `shell`       | `environment` | 2                |
| `shell`       | `monsters`    | 1                |
| `shell`       | `multiplayer` | 2                |
| `shell`       | `places`      | 3                |
| `shell`       | `player`      | 2                |
| `shell`       | `render`      | 2                |
| `shell`       | `renderers`   | 2                |
| `shell`       | `ui`          | 2                |
| `shell`       | `voxelscape`  | 2                |
| `shell`       | `world`       | 3                |
| `ui`          | `places`      | 1                |
| `ui`          | `player`      | 2                |
| `ui`          | `renderers`   | 1                |
| `ui`          | `shell`       | 2                |
| `ui`          | `voxelscape`  | 7                |
| `voxelscape`  | `atproto`     | 1                |
| `voxelscape`  | `environment` | 1                |
| `voxelscape`  | `monsters`    | 1                |
| `voxelscape`  | `multiplayer` | 1                |
| `voxelscape`  | `places`      | 1                |
| `voxelscape`  | `player`      | 1                |
| `voxelscape`  | `render`      | 1                |
| `voxelscape`  | `renderers`   | 1                |
| `voxelscape`  | `shell`       | 1                |
| `voxelscape`  | `world`       | 1                |
| `world`       | `render`      | 2                |
| `world`       | `renderers`   | 5                |

## Areas that reach both ways

- `atproto` and `monsters`
- `monsters` and `multiplayer`
- `player` and `shell`
- `renderers` and `world`
- `shell` and `ui`
- `shell` and `voxelscape`
