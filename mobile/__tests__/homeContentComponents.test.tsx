import React from 'react';
import {Image, StyleSheet, Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {UserPlus} from 'lucide-react-native';
import type {
  MobileAnnouncementSummary,
  MobileHeroContent,
  MobilePromoContent,
  MobileRasterImage,
} from '../src/api/mobileContent';
import type {MarketInstrument} from '../src/api/market';
import MarketRow from '../src/components/common/MarketRow';
import HeroBanner from '../src/components/home/HeroBanner';
import HomeNewsFeed from '../src/components/home/HomeNewsFeed';
import HomeNoticeService from '../src/components/home/HomeNoticeService';
import HomePromoCarousel from '../src/components/home/HomePromoCarousel';
import HomeTopBar from '../src/components/home/HomeTopBar';
import HeaderLanguageIcon from '../src/components/home/HeaderLanguageIcon';
import MarketShortcutGrid from '../src/components/home/MarketShortcutGrid';
import QuickEntryRow from '../src/components/home/QuickEntryRow';
import TabbedMarketList from '../src/components/home/TabbedMarketList';
import IconButton from '../src/components/common/IconButton';

const heroImage: MobileRasterImage = {
  url: 'https://cdn.example.com/mobile/hero.webp',
  width: 1200,
  height: 600,
  byteSize: 400_000,
  mimeType: 'image/webp',
};

const hero: MobileHeroContent = {
  id: 'hero-1',
  title: 'Verified mobile hero',
  subtitle: 'Backend supplied copy',
  image: heroImage,
  action: {type: 'ROUTE', route: 'REGISTER'},
};

const promo: MobilePromoContent = {
  id: 'promo-1',
  title: 'Verified mobile promo',
  subtitle: 'Backend supplied promo copy',
  image: {...heroImage, url: 'https://cdn.example.com/mobile/promo.webp'},
  action: {type: 'ROUTE', route: 'MARKETS'},
};

const announcement: MobileAnnouncementSummary = {
  id: 'announcement-1',
  title: 'Verified announcement',
  summary: 'Backend supplied announcement summary',
  categoryLabel: 'System',
  isPinned: true,
  publishedAt: '2026-07-31T10:30:00+08:00',
};

const market: MarketInstrument = {
  id: 'market-1',
  symbol: 'BTCUSDT',
  displaySymbol: 'BTC/USDT',
  name: 'Bitcoin',
  category: 'crypto',
  price: 123.45,
  changePercent: 1.25,
  pricePrecision: 2,
  logoUrl: 'https://cdn.example.com/assets/btc.png',
  source: 'api',
};

function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(element);
  });
  return renderer;
}

function textValues(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => {
      const value = node.props.children;
      return typeof value === 'string' ? [value] : [];
    });
}

function unmount(renderer: ReactTestRenderer.ReactTestRenderer) {
  act(() => {
    renderer.unmount();
  });
}

