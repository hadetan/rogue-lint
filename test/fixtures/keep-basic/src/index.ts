import { Example } from "./model.js";
import { liveValue } from "./values.js";

const example = new Example();
example.liveMethod();
console.log(liveValue);
