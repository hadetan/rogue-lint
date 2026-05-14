type FlattenedErrors = {
  formErrors: string[];
  fieldErrors: {
    name: string[];
  };
  summary: string;
};

function flattenError(): FlattenedErrors {
  return {
    formErrors: ["Problem"],
    fieldErrors: {
      name: ["Required"],
    },
    summary: "stale",
  };
}

const flattened = flattenError();
console.log(flattened.formErrors[0]);
console.log(flattened.fieldErrors.name[0]);
