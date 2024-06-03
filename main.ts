import { parse } from "https://deno.land/std@0.224.0/flags/mod.ts";
import { walk } from "https://deno.land/std@0.224.0/fs/walk.ts";
import { APIGroupVersion } from "../spec/mod.ts";

import { emitVersion } from "./mod.ts";

async function main(argv = Deno.args) {
  const { _: args, write }: { _: string[]; write: boolean } = parse(argv, {
    boolean: ["write"],
  });

  for (const source of args) {
    await emit(source, write);
  }
}

async function emit(source: string, write: boolean) {
  const { isDirectory } = await Deno.stat(source);

  if (isDirectory) {
    for await (const entry of walk(source, {
      includeDirs: false,
      exts: [".json"],
    })) {
      await emitFile(entry.path, write);
    }
  } else {
    await emitFile(source, write);
  }
}

async function emitFile(source: string, write: boolean) {
  const contents = JSON.parse(await Deno.readTextFile(source));
  if (!isAPIVersion(contents)) return;

  const generated = emitVersion(contents, "deno");
  if (write) {
    await Deno.writeTextFile(source.replace(/[.]json$/, ".ts"), generated);
  } else {
    console.log(generated);
  }
}

function isAPIVersion(value: unknown): value is APIGroupVersion {
  return (
    value != null &&
    typeof value === "object" &&
    (value as APIGroupVersion).apiVersion == "spec.kure.sh/v1alpha1" &&
    (value as APIGroupVersion).kind === "APIGroupVersion"
  );
}

await main();
