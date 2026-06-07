type Params = {
  message?: string;
  error?: string | (() => string);
  abort?: boolean;
};

type Check = {
  error?: () => string;
  abort: boolean;
  when: () => boolean;
};

function normalizeParams(_params: Params | string | undefined): Partial<Check> {
  const params: Params = typeof _params === "string" ? { message: _params } : (_params ?? {});

  if (params.message !== undefined) {
    if (params.error !== undefined) {
      throw new Error("Cannot specify both message and error");
    }

    params.error = params.message;
  }

  const { message: _message, ...rest } = params;

  if (typeof rest.error === "string") {
    const error = rest.error;
    return { ...rest, error: () => error };
  }

  return rest;
}

function buildCheck(params?: Params | string): Check {
  return {
    abort: true,
    when: () => true,
    ...normalizeParams(params),
  };
}

const check = buildCheck({ message: "Bad input" });

console.log(check.error?.());
console.log(check.abort);
console.log(check.when());
