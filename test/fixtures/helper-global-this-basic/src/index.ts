declare global {
  var savedItems: number[] | undefined;
}

function remember(items: number[]): void {
  globalThis.savedItems = items;
}

const items = [1, 2];
remember(items);
if (globalThis.savedItems) {
  console.log(globalThis.savedItems[0]);
}

export {};
