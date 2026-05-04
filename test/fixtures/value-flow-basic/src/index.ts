let count = 1;
count = 2;
console.log(count);

let status = 0;

function update(): void {
  status = 1;
}

update();

1 + 2;

let escaped = 1;
opaque(escaped);

function opaque(value: number): void {
  console.log(value);
}
