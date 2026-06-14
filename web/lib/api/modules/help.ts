import { request } from "@/lib/api/core/request";
import { withContentLanguage } from "@/lib/api/core/locale";

export type HelpContentSectionDTO = {
  heading?: string;
  body?: string[];
  steps?: string[];
  bullets?: string[];
};

export type HelpContentArticleDTO = {
  id: string;
  slug: string;
  title: string;
  summary?: string;
  content?: string;
  sections?: HelpContentSectionDTO[];
  tags?: string[];
  hot?: boolean;
  is_hot?: boolean;
  sort_order?: number;
};

export type HelpContentCategoryDTO = {
  id: string;
  category_key?: string;
  title: string;
  description?: string;
  articles?: HelpContentArticleDTO[];
  sort_order?: number;
};

export type HelpContentResponse = {
  categories?: HelpContentCategoryDTO[];
  hotArticles?: HelpContentArticleDTO[];
};

export async function getHelpContent(language?: string): Promise<HelpContentResponse> {
  return request<HelpContentResponse>(withContentLanguage("/help/content", language));
}
