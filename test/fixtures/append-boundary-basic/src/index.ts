declare function getValues(): number[];

const sink = [0];

sink.push(...getValues());

console.log(sink[0]);
