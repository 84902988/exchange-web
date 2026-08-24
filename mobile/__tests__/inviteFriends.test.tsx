import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {
  filterInvitedFriendsBySource,
  InviteFriendsContractError,
  normalizeInvitedFriends,
  type InvitedFriend,
} from '../src/api/invite';
import AssetBdTeamMembers from '../src/components/assets/AssetBdTeamMembers';
import AssetInvitedFriends, {
  formatInviteUtcTime,
  maskInvitedEmail,
} from '../src/components/assets/AssetInvitedFriends';

const friend: InvitedFriend = {
  userId: 23,
  email: 'friend@example.com',
  sourceType: 'USER_INVITE',
  inviteCode: 'INVITE88',
  registeredAt: '2026-08-01T02:00:00',
  boundAt: '2026-08-02T03:20:00',
};

function renderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(String)
    .join(' ');
}

describe('mobile invited friends contract and presentation', () => {
  it('maps a real response and accepts an authoritative empty list', () => {
    expect(normalizeInvitedFriends({items: []})).toEqual({items: []});
    expect(
      normalizeInvitedFriends({
        items: [
          {
            user_id: 23,
            email: 'friend@example.com',
            source_type: 'USER_INVITE',
            invite_code: 'INVITE88',
            registered_at: '2026-08-01T02:00:00',
            bound_at: '2026-08-02T03:20:00',
          },
        ],
      }).items[0],
    ).toEqual(friend);
  });

  it('fails closed for invalid identities, sources, timestamps, and duplicates', () => {
    const row = {
      user_id: 23,
      email: 'friend@example.com',
      source_type: 'USER_INVITE',
      invite_code: null,
      registered_at: null,
      bound_at: '2026-08-02T03:20:00',
    };
    expect(() =>
      normalizeInvitedFriends({items: [{...row, user_id: 0}]}),
    ).toThrow(InviteFriendsContractError);
    expect(() =>
      normalizeInvitedFriends({items: [{...row, source_type: 'UNKNOWN'}]}),
    ).toThrow(InviteFriendsContractError);
    expect(() =>
      normalizeInvitedFriends({items: [{...row, bound_at: 'invalid'}]}),
    ).toThrow(InviteFriendsContractError);
    expect(() => normalizeInvitedFriends({items: [row, row]})).toThrow(
      InviteFriendsContractError,
    );
  });

  it('renders regular invites and BD team members in separate sections', () => {
    const bdMember: InvitedFriend = {
      ...friend,
      userId: 24,
      email: 'partner@example.com',
      sourceType: 'BD',
      inviteCode: 'BD100000029',
    };
    const mixedItems = [friend, bdMember];
    expect(filterInvitedFriendsBySource(mixedItems, 'USER_INVITE')).toEqual([
      friend,
    ]);
    expect(filterInvitedFriendsBySource(mixedItems, 'BD')).toEqual([bdMember]);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetInvitedFriends items={mixedItems} />,
      );
    });
    const inviteText = renderedText(renderer);
    expect(inviteText).toContain('fr***@example.com');
    expect(inviteText).not.toContain('friend@example.com');
    expect(inviteText).not.toContain('pa***@example.com');
    expect(inviteText).toContain('好友邀请');
    expect(inviteText).not.toContain('代理绑定');
    expect(inviteText).toMatch(/邀请码\s+INVITE88/);
    act(() => renderer.unmount());

    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetBdTeamMembers items={mixedItems} totalCount={1} />,
      );
    });
    const teamText = renderedText(renderer);
    expect(teamText).toContain('代理团队成员');
    expect(teamText).toContain('pa***@example.com');
    expect(teamText).not.toContain('fr***@example.com');
    expect(teamText).toContain('代理绑定');
    expect(teamText).not.toContain('好友邀请');
    expect(teamText).toMatch(/邀请码\s+BD100000029/);
    act(() => renderer.unmount());
  });

  it('shows explicit loading, empty, and retryable error states', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetInvitedFriends items={[]} loading />,
      );
    });
    expect(renderedText(renderer)).toContain('正在加载邀请好友');
    act(() => renderer.unmount());

    act(() => {
      renderer = ReactTestRenderer.create(<AssetInvitedFriends items={[]} />);
    });
    expect(renderedText(renderer)).toContain('暂无邀请好友');
    act(() => renderer.unmount());

    const retry = jest.fn();
    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetInvitedFriends
          error="网络连接异常，请稍后重试"
          items={[]}
          onRetryPress={retry}
        />,
      );
    });
    act(() => {
      renderer.root.findByProps({accessibilityLabel: '重新加载'}).props.onPress();
    });
    expect(retry).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('masks emails and treats naive backend timestamps as UTC', () => {
    expect(maskInvitedEmail('a@example.com')).toBe('a***@example.com');
    expect(maskInvitedEmail(null)).toBe('未提供邮箱');
    expect(formatInviteUtcTime('invalid')).toBe('--');
    expect(formatInviteUtcTime(null)).toBe('--');
  });
});
