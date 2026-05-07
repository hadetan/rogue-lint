let saved!: number[];

function remember(items: number[]): void {
  saved = items;
}

const items = [1, 2];
remember(items);
console.log(saved[0]);
