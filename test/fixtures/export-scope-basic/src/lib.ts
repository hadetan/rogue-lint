export function localOnlyUsed(): number {
  return 1;
}

void localOnlyUsed();

export type LocalOnlyShape = {
  value: number;
};

const localShape: LocalOnlyShape = { value: 1 };
void localShape;

// rogue-lint-ignore-next
export function ignoredLocalOnly(): number {
  return 2;
}

void ignoredLocalOnly();

// rogue-lint-ignore-next
export type IgnoredLocalShape = {
  value: number;
};

const ignoredShape: IgnoredLocalShape = { value: 2 };
void ignoredShape;

export function crossFileUsed(): number {
  return 3;
}

export type CrossFileShape = {
  value: number;
};
