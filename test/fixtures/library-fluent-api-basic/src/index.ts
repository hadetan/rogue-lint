export enum FormatToken {
  Lower = "a",
  Upper = "A",
  Short = "s",
}

export class Formatter {
  lower(): string {
    return this.render(FormatToken.Lower);
  }

  upper(): string {
    return this.render(FormatToken.Upper);
  }

  chain(): Formatter {
    return this;
  }

  private render(token: FormatToken): string {
    return token === FormatToken.Lower ? "am" : "AM";
  }
}