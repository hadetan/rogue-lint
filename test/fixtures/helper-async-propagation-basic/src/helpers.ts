export function observeNamespace(input: { live: number; dead: number }): void {
  console.log(input.live);
}

export const memberApi = {
  observe(input: { live: number; dead: number }): void {
    console.log(input.live);
  },

  make(): { live: number; dead: number } {
    return {
      live: 1,
      dead: 2,
    };
  },

  forward(): { live: number; dead: number } {
    return memberApi.make();
  },

  async buildAsync(): Promise<{
    live: number;
    dead: number;
    nested: { live: number; dead: number };
  }> {
    return {
      live: 1,
      dead: 2,
      nested: {
        live: 3,
        dead: 4,
      },
    };
  },
};

export async function forwardAsync(): Promise<{
  live: number;
  dead: number;
  nested: { live: number; dead: number };
}> {
  return await memberApi.buildAsync();
}