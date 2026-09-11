// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { versionedRecord } from "./migration";

/**
 * The smallest possible Standard Schema: wraps a plain predicate, so this
 * test exercises `versionedRecord` against the interface itself rather than
 * any one schema library — the same as a real caller could use
 * `@atcute/lexicons/validations`, valibot, or anything else conformant.
 */
const schemaOf = <T>(
  check: (value: unknown) => T | undefined,
): StandardSchemaV1<unknown, T> => ({
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) => {
      const checked = check(value);
      return checked === undefined
        ? { issues: [{ message: "invalid" }] }
        : { value: checked };
    },
  },
});

interface RecordV0 {
  name: string;
}
interface RecordV1 {
  name: string;
  version: 1;
  greeting: string;
}
interface RecordV2 {
  name: string;
  version: 2;
  greeting: string;
  shout: boolean;
}

const V0 = schemaOf<RecordV0>((value) =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Record<string, unknown>).name === "string"
    ? { name: (value as Record<string, unknown>).name as string }
    : undefined,
);

const V1 = schemaOf<RecordV1>((value) => {
  const r = value as Record<string, unknown>;
  return typeof r?.name === "string" &&
    r.version === 1 &&
    typeof r.greeting === "string"
    ? { name: r.name, version: 1, greeting: r.greeting }
    : undefined;
});

const V2 = schemaOf<RecordV2>((value) => {
  const r = value as Record<string, unknown>;
  return typeof r?.name === "string" &&
    r.version === 2 &&
    typeof r.greeting === "string" &&
    typeof r.shout === "boolean"
    ? { name: r.name, version: 2, greeting: r.greeting, shout: r.shout }
    : undefined;
});

const chain = versionedRecord(V0)
  .upgradesTo(V1, (v0) => ({
    ...v0,
    version: 1,
    greeting: `hello, ${v0.name}`,
  }))
  .upgradesTo(V2, (v1) => ({ ...v1, version: 2, shout: false }));

describe("versionedRecord", () => {
  it("reads a record with no version field as version 0, and upgrades it all the way", () => {
    expect(chain.parse({ name: "ada" })).toEqual({
      name: "ada",
      version: 2,
      greeting: "hello, ada",
      shout: false,
    });
  });

  it("starts from whichever version a record already declares, still reaching the latest", () => {
    expect(
      chain.parse({ name: "ada", version: 1, greeting: "hi, ada" }),
    ).toEqual({
      name: "ada",
      version: 2,
      greeting: "hi, ada",
      shout: false,
    });
  });

  it("passes a record already at the latest version straight through", () => {
    const latest = {
      name: "ada",
      version: 2,
      greeting: "hi, ada",
      shout: true,
    };
    expect(chain.parse(latest)).toEqual(latest);
  });

  it("rejects a record that doesn't match the schema of its own declared version", () => {
    expect(chain.parse({ name: "ada", version: 1 })).toBeNull();
    expect(chain.parse({ version: 0 })).toBeNull();
  });

  it("rejects a version newer than this chain knows about", () => {
    expect(chain.parse({ name: "ada", version: 3 })).toBeNull();
  });

  it("rejects non-record values", () => {
    expect(chain.parse(null)).toBeNull();
    expect(chain.parse("ada")).toBeNull();
  });
});
