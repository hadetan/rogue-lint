export interface InternalContract {
  runtime: number;
  supportRuntime: number;
  testOnly: number;
  mixed: number;
  stale: number;
}

export interface PublicContract {
  preserved: number;
}
