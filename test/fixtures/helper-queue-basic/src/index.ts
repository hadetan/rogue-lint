function rotate(queue: number[]): void {
  const next = queue.shift();
  if (next !== undefined) {
    queue.push(next + 1);
  }
}

const queue = [1, 2];
rotate(queue);
console.log(queue[0]);
