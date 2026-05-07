export function buildShared() {
  return {
    live: "ok",
    dead: "stale",
    nested: {
      read: 1,
      stale: 2,
    },
  };
}

export function buildList() {
  return [
    { keep: 1, stale: 2 },
    { keep: 3, stale: 4 },
  ];
}
