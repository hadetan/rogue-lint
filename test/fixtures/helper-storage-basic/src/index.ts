type CollectionInfo = {
  childPaths: number[][];
};

const collections = new Map<string, CollectionInfo>();

function setCollectionInfo(childPaths: number[][]): void {
  collections.set("x", { childPaths });
}

const fullPath = [1];
const childPaths: number[][] = [];
setCollectionInfo(childPaths);
childPaths.push(fullPath);
console.log(fullPath.length);
console.log(collections.size);
