const objectKeys: ObjectConstructor["keys"] =
  typeof Object.keys === "function"
    ? (obj: object) => Object.keys(obj)
    : (source: object) => {
        const keys = [];
        for (const key in source) {
          if (Object.prototype.hasOwnProperty.call(source, key)) {
            keys.push(key);
          }
        }
        return keys;
      };

console.log(objectKeys({ live: 1, dead: 2 }).join(","));