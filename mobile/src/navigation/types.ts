import type {NavigatorScreenParams} from '@react-navigation/native';

export type AuthStackParamList = {
  Login: undefined;
  Register: undefined;
};

export type MainTabParamList = {
  Home: undefined;
  Markets: undefined;
  Trade: undefined;
  Contract: undefined;
  Assets: undefined;
};

export type RootStackParamList = {
  Splash: undefined;
  Main: undefined;
  Auth: NavigatorScreenParams<AuthStackParamList> | undefined;
};
