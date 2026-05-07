const item = {
  live: 1,
  dead: 2,
};

const queue: Array<typeof item> = [];
queue.push(item);
console.log(queue[0].live);

const first = {
  keep: 3,
  stale: 4,
};

const front: Array<typeof first> = [];
front.unshift(first);
console.log(front[0].keep);

const unreadValue = {
  stale: 5,
};

const unread: Array<typeof unreadValue> = [];
unread.push(unreadValue);

const numbers = [1, 2, 3];
numbers.slice(1);
structuredClone(numbers);

const copied = numbers.concat([4]);
console.log(copied.length);

const info = {
  keep: 1,
  stale: 2,
};

const assigned = Object.assign({}, info);
console.log(assigned.keep);

const merged = { ...info };
console.log(merged.keep);

const spread = [...numbers];
console.log(spread.length);
