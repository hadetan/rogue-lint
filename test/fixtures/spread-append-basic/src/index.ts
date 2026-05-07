import { numbers } from "./source.js";

const sink: number[] = [];
sink.push(...numbers);

console.log(sink[0]);
