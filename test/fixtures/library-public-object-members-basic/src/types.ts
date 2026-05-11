type Factory = () => { kind: string };

function create(kind: string): Factory {
  return () => ({ kind });
}

const privateHelpers = {
  dead: create("dead"),
};

export const coerce = {
  string: create("string"),
  number: create("number"),
  boolean: create("boolean"),
  bigint: create("bigint"),
  date: create("date"),
};