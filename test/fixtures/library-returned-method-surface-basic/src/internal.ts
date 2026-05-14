export function internalCarrier() {
  return {
    live() {
      return 1;
    },
    stale() {
      return 2;
    },
  };
}

export function publicCarrier() {
  return {
    visible() {
      return 1;
    },
    hidden() {
      return 2;
    },
  };
}
