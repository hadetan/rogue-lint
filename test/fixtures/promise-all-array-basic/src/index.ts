async function run(): Promise<void> {
  const items = [1, 2];
  const values = await Promise.all(items);
  console.log(values[0]);
}

void run();