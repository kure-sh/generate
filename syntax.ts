import {
  basename,
  dirname,
  relative,
} from "https://deno.land/std@0.224.0/path/posix/mod.ts";

import type {
  APIDependency,
  APIGroupIdentifier,
  APIGroupVersion,
} from "https://kure.sh/lib/spec@0.1/mod.ts";

export interface Generator {
  apply(module: Module): void;
  render(ctx: Context): string;
}

export class Context {
  public readonly group: APIGroupIdentifier;
  public readonly version: string;
  public readonly dependencies: Map<string, APIDependency>;
  public readonly module: Module;
  public readonly engine: Engine;

  constructor(
    { group, version, dependencies }: APIGroupVersion,
    module: Module,
    engine: Engine
  ) {
    this.group = group;
    this.version = version;
    this.dependencies = new Map(dependencies.map((dep) => [dep.package, dep]));
    this.module = module;
    this.engine = engine;
  }

  get apiVersion(): string {
    const { group, version } = this;
    return group.name ? `${group.name}/${version}` : version;
  }
}

export class Module implements Pick<Generator, "render"> {
  public readonly path: string;
  public readonly names: Names;
  public readonly imports: Imports;

  private readonly members: Generator[];

  constructor(path: string) {
    this.path = path;
    this.names = new Names();
    this.imports = new Imports();
    this.members = [];
  }

  add(member: Generator | ((module: Module) => (ctx: Context) => string)) {
    const generator =
      typeof member === "function" ? new ClosureGenerator(member) : member;

    this.members.push(generator);
  }

  name(name: string, usage: NameUsage = "declaration"): Binding {
    return this.names.add(name, usage).binding;
  }

  get(name: string): Binding {
    return () => this.names.getDeclared(name).token();
  }

  import(src: ImportSource, name: string, options?: ImportOptions): Binding {
    return this.imports.use(src, name, options).binding;
  }

  render(ctx: Context): string {
    for (const generator of [...this.members, this.imports]) {
      generator.apply(this);
    }

    this.names.resolve();

    const source: string[] = [];
    for (const generator of [this.imports, ...this.members]) {
      source.push(generator.render(ctx));
    }

    return source.filter(Boolean).join("\n\n");
  }
}

export type Engine = "deno" | "node";

export type ModuleURN = `kure:${"api" | "lib"}:${string}` | `/${string}`;

export type ImportSource =
  | [type: "api", name: string, path?: string]
  | [type: "lib", name: string, path?: string]
  | [type: "local", path: string];

class Imports implements Generator {
  private modules: Map<ModuleURN, ImportedModule> = new Map();

  use(src: ImportSource, name: string, options?: ImportOptions): Import {
    const { members } = this.module(src);
    let member = members.get(name);

    if (member == null) {
      member = new Import(name, options);
      members.set(name, member);
    } else if (options != null) {
      if (member.type && !options.type) member.type = false;
      if (!member.as && options.as) member.as = options.as;
    }

    return member;
  }

  apply(module: Module): void {
    for (const imported of this.modules.values()) {
      for (const imp of imported.members.values()) {
        imp.apply(module);
      }
    }
  }

  render(ctx: Context): string {
    const paths: Map<ModuleURN, string> = new Map();
    const remote: ModuleURN[] = [];
    const local: ModuleURN[] = [];

    for (const [urn, { src }] of this.modules) {
      paths.set(urn, this.path(src, ctx));

      if (src[0] === "local") {
        local.push(urn);
      } else {
        remote.push(urn);
      }
    }

    const groups = [remote, local]
      .filter((group) => group.length > 0)
      .map((group) =>
        group.sort((a, b) => paths.get(a)!.localeCompare(paths.get(b)!))
      );

    const renderGroup = (urns: ModuleURN[]) =>
      urns.map(renderImport).join("\n");

    const renderImport = (urn: ModuleURN) => {
      const path = paths.get(urn)!;
      const imports = [...this.modules.get(urn)!.members.values()].sort(
        (a, b) => a.member.localeCompare(b.member)
      );

      const statement = imports.every((i) => i.type)
        ? `import type { ${imports.map((i) => i.render(true)).join(", ")} }`
        : `import { ${imports.map((i) => i.render()).join(", ")} }`;

      return `${statement} from ${JSON.stringify(path)};`;
    };

    return groups.map(renderGroup).join("\n\n");
  }

  private module(src: ImportSource): ImportedModule {
    const urn = Import.urn(src);
    let mod = this.modules.get(urn);

    if (mod == null) {
      mod = { src, members: new Map() };
      this.modules.set(urn, mod);
    }

    return mod;
  }

