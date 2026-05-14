type LeafPresentation = {
  label: string;
  location: string;
  dead: string;
};

function createLeafPresentation(name: string): LeafPresentation {
  return {
    label: name,
    location: `${name}.ts`,
    dead: "dead",
  };
}

function createUpperLeafPresentation(name: string): LeafPresentation {
  return {
    label: name.toUpperCase(),
    location: `${name}.UPPER.ts`,
    dead: "upper-dead",
  };
}

function renderGrouped<T>(
  records: T[],
  createLeaf: (record: T) => LeafPresentation,
  fallback: (record: T) => LeafPresentation,
  useFallback: boolean,
): void {
  const selected = useFallback ? fallback : createLeaf;
  const leaves = records.map((record) => selected(record));

  for (const leaf of leaves) {
    console.log(leaf.label);
  }
}

renderGrouped(["first", "second"], createLeafPresentation, createUpperLeafPresentation, Math.random() > 0.5);
