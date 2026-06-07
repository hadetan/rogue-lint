// Mirrors the original visitor.ts bug: a const initialized to undefined
// used as a ternary condition — the truthy branch is unreachable.

const directHandler = undefined;
const fallback = "fallback";

// ternary: directHandler has type undefined — truthy branch is dead
const result = directHandler ? "never" : fallback;
console.log(result);

// if-statement variant of the same pattern
const transform = undefined;
if (transform) {
  console.log("unreachable");
}
console.log("done");
