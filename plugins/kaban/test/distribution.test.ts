import { experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { z } from "zod";

const root = fileURLToPath(new URL("../", import.meta.url));
const dependencyMap = z.record(z.string(), z.string()).optional();
const manifest = z.object({
  license: z.string(),
  bb: z.object({
    server: z.string(), host: z.string(), app: z.string(),
    branding: z.object({ icon: z.string() }),
    skills: z.array(z.string()),
  }),
  dependencies: dependencyMap,
  devDependencies: dependencyMap,
  optionalDependencies: dependencyMap,
}).parse(JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")));

it("uses only public SDK imports and package-local source", async () => {
  const scanned = await experimental_scanPublicSdkOnly(root, {
    allow: [
      /^react(?:-dom)?(?:\/.*)?$/,
      /^@testing-library\/(?:react|dom)$/,
      /^@radix-ui\/react-[a-z-]+$/,
      /^better-sqlite3$/,
      /^@\/(?:components\/ui\/|lib\/)[\w/-]+$/,
      /^(?:class-variance-authority|clsx|tailwind-merge|sonner|vaul|vitest(?:\/config)?)$/,
    ],
  });
  // The CLI fixture is not named *.test.ts, so the scanner classifies it as production.
  expect(scanned.violations.filter((v) => !(v.file === path.join("test", "fake-kaban.ts")
    && v.specifier === "@get-bb/plugin-sdk/testing" && v.reason === "outside-allowlist"))).toEqual([]);
  z.object({
    extends: z.never().optional(),
    compilerOptions: z.object({
      baseUrl: z.enum([".", "./"]).optional(),
      paths: z.object({ "@/*": z.tuple([z.literal("./*")]) }),
    }),
  }).parse(JSON.parse(readFileSync(path.join(root, "tsconfig.json"), "utf8")));
  for (const file of scanned.files) {
    const source = readFileSync(path.join(root, file), "utf8");
    for (const match of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](@\/[^"']+)["']/g)) {
      const alias = match[1];
      if (!alias) throw new Error("Missing alias import capture");
      const target = path.resolve(root, alias.slice(2));
      expect(path.relative(root, target)).not.toMatch(/^\.\.(?:[/\\]|$)/);
      expect([".ts", ".tsx", "/index.ts", "/index.tsx"].some((ext) => existsSync(target + ext)), alias).toBe(true);
    }
  }
  expect(scanned.privateDependencies).toEqual([]);
});

it("ships every declared entry, icon and skill inside this package", () => {
  const entries = [manifest.bb.server, manifest.bb.host, manifest.bb.app, manifest.bb.branding.icon, ...manifest.bb.skills];
  for (const entry of entries) {
    expect(path.isAbsolute(entry), entry).toBe(false);
    const resolved = path.resolve(root, entry);
    expect(path.relative(root, resolved)).not.toMatch(/^\.\.(?:[/\\]|$)/);
    expect(existsSync(resolved), entry).toBe(true);
  }
});

it("preserves Kaban and copied BB component license notices", () => {
  const license = readFileSync(path.join(root, "LICENSE"), "utf8");
  const notices = readFileSync(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8");
  expect(manifest.license).toBe("MIT");
  expect(license).toContain("Copyright (c) 2026 Kaban Contributors");
  expect(license).toContain("The above copyright notice and this permission notice");
  expect(notices).toContain("Copyright (c) 2026 Michael Yong");
  expect(notices).toContain("The above copyright notice and this permission notice");
});

it("has no workspace, file or private BB dependency", () => {
  for (const section of [manifest.dependencies, manifest.devDependencies, manifest.optionalDependencies]) {
    for (const [name, version] of Object.entries(section ?? {})) {
      expect(name).not.toMatch(/^@bb\//);
      expect(String(version)).not.toMatch(/^(?:workspace:|file:|link:)/);
    }
  }
});
