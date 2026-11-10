import { readFileSync } from "node:fs";

/** neotags' own version, from package.json: src/ and dist/ both sit one level below it. */
export const PACKAGE_VERSION: string = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
