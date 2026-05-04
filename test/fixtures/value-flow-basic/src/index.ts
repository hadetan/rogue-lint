let count = 1;
count = 2;
console.log(count);

let helperRead = 1;
consume(helperRead);
helperRead = 2;
console.log(helperRead);

let helperIgnored = 1;
ignore(helperIgnored);
helperIgnored = 2;
console.log(helperIgnored);

let externalRead = 1;
Math.max(externalRead, 2);
externalRead = 3;
console.log(externalRead);

let status = 0;

function update(): void {
  status = 1;
}

update();

1 + 2;

let escaped = 1;
consume(escaped);

function consume(value: number): void {
  console.log(value);
}

function ignore(_value: number): void {}
