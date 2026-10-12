import { fileURLToPath } from "node:url";
import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { expect, it } from "vitest";

it("uses only public SDK and package-local source", async () => {
  const result = await experimental_scanPublicSdkOnly(fileURLToPath(new URL(".", import.meta.url)), {
    allow: [/^react(?:-dom)?(?:\/.*)?$/, /^@radix-ui\/react-/, /^@testing-library\//,
      /^@\/(?:components|lib|hooks)\//, /^vitest(?:\/.*)?$/, /^class-variance-authority$/, /^clsx$/, /^tailwind-merge$/, /^sonner$/],
  });
  expect(result.violations).toEqual([]);
  expect(result.privateDependencies).toEqual([]);
});
