import * as helpers from "./helpers.js";
import { memberApi } from "./helpers.js";

const namespaceObserved = {
  live: 1,
  dead: 2,
};

helpers.observeNamespace(namespaceObserved);

const memberObserved = {
  live: 1,
  dead: 2,
};

memberApi.observe(memberObserved);

const forwarded = memberApi.forward();
console.log(forwarded.live);

async function run(): Promise<void> {
  const awaited = await helpers.forwardAsync();
  console.log(awaited.live);
  console.log(awaited.nested.live);
}

void run();