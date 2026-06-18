import React from 'react';
import {StyleSheet, View} from 'react-native';
import {Bell, CircleUserRound, Headphones} from 'lucide-react-native';
import IconButton from '../common/IconButton';
import SearchBar from '../common/SearchBar';

type Props = {
  isLoggedIn: boolean;
  onPressProfile?: () => void;
  onPressSearch?: () => void;
  onPressSupport?: () => void;
  onPressNotifications?: () => void;
};

export default function HomeTopBar({
  isLoggedIn,
  onPressProfile,
  onPressSearch,
  onPressSupport,
  onPressNotifications,
}: Props) {
  return (
    <View style={styles.row}>
      <IconButton
        accessibilityLabel="用户入口"
        icon={CircleUserRound}
        onPress={onPressProfile}
      />
      <SearchBar placeholder="搜索 UNI" onPress={onPressSearch} />
      <IconButton
        accessibilityLabel="客服与帮助中心"
        icon={Headphones}
        onPress={onPressSupport}
      />
      {isLoggedIn ? (
        <IconButton
          accessibilityLabel="公告与客服回复"
          icon={Bell}
          badge
          onPress={onPressNotifications}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingTop: 4,
  },
});
