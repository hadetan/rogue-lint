export type IssueBase = {
  readonly code?: string;
  readonly message?: string;
  readonly path?: PropertyKey[];
};

export type InvalidTypeIssue = IssueBase & {
  readonly code: "invalid_type";
  readonly expected: string;
};

export type UnrecognizedKeysIssue = IssueBase & {
  readonly code: "unrecognized_keys";
  readonly keys: string[];
};

export type Issue = InvalidTypeIssue | UnrecognizedKeysIssue;

type RawIssue<T extends IssueBase> = T extends IssueBase
  ? Partial<T> & {
    readonly inst?: unknown;
    readonly continue?: boolean | undefined;
  } & Record<string, unknown>
  : never;

export type ZodRawIssue<T extends IssueBase = Issue> = RawIssue<T>;
