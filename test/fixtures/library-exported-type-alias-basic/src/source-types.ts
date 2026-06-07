export type SourceSchema = {
  parse(input: string): {
    output: string;
    dead: string;
  };
};

export interface SourceConfig {
  prefix: string;
}

export type InternalOnly = {
  dead: string;
};
