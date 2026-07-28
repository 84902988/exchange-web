import { fireEvent, render, screen } from '@testing-library/react';

import HomeHero from './HomeHero';

jest.mock('next/image', () => ({
  __esModule: true,
  default: ({
    src,
    alt,
    fill,
    preload,
    ...props
  }: React.ImgHTMLAttributes<HTMLImageElement> & { fill?: boolean; preload?: boolean }) => {
    void fill;
    void preload;
    // Test-only stand-in for next/image.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={String(src)} alt={alt} {...props} />;
  },
}));

jest.mock('next/link', () => ({
  __esModule: true,
  default: ({ children, href, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a href={href} {...props}>{children}</a>
  ),
}));

jest.mock('@/contexts/LocaleContext', () => ({
  useLocaleContext: () => ({
    locale: 'zh',
    t: (key: string) => key,
  }),
}));

describe('HomeHero video loading experience', () => {
  test('shows the optimized placeholder until the first video frame is ready', () => {
    render(
      <HomeHero
        topBar={{ visible: false }}
        backgroundMediaSrc="/homepage-bg480.mp4"
      />,
    );

    const video = screen.getByTestId('home-hero-video');
    expect(video).toHaveAttribute('src', '/homepage-bg480.mp4');
    expect(screen.getByTestId('home-hero-placeholder')).toBeInTheDocument();

    fireEvent.loadedData(video);

    expect(screen.queryByTestId('home-hero-placeholder')).not.toBeInTheDocument();
  });

  test('keeps the placeholder when the video cannot load', () => {
    render(
      <HomeHero
        topBar={{ visible: false }}
        backgroundMediaSrc="/homepage-bg480.mp4"
      />,
    );

    fireEvent.error(screen.getByTestId('home-hero-video'));

    expect(screen.queryByTestId('home-hero-video')).not.toBeInTheDocument();
    expect(screen.getByTestId('home-hero-placeholder')).toBeInTheDocument();
  });
});
