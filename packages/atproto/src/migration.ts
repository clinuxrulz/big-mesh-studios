// Reading a record across the shapes it has ever been written in. A custom
// atproto record lives in its owner's own repository, not a database this
// project controls, so a record already published can only ever change if
// its owner republishes it — there is no migration to run over what is
// already out there. The only lever a reader has is interpreting whichever
// version it finds, which is what a chain built here does: one schema per
// version a record has ever been written in, and how each becomes the next.
// A record with no `version` field at all is read as version 0, the shape it
// had before this existed. A chain accepts any Standard Schema-compatible
// validator (this project's own `@atcute/lexicons/validations` builders,
// valibot, or anything else conforming to the interface), rather than tying
// every record's shape to one particular schema library.
import type { StandardSchemaV1 } from "@standard-schema/spec";

interface Step {
  schema: StandardSchemaV1;
  up: (record: unknown) => unknown;
}

/**
 * A chain of a record's versions, from the oldest a reader may still
 * encounter to the shape callers actually want. Build one with
 * `versionedRecord(schema)` and `upgradesTo(schema, up)` for every version
 * since; both schemas are typed, so `up`'s parameter and return type are
 * checked against them.
 */
export interface MigrationChain<Current> {
  upgradesTo<Next>(
    schema: StandardSchemaV1<unknown, Next>,
    up: (record: Current) => Next,
  ): MigrationChain<Next>;
  /**
   * Reads `value` at whichever version its own `version` field names (absent
   * reads as version 0), validates it against that version's own schema, then
   * walks every step from there to reach this chain's latest version. Null
   * when `value` doesn't validate at the version it claims to be, or claims a
   * version this chain doesn't know about.
   */
  parse(value: unknown): Current | null;
}

/** A record's own declared version, or 0 for one written before `version` existed. */
const declaredVersion = (value: unknown): number =>
  typeof value === "object" &&
  value !== null &&
  "version" in value &&
  typeof (value as { version: unknown }).version === "number"
    ? (value as { version: number }).version
    : 0;

/**
 * Runs a schema's validator directly. Every schema this project defines
 * validates synchronously, so a validator that hands back a `Promise`
 * instead — an async refinement, which none of them use — is a programming
 * error worth failing loudly on rather than silently awaiting.
 */
const validate = (
  schema: StandardSchemaV1,
  value: unknown,
): StandardSchemaV1.Result<unknown> => {
  const result = schema["~standard"].validate(value);
  if (result instanceof Promise) {
    throw new Error(
      "versionedRecord only supports schemas that validate synchronously",
    );
  }
  return result;
};

const chainOf = <Current>(
  currentSchema: StandardSchemaV1<unknown, Current>,
  steps: readonly Step[],
): MigrationChain<Current> => ({
  upgradesTo: (schema, up) =>
    chainOf(schema, [
      ...steps,
      {
        schema: currentSchema as StandardSchemaV1,
        up: up as (record: unknown) => unknown,
      },
    ]),
  parse: (value) => {
    const version = declaredVersion(value);
    if (version < 0 || version > steps.length) {
      return null;
    }
    const schema =
      version === steps.length ? currentSchema : steps[version].schema;
    const result = validate(schema, value);
    if (result.issues !== undefined) {
      return null;
    }
    let record: unknown = result.value;
    for (let i = version; i < steps.length; i++) {
      record = steps[i].up(record);
    }
    return record as Current;
  },
});

/** Starts a migration chain at a record's very first shape. See `MigrationChain`. */
export const versionedRecord = <First>(
  schema: StandardSchemaV1<unknown, First>,
): MigrationChain<First> => chainOf(schema, []);