describe('Home content presentation components', () => {
  it('shows a neutral guest card without fabricated rewards or market tape', () => {
    const renderer = render(<HeroBanner />);
    const output = JSON.stringify(renderer.toJSON());

    expect(output).not.toContain('6200');
    expect(output).not.toContain('BTC +');
    expect(output).not.toContain('NVDA');
    expect(output).not.toContain('XAU');
    unmount(renderer);
  });

  it('renders a validated remote hero and only makes it actionable with a handler', () => {
    const onAction = jest.fn();
    const passive = render(
      <HeroBanner hero={hero} siteName="Configured Mobile Brand" />,
    );

    expect(
      passive.root.findAll(node => node.props.accessibilityRole === 'button'),
    ).toHaveLength(0);
    expect(
      passive.root
        .findAllByType(Image)
        .some(node => node.props.source?.uri === hero.image.url),
    ).toBe(true);
    const heroImageNode = passive.root
      .findAllByType(Image)
      .find(node => node.props.source?.uri === hero.image.url);
    expect(StyleSheet.flatten(heroImageNode?.props.style).aspectRatio).toBe(
      16 / 9,
    );
    expect(heroImageNode?.props.resizeMode).toBe('cover');
    expect(textValues(passive)).toContain('Configured Mobile Brand');
    unmount(passive);

    const active = render(<HeroBanner hero={hero} onAction={onAction} />);
    const button = active.root.findByProps({
      accessibilityLabel: 'Verified mobile hero，查看详情',
    });
    act(() => {
      button.props.onPress();
    });
    expect(onAction).toHaveBeenCalledWith(hero.action, hero);
    unmount(active);
  });

  it('hides an empty promo carousel and never exposes a dead promo button', () => {
    const empty = render(<HomePromoCarousel promos={[]} />);
    expect(empty.toJSON()).toBeNull();
    unmount(empty);

    const passive = render(<HomePromoCarousel promos={[promo]} />);
    expect(
      passive.root.findAll(node => node.props.accessibilityRole === 'button'),
    ).toHaveLength(0);
    const promoImageNode = passive.root
      .findAllByType(Image)
      .find(node => node.props.source?.uri === promo.image.url);
    expect(StyleSheet.flatten(promoImageNode?.props.style).aspectRatio).toBe(3);
    expect(promoImageNode?.props.resizeMode).toBe('cover');
    unmount(passive);

    const onAction = jest.fn();
    const active = render(
      <HomePromoCarousel promos={[promo]} onAction={onAction} />,
    );
    const button = active.root.findByProps({
      accessibilityLabel: 'Verified mobile promo，查看详情',
    });
    act(() => {
      button.props.onPress();
    });
    expect(onAction).toHaveBeenCalledWith(promo.action, promo);
    unmount(active);
  });

  it('renders only supplied announcements and sends clicks to the detail handler', () => {
    const notice = render(
      <HomeNoticeService announcements={[announcement]} />,
    );
    expect(textValues(notice)).toEqual(
      expect.arrayContaining([
        announcement.title,
        announcement.summary,
        announcement.categoryLabel,
      ]),
    );
    expect(
      notice.root.findAll(node => node.props.accessibilityRole === 'button'),
    ).toHaveLength(0);
    unmount(notice);

    const onPressAnnouncement = jest.fn();
    const feed = render(
      <HomeNewsFeed
        announcements={[announcement]}
        onPressAnnouncement={onPressAnnouncement}
      />,
    );
    const button = feed.root.findByProps({
      accessibilityLabel: announcement.title,
    });
    act(() => {
      button.props.onPress();
    });
    expect(onPressAnnouncement).toHaveBeenCalledWith(announcement);
    expect(JSON.stringify(feed.toJSON())).not.toContain('社区');
    expect(JSON.stringify(feed.toJSON())).not.toContain('直播');
    unmount(feed);
  });

  it('renders only API market instruments and uses non-interactive rows without a handler', () => {
    const grid = render(<MarketShortcutGrid items={[market]} />);
    expect(textValues(grid)).toEqual(
      expect.arrayContaining(['BTC/USDT', '123.45', '+1.25%']),
    );
    expect(
      grid.root.findAll(node => node.props.accessibilityRole === 'button'),
    ).toHaveLength(0);
    expect(
      grid.root
        .findAllByType(Image)
        .some(node => node.props.source?.uri === market.logoUrl),
    ).toBe(true);
    unmount(grid);

    const onPress = jest.fn();
    const list = render(
      <TabbedMarketList items={[market]} onPress={onPress} />,
    );
    const button = list.root.findByProps({
      accessibilityLabel: 'BTC/USDT，123.45',
    });
    act(() => {
      button.props.onPress();
    });
    expect(onPress).toHaveBeenCalledWith(market);
    expect(
      list.root
        .findAllByType(Image)
        .some(node => node.props.source?.uri === market.logoUrl),
    ).toBe(true);
    unmount(list);

    const row = render(<MarketRow item={market} />);
    expect(
      row.root.findAll(node => node.props.accessibilityRole === 'button'),
    ).toHaveLength(0);
    expect(
      row.root
        .findAllByType(Image)
        .some(node => node.props.source?.uri === market.logoUrl),
    ).toBe(true);
    unmount(row);
  });

  it('renders only injected quick entries and every rendered entry has a real handler', () => {
    const empty = render(<QuickEntryRow />);
    expect(empty.toJSON()).toBeNull();
    unmount(empty);

    const onPress = jest.fn();
    const entries = render(
      <QuickEntryRow
        entries={[
          {
            id: 'invite',
            title: 'Invite',
            description: 'Open invite page',
            Icon: UserPlus,
            onPress,
          },
        ]}
      />,
    );
    const button = entries.root.findByProps({
      accessibilityLabel: 'Invite，Open invite page',
    });
    act(() => {
      button.props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    unmount(entries);
  });

  it('does not render support or notification buttons without handlers', () => {
    const passive = render(<HomeTopBar isLoggedIn />);
    expect(passive.root.findAllByType(IconButton)).toHaveLength(0);
    unmount(passive);

    const active = render(
      <HomeTopBar
        isLoggedIn
        onPressNotifications={jest.fn()}
        onPressSupport={jest.fn()}
      />,
    );
    expect(active.root.findAllByType(IconButton)).toHaveLength(2);
    unmount(active);
  });

  it('uses the same language glyph as the web header and preserves navigation', () => {
    const onPressLanguage = jest.fn();
    const renderer = render(
      <HomeTopBar
        isLoggedIn={false}
        onPressLanguage={onPressLanguage}
      />,
    );

    expect(renderer.root.findAllByType(HeaderLanguageIcon)).toHaveLength(1);
    const button = renderer.root.findByProps({
      accessibilityLabel: '语言设置',
    });
    act(() => button.props.onPress());
    expect(onPressLanguage).toHaveBeenCalledTimes(1);

    unmount(renderer);
  });
});
