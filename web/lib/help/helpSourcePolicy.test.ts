import { describe, expect, it } from "@jest/globals";

import { helpCategories, type HelpCategory } from "./helpContent";
import { resolveHelpSourceCategories } from "./helpSourcePolicy";


describe("resolveHelpSourceCategories", () => {
  it("uses static help content while CMS is unavailable", () => {
    expect(resolveHelpSourceCategories(null)).toBe(helpCategories);
  });

  it("keeps an empty successful CMS response authoritative", () => {
    expect(resolveHelpSourceCategories([])).toEqual([]);
  });

  it("uses populated CMS categories without copying them", () => {
    const cmsCategories: HelpCategory[] = [
      {
        id: "cms-category",
        title: { en: "CMS" },
        description: { en: "CMS content" },
        articles: [],
      },
    ];

    expect(resolveHelpSourceCategories(cmsCategories)).toBe(cmsCategories);
  });
});