  private path(
    src: ImportSource,
    { module, engine, dependencies }: Context
  ): string {
    const local = `/src/${dirname(module.path)}`;

    if (src[0] === "local") {
      const dest = `/src/${src[1]}`;
      let dir = relative(local, dirname(dest)) || ".";
      if (!dir.startsWith(".")) dir = `./${dir}`;

      return `${dir}/${basename(dest)}`;
    } else {
      let [type, pkg, path] = src;

      if (engine === "deno") {
        const version = type === "api" ? dependencies.get(pkg)?.version : "0.1";
        if (pkg === "kubernetes" && version) pkg = "";

        const target = `${pkg}${version ? `@${version}` : ""}`;

        return `https://kure.sh/${type}/${target}/${path || "mod.ts"}`;
      } else if (engine === "node") {
        return (
          `@kure-${type}/${pkg.replaceAll("/", "-")}` + (path ? `/${path}` : "")
        );
      }
    }

    throw new Error("unreachable");
  }
}

interface ImportedModule {
  src: ImportSource;
  members: Map<string, Import>;
}

class Import {
  public readonly member: string;
  public as?: string;
  public type: boolean;
  private name?: Name;

  constructor(member: string, options?: ImportOptions) {
    this.member = member;
    this.as = options?.as || undefined;
    this.type = options?.type ?? false;
  }

  apply(module: Module): void {
    this.name = module.names.add(this.as ?? this.member, "import");
  }

  token(): string {
    if (this.name == null)
      throw new Error(`import of ${this.member} not yet named`);

    return this.name.token();
  }

  render(inTypeImport = false) {
    if (inTypeImport && !this.type)
      throw new Error(`cannot import value ${this.member} via \`import type\``);

    const name = this.token();
    const aliased = name !== this.member;
    const type = this.type && !inTypeImport;

    return (
      (type ? "type " : "") + (aliased ? `${this.member} as ${name}` : name)
    );
  }

  get binding(): Binding {
    return this.token.bind(this);
  }

  static urn(source: ImportSource): ModuleURN {
    if (source[0] === "api" || source[0] === "lib") {
      return ["kure", ...source].join(":") as ModuleURN;
    } else if (source[0] === "local") {
      return `/${source[1]}`;
    }

    throw new Error("unreachable");
  }
}

class Names {
  private readonly bound: Map<string, Name[]> = new Map();

  add(token: string, usage: NameUsage): Name {
    const names = this.token(token);

    if (names.some((name) => name.isConflict(usage))) {
      throw new Error(`Duplicate ${usage} of ${token}`);
    }

    const name = new Name(token, usage);
    names.push(name);

    return name;
  }

  getDeclared(token: string): Name {
    const names = this.bound.get(token);
    const name = names?.find((name) => name.usage === "declaration");

    if (name == null) throw new Error(`name ${name} not declared in module`);

    return name;
  }

  resolve() {
    for (const [identifier, names] of this.bound) {
      names.sort((a, b) => a.weight - b.weight);

      for (const [i, name] of names.entries()) {
        name.resolve(
          i === 0 ? null : i === 1 ? `${identifier}_` : `${identifier}_${i}`
        );
      }
    }
  }

  private token(name: string): Name[] {
    let names = this.bound.get(name);

    if (names == null) {
      names = [];
      this.bound.set(name, names);
    }

    return names;
  }
}

class Name {
  public readonly declared: string;
  public readonly usage: NameUsage;
  private resolved: string | null;

  constructor(declared: string, usage: NameUsage) {
    this.declared = declared;
    this.usage = usage;
    this.resolved = null;
  }

  get binding(): Binding {
    return this.token.bind(this);
  }

  get weight(): number {
    return Name.usages[this.usage];
  }

  isConflict(usage: NameUsage) {
    return this.usage === "declaration" && usage === "declaration";
  }

  resolve(as: string | null) {
    this.resolved = as ?? this.declared;
  }

  token(): string {
    if (this.resolved == null)
      throw new Error(`Name ${this.declared} not yet resolved`);

    return this.resolved;
  }

  private static readonly usages = {
    declaration: 0,
    import: 1,
  };
}

type NameUsage = keyof (typeof Name)["usages"];

type Binding = () => string;

type ImportOptions = Partial<Pick<Import, "as" | "type">>;

class ClosureGenerator implements Generator {
  constructor(
    private readonly impl: (module: Module) => (ctx: Context) => string
  ) {}

  apply(module: Module): void {
    this.render = this.impl(module);
  }

  render(_ctx: Context): string {
    throw new Error("apply() was not called");
  }
}
