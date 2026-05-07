function seed(items: number[]): void {
  items.push(1);
}

const items: number[] = [];
seed(items);
console.log(items[0]);
