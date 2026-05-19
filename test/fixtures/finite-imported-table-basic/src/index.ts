import * as util from "./util.js";

type Format = "int32" | "uint32";

export function readRange(format: Format) {
  return util.NUMBER_FORMAT_RANGES[format];
}

const [int32Min, int32Max] = readRange("int32");
const [uint32Min, uint32Max] = readRange("uint32");

console.log(int32Min, int32Max);
console.log(uint32Min, uint32Max);