function capture(items: number[]): () => void {
  return () => {
    console.log(items[0]);
  };
}

const items = [1, 2];
const run = capture(items);
run();
