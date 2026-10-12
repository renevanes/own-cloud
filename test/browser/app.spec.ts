import { test, expect } from "@playwright/test";
import { base32Decode, totpCode } from "../../src/security/totp.js";
let owner: string;
test.beforeEach(async ({ request, page }) => {
  await page.addInitScript(() => {
    (window as any).nativeCalls = [];
    (window as any).EigenPhone = { info: () => "null", set: (...args: any[]) => (window as any).nativeCalls.push(args) };
  });
  const reset = await request.post("/__test/reset"); owner = (await reset.json()).token;
  expect(reset.ok()).toBeTruthy();
  await page.goto("/"); await page.locator("#password").fill("browser-test-password"); await page.locator("#loginForm button").click(); await expect(page.locator("#app")).toBeVisible();
});

test("adversarial headers and mail bodies cannot execute in the application or Android bridge context", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.locator("#messages li").first().click(); await expect(page.locator("#reader h2")).toHaveText("Header safety");
  await expect(page.locator("#reader .meta")).toContainText("<img src=x onerror=window.headerXss=1>");
  await expect(page.locator("#reader .meta img")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).nativeCalls)).toEqual([]);
  expect(await page.evaluate(() => ({ header: (window as any).headerXss, body: (window as any).bodyXss }))).toEqual({ header: undefined, body: undefined });
  const csp = (await page.request.get("/")).headers()["content-security-policy"]; expect(csp).toContain("script-src 'self'");
  await page.locator("#compose").click(); await page.locator("#composeForm input[name=subject]").fill("A saved draft"); await page.locator("#composeForm textarea").fill("Persistent text"); await page.locator("#saveDraft").click();
  await expect(page.locator("#composeError")).toHaveText("Concept bewaard."); await page.locator("#composeForm button[value=cancel]").click();
  await page.getByRole("button", { name: "Concepten", exact: true }).click(); await expect(page.locator("#mailToolsDialog")).toContainText("A saved draft");
  expect(errors).toEqual([]);
});

test("customer MFA enrollment exposes recovery codes once and login requests a second factor", async ({ page, request }) => {
  await page.goto("/#instellingen/beveiliging"); await expect(page.locator("#mfaForm")).toBeVisible();
  await page.locator("#mfaForm input[name=password]").fill("browser-test-password"); await page.locator("#mfaForm button").click();
  const secret = await page.locator("#mfaPending code").textContent(); await page.locator("#mfaConfirm input").fill(totpCode(base32Decode(secret!))); await page.locator("#mfaConfirm button").click();
  await expect(page.locator("#recoveryCodes")).toBeVisible(); const codes = (await page.locator("#recoveryCodes pre").textContent())!.split("\n"); expect(codes).toHaveLength(10);
  await page.locator("#logout").click(); await expect(page.locator("#login")).toBeVisible(); await page.locator("#password").fill("browser-test-password"); await page.locator("#loginForm button").click();
  await expect(page.locator("#loginFactor")).toBeVisible(); await page.locator("#loginCode").fill(codes[0]); await page.locator("#loginForm button").click(); await expect(page.locator("#app")).toBeVisible();
  const reused = await request.post("/api/login", { data: { password: "browser-test-password", code: codes[0] } }); expect(reused.status()).toBe(401);
});

test("selected offline contacts remain readable; edits queue, conflicts preserve server data, and logout clears the cache", async ({ page, context, request }) => {
  await page.goto("/#instellingen/offline"); await expect(page.locator("#offlineForm")).toBeVisible(); await page.locator("#offlineForm input[name=contacts]").check(); await page.locator("#offlineForm input[name=queue]").check(); await page.locator("#offlineForm button.primary").click();
  await expect(page.locator("#offlineMessage")).toContainText("Ingeschakeld");
  await page.locator('[data-tab="contacten"]').click(); await page.locator("#contactForm input[name=name]").fill("Original contact"); await page.locator("#contactForm input[name=email]").fill("friend@outside.test"); await page.locator("#contactForm button.primary").click(); await expect(page.locator("#contactList")).toContainText("Original contact");
  await page.waitForFunction(async () => (await caches.keys()).some((key) => key.startsWith("eigen-private-")));
  await context.setOffline(true); await page.reload(); await expect(page.locator("#app")).toBeVisible(); await page.locator('[data-tab="contacten"]').click(); await expect(page.locator("#contactList")).toContainText("Original contact");
  await page.locator("#contactList [data-edit]").first().click(); await page.locator("#contactForm input[name=name]").fill("Offline edit"); await page.locator("#contactForm button.primary").click(); await expect(page.locator("#contactMessage")).toContainText("wachtrij");
  const contacts = await (await request.get("/api/contacts", { headers: { authorization: `Bearer ${owner}` } })).json();
  await request.put(`/api/contacts/${contacts[0].id}`, { headers: { authorization: `Bearer ${owner}` }, data: { name: "Other device", revision: contacts[0].revision } });
  await context.setOffline(false); await page.goto("/#instellingen/offline"); await expect(page.locator("#syncOffline")).toBeVisible(); await page.locator("#syncOffline").click();
  await expect(page.locator('[data-sec="offline"] .feature-list')).toContainText("Contact is gewijzigd");
  const current = await (await request.get("/api/contacts", { headers: { authorization: `Bearer ${owner}` } })).json(); expect(current[0].name).toBe("Other device");
  await page.locator("#logout").click(); await expect(page.locator("#login")).toBeVisible();
  expect(await page.evaluate(async () => (await caches.keys()).filter((name) => name.startsWith("eigen-private-")))).toEqual([]);
});
