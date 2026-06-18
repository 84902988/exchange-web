import React from 'react';
import {StyleSheet, View} from 'react-native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import IconButton from '../common/IconButton';
import SearchBar from '../common/SearchBar';
import type {RootStackParamList} from '../../navigation/types';

type Props = {
  loggedIn: boolean;
  navigation: NativeStackNavigationProp<RootStackParamList>;
};

export default function HomeTopBar({loggedIn, navigation}: Props) {
  return (
    <View style={styles.row}>
      {loggedIn ? null : (
        <IconButton
          label="U"
          onPress={() => navigation.navigate('Auth', {screen: 'Login'})}
        />
      )}
      <SearchBar placeholder="搜索 UNI" />
      <IconButton label={loggedIn ? 'N' : '?'} badge={loggedIn} />
      <IconButton label="C" badge={loggedIn} />
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
