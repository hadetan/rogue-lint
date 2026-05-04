interface Shape {
  used: string;
  stale?: number;
}

const config = {
  safe: {
    read: 1,
    stale: 2
  },
  forwarded: {
    keep: 1,
    stale: 2
  },
  escaped: {
    maybe: 1
  }
};

const alias = config.safe;
console.log(alias.read);

function consumeForwarded(input: { keep: number }): void {
  console.log(input.keep);
}

consumeForwarded(config.forwarded);
Object.keys(config.escaped);

const value: Shape = {
  used: "ok"
};

console.log(value.used);
