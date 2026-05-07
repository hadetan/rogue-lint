const rows = [
  { live: 1, dead: 2 },
  { live: 3, dead: 4 },
];

function rowsMatch(items: typeof rows) {
  return items.every((item, index) => item.live === items[index].live);
}

console.log(rowsMatch(rows));
