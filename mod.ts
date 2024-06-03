import type {
  APIGroupVersion,
  ArrayType,
  BooleanType,
  Definition,
  DefinitionMeta,
  MapType,
  NumberType,
  OptionalType,
  ObjectType,
  Property,
  ResourceType,
  StringType,
  Type,
  TypeReference,
  UnionType,
  UnknownType,
} from "https://kure.sh/lib/spec@0.1/mod.ts";

import { Context, type Engine, type ImportSource, Module } from "./syntax.ts";

export function emitVersion(schema: APIGroupVersion, engine: Engine): string {
  const { group, version, definitions } = schema;

  const module = new Module(
    (group.module ? `${group.module}/` : "") + `${version}.ts`
  );

  module.add(apiVersion);

  const resource = resourceBase(definitions);
  if (resource != null) module.add(resource);

  for (const definition of definitions) {
    module.add(gen.definition(definition));
  }

  return module.render(new Context(schema, module, engine));
}

type Generator = (module: Module) => (ctx: Context) => string;

const apiVersion: Generator = (module) => {
  const type = module.name("APIVersion");
  const value = module.name("apiVersion");

  return (ctx) =>
    `export type ${type()} = ${lit(ctx.apiVersion)};\n` +
    `export const ${value()}: ${type()} = ${lit(ctx.apiVersion)};`;
};

const resourceBase = (definitions: Definition[]): Generator | null => {
  const resourceDef = definitions.find(
    ({ value }) => value.type === "resource"
  );
  if (resourceDef == null) return null;

  const resource = (resourceDef as Definition<ResourceType>).value;
  const metadata = resource.properties.find(
    ({ name, value }) => name === "metadata" && value.type === "reference"
  );
  if (metadata == null)
    throw new Error(`Resource ${resourceDef.name} has no metadata field`);

  const refType = gen.reference(metadata.value as TypeReference);

  return (module) => {
    const apiVersion = module.get("APIVersion");
    const resource = module.name("Resource");
    const base = module.import(["lib", "schema"], "Resource", { type: true });
    const scope = module.import(["lib", "schema"], "NameScope", { type: true });
    const metadata = refType(module);

    return (ctx) => {
      const api = "`" + ctx.apiVersion + "`";
      const ns = lit("namespace");

      return (
        `/** A {@link ${base()} resource} in the ${api} API. */\n` +
        `export type ${resource!()}<K extends string, S extends ${scope!()} = ${ns}>` +
        ` = ${base!()}<${apiVersion()}, K, S, ${metadata!(ctx)}>;`
      );
    };
  };
};

