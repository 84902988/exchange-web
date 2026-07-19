import { helpCategories, type HelpCategory } from "./helpContent";


export function resolveHelpSourceCategories(
  cmsCategories: HelpCategory[] | null,
): HelpCategory[] {
  return cmsCategories ?? helpCategories;
}
