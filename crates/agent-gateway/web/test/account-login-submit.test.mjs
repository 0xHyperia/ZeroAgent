import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const loginPageSource = readFileSync(
  new URL("../src/pages/AccountLoginPage.tsx", import.meta.url),
  "utf8",
);

test("account login action submits its enclosing form", () => {
  assert.match(
    loginPageSource,
    /<Button\s+type="submit"\s+className="mt-7 w-full"/,
    "the shared Button defaults to type=button, so the login action must opt into form submission",
  );
});
