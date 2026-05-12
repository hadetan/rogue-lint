export function internalCarrier() {
  return {
    keep: 1,
    stale: 2,
  };
}

export function publicCarrier() {
  return {
    live: 1,
    hidden: 2,
  };
}
