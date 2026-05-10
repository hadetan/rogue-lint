type Segment = {
  label: string;
};

function createSegment(label: string): Segment {
  return { label };
}

function buildProjectedSegments(): Segment[] | undefined {
  const projectedSegments: Segment[] = [];
  const seen = new Set<string>();

  for (const label of ["live", "stale"] as const) {
    const segment = createSegment(label);
    if (seen.has(segment.label)) {
      continue;
    }

    seen.add(segment.label);
    projectedSegments.push(segment);
  }

  return projectedSegments.length > 1 ? projectedSegments : undefined;
}

function wrapProjectedSegments() {
  return buildProjectedSegments()?.map((segment) => [segment].length) ?? [];
}

const wrapped = wrapProjectedSegments();
console.log(wrapped.length);

function buildSelectiveSegments(): Segment[] {
  const selectiveSegments: Segment[] = [];
  const keep = createSegment("keep");
  const dead = createSegment("dead");

  selectiveSegments.push(keep);
  selectiveSegments.push(dead);

  return selectiveSegments;
}

const selectiveSegments = buildSelectiveSegments();
console.log(selectiveSegments[0].label);
