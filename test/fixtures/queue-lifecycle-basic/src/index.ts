type Task = {
  live: number;
  dead: number;
};

const queue: Task[] = [];
const task = {
  live: 1,
  dead: 2,
};

queue.push(task);

const next = queue.shift();
if (!next) {
  throw new Error("missing task");
}

console.log(next.live);