/** {@link Generator Generators} for all schema types. */
const gen = {
  definition(definition: Definition): Generator {
    if (isDefinition<ResourceType>("resource", definition)) {
      return gen.resource(definition);
    } else if (isDefinition<ObjectType>("object", definition)) {
      return gen.interface(definition);
    } else if (isDefinition<TypeReference>("reference", definition)) {
      const refType = gen.reference(definition.value);

      return (module) => {
        const name =
          definition.name !== definition.value.target.name
            ? module.name(definition.name)
            : null;
        const ref = refType(module);

        return (ctx) => {
          const as = name != null ? ` as ${name()}` : ``;
          return doc(definition) + `export type { ${ref(ctx)}${as} };`;
        };
      };
    } else {
      const valueType = gen.type(definition.value, true);

      return (module) => {
        const name = module.name(definition.name);
        const value = valueType(module);

        return (ctx) =>
          doc(definition) + `export type ${name()} = ${value(ctx)};`;
      };
    }
  },

  resource(definition: Definition<ResourceType>): Generator {
    const { name, value } = definition;

    const metaProperty = value.properties.find((p) => p.name === "metadata");
    if (metaProperty == null || metaProperty.value.type !== "reference")
      throw new Error(`${name}: expected metadata reference property`);

    const objectType = gen.object({
      type: "object",
      properties: definition.value.properties.filter((p) => p !== metaProperty),
    });

    return (module) => {
      const schema: ImportSource = ["lib", "schema"];
      const factoryBase = module.import(schema, "factory");
      const listBase = module.import(schema, "ResourceList", { type: true });

      const apiVersion = module.get("apiVersion");
      const apiResource = module.get("Resource");

      const name = module.name(definition.name);
      const listName = module.name(`${definition.name}List`);
      const object = objectType(module);

      return (ctx) => {
        return [kind(), factory(), list()].join("\n\n");

        function kind(): string {
          const typeParams = [
            lit(name()),
            value.metadata.scope !== "namespace"
              ? lit(value.metadata.scope)
              : null,
          ]
            .filter(Boolean)
            .join(", ");

          return (
            doc(definition) +
            `export interface ${name()} extends ${apiResource()}<${typeParams}> ` +
            object(ctx)
          );
        }

        function factory(): string {
          const args = [
            apiVersion(),
            lit(name()),
            lit(value.metadata.scope),
          ].join(", ");

          return `export const ${name()} = ${factoryBase()}<${name()}>(${args});`;
        }

        function list(): string {
          return `export type ${listName()} = ${listBase()}<${name()}>;`;
        }
      };
    };
  },

  interface(definition: Definition<ObjectType>): Generator {
    const type = definition.value;
    const objectType = gen.type(type, true);
    const parentDefs = type.inherit?.length
      ? type.inherit.map(gen.reference)
      : [];

    return (module) => {
      const name = module.name(definition.name);
      const object = objectType(module);
      const parents = parentDefs.map((def) => def(module));

      return (ctx) => {
        const extend = parents.length
          ? ` extends ${parents.map((parent) => parent(ctx)).join(", ")}`
          : "";

        return (
          doc(definition) + `export interface ${name()}${extend} ${object(ctx)}`
        );
      };
    };
  },

  type(type: Type, declaration = false): Generator {
    switch (type.type) {
      case "string":
        return gen.string(type);
      case "integer":
      case "float":
        return gen.number(type);
      case "boolean":
        return gen.boolean(type);
      case "array":
        return gen.array(type);
      case "map":
        return gen.map(type);
      case "object":
        return gen.object(type, declaration);
      case "union":
        return gen.union(type);
      case "optional":
        return gen.optional(type);
      case "reference":
        return gen.reference(type);
      case "unknown":
        return gen.unknown(type);
      case "resource":
        throw new Error('"resource" type not allowed in gen.type()');
    }
  },

  object(type: ObjectType, declaration = false): Generator {
    const parentDefs =
      type.inherit?.length && !declaration
        ? type.inherit.map(gen.reference)
        : [];
    const propertyDefs = type.properties.map(gen.property);

    return (module) => {
      const parents = parentDefs.map((def) => def(module));
      const properties = propertyDefs.map((def) => def(module));

      return (ctx) =>
        parents.map((parent) => parent(ctx)).join(" & ") +
        `{\n${properties.map((prop) => prop(ctx)).join("\n")}\n}`;
    };
  },

  property(property: Property): Generator {
    const name = /^[A-Za-z]\w*$/.test(property.name)
      ? property.name
      : JSON.stringify(property.name);
    const optional = property.required ? "" : "?";

    const valueType = gen.type(property.value);

    return (module) => {
      const value = valueType(module);
      return (ctx) => `${doc(property, 1)}  ${name}${optional}: ${value(ctx)};`;
    };
  },

  reference(ref: TypeReference): Generator {
    const { scope, name } = ref.target;

    if (scope == null) {
      // local module reference
      return (module) => module.get(name);
    }

    const path =
      (scope.group.module ? `${scope.group.module}/` : "") +
      `${scope.version}.ts`;
    const src: ImportSource = scope.package
      ? ["api", scope.package, path]
      : ["local", path];

    return (module) => module.import(src, name, { type: true });
  },

  array(type: ArrayType): Generator {
    const valueType = gen.type(type.values);

    return (module) => {
      const value = valueType(module);
      return (ctx) => `Array<${value(ctx)}>`;
    };
  },

  map(type: MapType): Generator {
    const valueType = gen.type(type.values);

    return (module) => {
      const value = valueType(module);
      return (ctx) => `Record<string, ${value(ctx)}>`;
    };
  },

  union(type: UnionType): Generator {
    const valueTypes = type.values.map((value) => gen.type(value));

    return (module) => {
      const values = valueTypes.map((value) => value(module));
      return (ctx) => values.map((value) => value(ctx)).join(" | ");
    };
  },

  optional(type: OptionalType): Generator {
    const valueType = gen.type(type.value);

    return (module) => {
      const value = valueType(module);
      return (ctx) => `${value(ctx)} | null`;
    };
  },

  string(type: StringType): Generator {
    return () => () =>
      type.enum
        ? type.enum.map((value) => JSON.stringify(value)).join(" | ")
        : "string";
  },

  number(_type: NumberType): Generator {
    return () => () => `number`;
  },

  boolean(_type: BooleanType): Generator {
    return () => () => `boolean`;
  },

  unknown(_type: UnknownType): Generator {
    return () => () => `unknown`;
  },
};

function isDefinition<T extends Type>(
  kind: T["type"],
  def: Definition
): def is Definition<T> {
  return isType(kind, def.value);
}

function isType<T extends Type>(kind: T["type"], type: Type): type is T {
  return type.type === kind;
}

function doc({ description, deprecated }: DefinitionMeta, indent = 0): string {
  const lines = description ? description.trimEnd().split("\n") : [];
  if (deprecated) lines.push("@deprecated");

  if (!lines.length) return "";

  const prefix = "  ".repeat(indent);

  return (
    `${prefix}/**\n` +
    lines
      .map((line) => `${prefix} * ${line.replaceAll("*/", "*\\/")}\n`)
      .join("") +
    `${prefix} */\n`
  );
}

function lit(value: string | number | boolean): string {
  return JSON.stringify(value);
}
