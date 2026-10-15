import type { Page } from "@playwright/test";

/** The view names in the navigation, in order. Read through getAttribute, so this file needs no DOM types. */
export async function viewNames(page: Page): Promise<string[]> {
  const buttons = page.locator('nav[aria-label="views"] button[data-view]');
  const names: string[] = [];
  for (let i = 0; i < (await buttons.count()); i++) names.push((await buttons.nth(i).getAttribute("data-view")) ?? "");
  return names;
}
