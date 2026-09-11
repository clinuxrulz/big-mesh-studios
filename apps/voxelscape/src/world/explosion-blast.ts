// A blast a place script sets off. Like a scripted fire it is scenery the
// script lights rather than a player edit, so the record lives in the world
// area where the host that reports it and the renderer that draws it can name
// it without either reaching into the other.

/**
 * One blast: where it went off, how wide it reads, and the moment on the shared
 * clock it did. The moment lets a renderer age each burst and re-light a blast
 * whose id is dispatched again.
 */
export interface ScriptedExplosion {
  id: string;
  /** The blast's centre, in world units. */
  x: number;
  y: number;
  z: number;
  /** How wide the blast reads, in world units. */
  radius: number;
  /** The shared-clock moment the blast went off, in milliseconds. */
  at: number;
}
