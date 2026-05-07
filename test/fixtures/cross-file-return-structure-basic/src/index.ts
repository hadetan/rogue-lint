import { buildList, buildShared } from "./shared.js";

const shared = buildShared();
console.log(shared.live);
console.log(shared.nested.read);

const [first] = buildList();
console.log(first.keep);
