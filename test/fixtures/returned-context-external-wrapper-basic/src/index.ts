type ExternalContext = {
  registry: Map<string, string>;
  uri: string;
  defs: Record<string, string>;
};

type Context = {
  seen: Map<string, boolean>;
  external?: ExternalContext;
};

function initializeContext(): Context {
  return {
    seen: new Map(),
  };
}

function toJSONSchema() {
  const ctx = initializeContext();
  const external = {
    registry: new Map([["User", "schema"]]),
    uri: "schema://root",
    defs: {
      User: "object",
    },
  };

  ctx.external = external;

  return {
    ctx,
    schemas: ["User"],
  };
}

const result = toJSONSchema();

console.log(result.ctx.external?.registry.get("User"));
console.log(result.ctx.external?.uri);
console.log(result.ctx.external?.defs.User);
console.log(result.schemas[0]);
