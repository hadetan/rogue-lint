const fullPath = "src/index.ts";
const extraPath = "src/extra.ts";

const queue: string[] = [];
queue.push(fullPath);
queue.push(extraPath);

console.log(queue[0]);

const item = {
  live: 1,
  dead: 2,
};

const items: Array<typeof item> = [];
items.push(item);

console.log(items[0].live);
