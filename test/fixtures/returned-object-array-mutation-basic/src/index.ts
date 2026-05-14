function buildContainer(label: string) {
  return {
    label,
    items: [],
  };
}

const first = buildContainer("first");
first.items.push(1);

const second = buildContainer("second");
console.log(second.items.length);
