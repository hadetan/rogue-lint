function touchState(state: { items: string[] }) {
  state.items.push("next");
  return state.items.length;
}

const state: { items: string[] } = { items: [] };
touchState(state);

const rows = [1, 2];
rows.slice();

function makeSegment(value: string) {
  return {
    kind: "property",
    value,
    label: "segment",
  };
}

const segment = makeSegment("user");
console.log(segment.kind);
console.log(segment.value);

function createStateHolder(): { findings: string[]; diagnostics: string[]; path: string } {
  return {
    findings: [],
    diagnostics: [],
    path: "src/index.ts",
  };
}

const holder = createStateHolder();
holder.findings.push("kept");
holder.diagnostics.push("warn");
