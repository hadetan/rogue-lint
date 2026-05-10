function buildSortedPaths(root: string): string[] {
  const result: string[] = [];

  const entries = root === "root"
    ? (["child", "manifest.json"] as const)
    : (["leaf.json"] as const);

  for (const entry of entries) {
    const fullPath = `${root}/${entry}`;
    if (entry === "child") {
      result.push(...buildSortedPaths(fullPath));
      continue;
    }

    result.push(fullPath);
  }

  result.sort();
  return result;
}

const sortedPaths = buildSortedPaths("root");
console.log(sortedPaths.join(","));

function rememberPaths(records: string[][], next: string[]): void {
  records.push(next);
}

const opaqueRecords: string[] = ["live", "dead"];
const retainedRecords: string[][] = [];
rememberPaths(retainedRecords, opaqueRecords);
console.log(opaqueRecords[0].length);
