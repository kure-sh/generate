import type { API, APIGroup, APIGroupVersion } from "@kure/spec";
import { parseArgs } from "@std/cli/parse-args";
import { join } from "@std/path";

import { generateVersion } from "./mod.ts";
import type { Packaging } from "./syntax.ts";
import { dirname } from "jsr:@std/path@^0.225.2/posix/dirname";
import { basename } from "jsr:@std/path@^0.225.2/posix/basename";

async function main(argv = Deno.args) {
  const {
    _: args,
    package: pkg,
    write,
  } = parseArgs(argv, {
    boolean: ["write"],
    default: { package: "jsr" },
    string: ["package"],
    alias: { p: "package", w: "write" },
  });

  if (!isPackaging(pkg)) {
    throw new Error(`Unknown packaging system ${JSON.stringify(pkg)}`);
  }

  for (const source of args) {
    await emit(`${source}`, { packaging: pkg, write });
  }
}

/**
 * Emit `.d.ts` files for every {@link APIGroupVersion API version} in a
 * directory, and a `deno.json` or `package.json` file.
 */
async function emit(source: string, options: EmitOptions) {
  const { isDirectory } = await Deno.stat(source);

  if (isDirectory) {
    await visit(source, "index.json", options);
  } else {
    await visit(dirname(source), basename(source), options);
  }
}

async function visit(root: string, filename: string, options: EmitOptions) {
  const path = join(root, filename);
  const contents = JSON.parse(await Deno.readTextFile(path));

  console.log(filename);

  if (isAPI(contents)) {
    for (const group of contents.groups) {
      const target =
        group.module != null ? join(group.module, "group.json") : "group.json";
      await visit(root, target, options);
    }
  } else if (isAPIGroup(contents)) {
    for (const version of contents.versions) {
      await visit(root, join(dirname(filename), `${version}.json`), options);
    }
  } else if (isAPIVersion(contents)) {
    await emitVersion(path, contents, options);
  }
}

/**
 * Emit a `.d.ts` file for an {@link APIGroupVersion API version}.
 */
async function emitVersion(
  path: string,
  schema: APIGroupVersion,
  { packaging, write }: EmitOptions
) {
  const generated = generateVersion(schema, packaging);
  if (write) {
    await Deno.writeTextFile(path.replace(/[.]json$/, ".ts"), generated);
  } else {
    console.log(generated);
  }
}

/** Options for {@link emit} and {@link emitFile}. */
export interface EmitOptions {
  /** The packaging system to generate. */
  packaging: Packaging;

  /** Write files to disk. */
  write: boolean;
}

function isAPI(value: unknown): value is API {
  return (
    value != null &&
    typeof value === "object" &&
    (value as API).apiVersion == "spec.kure.sh/v1alpha1" &&
    (value as API).kind === "API"
  );
}

function isAPIGroup(value: unknown): value is APIGroup {
  return (
    value != null &&
    typeof value === "object" &&
    (value as APIGroup).apiVersion == "spec.kure.sh/v1alpha1" &&
    (value as APIGroup).kind === "APIGroup"
  );
}

function isAPIVersion(value: unknown): value is APIGroupVersion {
  return (
    value != null &&
    typeof value === "object" &&
    (value as APIGroupVersion).apiVersion == "spec.kure.sh/v1alpha1" &&
    (value as APIGroupVersion).kind === "APIGroupVersion"
  );
}

function isPackaging(value: unknown): value is Packaging {
  return typeof value === "string" && packagingSystems.has(value);
}

const packagingSystems: Set<string> = new Set<Packaging>([
  "jsr",
  "npm",
  "kure.sh",
]);

await main();
