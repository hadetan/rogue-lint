type Row = {
  live?: number;
  dead?: number;
  stale?: number;
  safe?: {
    keep: number;
    stale?: number;
  };
};

let maybeInit: number;
console.log(maybeInit);
maybeInit = 1;

let ignored: number;
// dead-lint-ignore-next
console.log(ignored);
ignored = 1;

const reordered: Row[] = [{ live: 1 }, { stale: 2 }];
reordered.shift();
console.log(reordered[1].stale);

const replaced: Row[] = [{ live: 1 }, { dead: 2 }];
replaced[1] = { live: 3 };
console.log(replaced[1].dead);

const appended: Row[] = [
  { safe: { keep: 1, stale: 2 } },
  { safe: { keep: 3, stale: 4 } },
];
appended.push({ safe: { keep: 5, stale: 6 } });
console.log(appended[0].safe?.keep);
console.log(appended[1].safe?.keep);

const escaped: Row[] = [{ dead: 1 }];
JSON.stringify(escaped);
console.log(escaped[0].dead);
