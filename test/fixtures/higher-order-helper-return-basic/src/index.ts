type LeafPresentation = {
  label: string;
  location: string;
  reason: string;
  dead: string;
};

function createLeafPresentation(name: string): LeafPresentation {
  return {
    label: name,
    location: `${name}.ts`,
    reason: `Reason: ${name}`,
    dead: "dead",
  };
}

function compareLeaf(left: LeafPresentation, right: LeafPresentation): number {
  const byLocation = left.location.localeCompare(right.location);
  if (byLocation !== 0) {
    return byLocation;
  }

  return `${left.label} ${left.reason}`.localeCompare(`${right.label} ${right.reason}`);
}

function renderLeaf(leaf: LeafPresentation): void {
  console.log(leaf.label);
  console.log(leaf.location);
  console.log(leaf.reason);
}

function renderGrouped<T>(records: T[], createLeaf: (record: T) => LeafPresentation): void {
  const leaves = records
    .map((record) => createLeaf(record))
    .sort(compareLeaf);

  for (const leaf of leaves) {
    renderLeaf(leaf);
  }
}

renderGrouped(["first", "second"], createLeafPresentation);
