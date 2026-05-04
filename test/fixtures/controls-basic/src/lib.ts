export const usedExport = 1;
export const onlyExcluded = 2;

export class Example {
  unusedMethod(): number {
    return 1;
  }
}

const config = {
  used: 1,
  dead: 2,
  nested: {
    alive: true,
    stale: false
  }
};

console.log(config.used, config.nested.alive);
