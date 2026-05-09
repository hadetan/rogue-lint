class FormatterCore {
  format(): string {
    return "ok";
  }

  chain(): FormatterCore {
    return this;
  }
}

type FormatterFactory = (() => FormatterCore) & { prototype: FormatterCore };

const formatter = (() => new FormatterCore()) as FormatterFactory;
formatter.prototype = FormatterCore.prototype;

export default formatter;