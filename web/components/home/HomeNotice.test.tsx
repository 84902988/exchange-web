import { render, screen } from "@testing-library/react";

import HomeNotice from "./HomeNotice";

jest.mock("@/contexts/LocaleContext", () => ({
  useLocaleContext: () => ({
    locale: "zh",
    t: (key: string) =>
      ({
        noticeTitle: "公告",
        noticeAll: "查看全部",
        noticeNoData: "暂无公告",
      })[key] || key,
  }),
}));

describe("HomeNotice", () => {
  test("shows the empty state without creating a fake announcement link", () => {
    render(<HomeNotice items={[]} />);

    expect(screen.getByText("暂无公告")).toBeInTheDocument();
    expect(screen.queryByText("平台公告")).not.toBeInTheDocument();
    expect(document.querySelector('a[href="/notice/fallback-1"]')).toBeNull();
  });

  test("keeps real announcements clickable", () => {
    render(
      <HomeNotice
        items={[
          {
            id: "42",
            title: "系统维护通知",
            url: "/notice/system-maintenance",
            publishedAt: "2026-07-28T04:00:00.000Z",
          },
        ]}
      />,
    );

    expect(screen.getByRole("link", { name: "系统维护通知" })).toHaveAttribute(
      "href",
      "/notice/system-maintenance",
    );
  });

  test("treats a legacy timezone-less server timestamp as UTC", () => {
    render(
      <HomeNotice
        items={[
          {
            id: "42",
            title: "上线公告",
            publishedAt: "2026-07-30 11:26:49",
          },
        ]}
      />,
    );

    const expected = new Date("2026-07-30T11:26:49Z").toLocaleString("zh-CN");
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  test("does not invent the current time when no persisted timestamp exists", () => {
    render(
      <HomeNotice
        items={[
          {
            id: "42",
            title: "系统维护通知",
            publishedAt: null,
          },
        ]}
      />,
    );

    expect(screen.getByText("--")).toBeInTheDocument();
  });
});
