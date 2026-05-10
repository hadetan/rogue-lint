type FlattenedErrors = {
  formErrors: string[];
  fieldErrors: {
    name: string[];
    stale: string[];
  };
  summary: string;
};

function flattenError(): FlattenedErrors {
  const fieldErrors = {
    name: [] as string[],
    stale: [] as string[],
  };
  const formErrors: string[] = [];

  formErrors.push("Problem");
  fieldErrors.name.push("Required");

  return {
    formErrors,
    fieldErrors,
    summary: "stale",
  };
}

const flattened = flattenError();
console.log(flattened.formErrors[0]);
console.log(flattened.fieldErrors.name[0]);
