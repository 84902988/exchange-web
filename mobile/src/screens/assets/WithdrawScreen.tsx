import React, {useCallback, useEffect, useMemo, useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';
import {useNavigation} from '@react-navigation/native';
import type {NativeStackNavigationProp} from '@react-navigation/native-stack';
import AppScreen from '../../components/common/AppScreen';
import PrimaryButton from '../../components/common/PrimaryButton';
import {
  ActionCard,
  ActionHeader,
  ActionTextField,
  AuthRequiredCard,
  InfoRow,
  InlineNotice,
  RefreshButton,
  SelectChips,
  SmallTextButton,
  StateCard,
  formatAmount,
  maskMiddle,
  toChineseError,
} from '../../components/assets/action/ActionPrimitives';
import type {RootStackParamList} from '../../navigation/types';
import {
  confirmWithdraw,
  createWithdrawDraft,
  fetchAssetAccountBalances,
  fetchWithdrawFee,
  fetchWithdrawOptions,
  sendWithdrawCode,
  type AssetAccountBalance,
  type AssetChainOption,
  type WithdrawCreateResponse,
  type WithdrawFeeEstimate,
} from '../../api/assets';
import {useAuth} from '../../store/authStore';
import {colors, typography} from '../../theme';

type RootNavigation = NativeStackNavigationProp<RootStackParamList>;
type Step = 'form' | 'verify' | 'done';

export default function WithdrawScreen() {
  const navigation = useNavigation<RootNavigation>();
  const {isLoggedIn} = useAuth();
  const [options, setOptions] = useState<AssetChainOption[]>([]);
  const [balances, setBalances] = useState<AssetAccountBalance[]>([]);
  const [defaultSymbol, setDefaultSymbol] = useState<string | null>(null);
  const [coin, setCoin] = useState('');
  const [network, setNetwork] = useState('');
  const [address, setAddress] = useState('');
  const [memo, setMemo] = useState('');
  const [amount, setAmount] = useState('');
  const [code, setCode] = useState('');
  const [draft, setDraft] = useState<WithdrawCreateResponse | null>(null);
  const [fee, setFee] = useState<WithdrawFeeEstimate | null>(null);
  const [step, setStep] = useState<Step>('form');
  const [loading, setLoading] = useState(false);
  const [feeLoading, setFeeLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [codeSending, setCodeSending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const loadData = useCallback(async () => {
    if (!isLoggedIn) return;
    setLoading(true);
    setError('');
    try {
      const [optionResult, balanceRows] = await Promise.all([
        fetchWithdrawOptions(),
        fetchAssetAccountBalances(),
      ]);
      setOptions(optionResult.items.filter(isWithdrawOptionEnabled));
      setDefaultSymbol(optionResult.defaultAssetSymbol ?? null);
      setBalances(balanceRows);
    } catch (requestError) {
      setOptions([]);
      setBalances([]);
      setError(toChineseError(requestError, '提现配置加载失败，请稍后重试'));
    } finally {
      setLoading(false);
    }
  }, [isLoggedIn]);

  useEffect(() => {
    if (!isLoggedIn) {
      setOptions([]);
      setBalances([]);
      setError('');
      return;
    }
    loadData().catch(() => undefined);
  }, [isLoggedIn, loadData]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setInterval(() => {
      setCooldown(current => (current <= 1 ? 0 : current - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [cooldown]);

  const coinOptions = useMemo(() => {
    const map = new Map<string, {label: string; sort: number}>();
    options.forEach(item => {
      if (!item.coinSymbol || map.has(item.coinSymbol)) return;
      map.set(item.coinSymbol, {
        label: item.coinName ? `${item.coinSymbol} ${item.coinName}` : item.coinSymbol,
        sort: item.withdrawSortOrder ?? 100,
      });
    });
    return Array.from(map.entries())
      .sort((a, b) => a[1].sort - b[1].sort || a[0].localeCompare(b[0]))
      .map(([value, meta]) => ({value, label: meta.label}));
  }, [options]);

  const selectedCoin = useMemo(() => {
    if (coinOptions.some(item => item.value === coin)) return coin;
    const preferred = defaultSymbol
      ? coinOptions.find(item => item.value === defaultSymbol)?.value
      : undefined;
    return preferred ?? coinOptions[0]?.value ?? '';
  }, [coin, coinOptions, defaultSymbol]);

  const networkOptions = useMemo(
    () =>
      options
        .filter(item => item.coinSymbol === selectedCoin)
        .sort(
          (a, b) =>
            (a.withdrawSortOrder ?? 100) - (b.withdrawSortOrder ?? 100) ||
            (a.chainName || a.chainKey).localeCompare(b.chainName || b.chainKey),
        ),
    [options, selectedCoin],
  );

  const selectedNetwork = useMemo(() => {
    if (networkOptions.some(item => item.chainKey === network)) return network;
    return networkOptions[0]?.chainKey ?? '';
  }, [network, networkOptions]);

  const selectedOption = useMemo(
    () => networkOptions.find(item => item.chainKey === selectedNetwork) ?? null,
    [networkOptions, selectedNetwork],
  );

  const fundingBalance = useMemo(() => {
    const row = balances.find(
      item =>
        item.accountKey.toLowerCase() === 'funding' &&
        item.symbol.toUpperCase() === selectedCoin,
    );
    return row?.available ?? 0;
  }, [balances, selectedCoin]);

  const memoVisible = Boolean(selectedOption?.memoRequired || selectedOption?.memoLabel);
  const amountNumber = Number(amount);
  const amountValid = Number.isFinite(amountNumber) && amountNumber > 0;
  const submitDisabled =
    submitting ||
    !selectedCoin ||
    !selectedNetwork ||
    !address.trim() ||
    !amountValid ||
    amountNumber > fundingBalance;

  useEffect(() => {
    setFee(null);
    if (!isLoggedIn || !selectedCoin || !selectedNetwork || !amountValid) return;
    let alive = true;
    setFeeLoading(true);
    const timer = setTimeout(async () => {
      try {
        const result = await fetchWithdrawFee({
          symbol: selectedCoin,
          network: selectedNetwork,
          amount,
          toAddress: address.trim() || undefined,
        });
        if (alive) setFee(result);
      } catch {
        if (alive) setFee(null);
      } finally {
        if (alive) setFeeLoading(false);
      }
    }, 450);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [address, amount, amountValid, isLoggedIn, selectedCoin, selectedNetwork]);

  const resetFlow = useCallback(() => {
    setStep('form');
    setDraft(null);
    setCode('');
    setCooldown(0);
    setMessage('');
    setError('');
  }, []);

  const changeCoin = useCallback(
    (nextCoin: string) => {
      setCoin(nextCoin);
      setNetwork('');
      setAmount('');
      setAddress('');
      setMemo('');
      resetFlow();
    },
    [resetFlow],
  );

  const changeNetwork = useCallback(
    (nextNetwork: string) => {
      setNetwork(nextNetwork);
      setAddress('');
      setMemo('');
      resetFlow();
    },
    [resetFlow],
  );

  const submitDraft = useCallback(async () => {
    setError('');
    setMessage('');
    if (!selectedCoin) {
      setError('请选择提现币种');
      return;
    }
    if (!selectedNetwork) {
      setError('请选择提现网络');
      return;
    }
    if (!address.trim()) {
      setError('请输入提现地址');
      return;
    }
    if (!amountValid) {
      setError('请输入正确的提现数量');
      return;
    }
    if (amountNumber > fundingBalance) {
      setError('资金账户可用余额不足');
      return;
    }
    if (selectedOption?.minWithdraw && amountNumber < Number(selectedOption.minWithdraw)) {
      setError(`最小提现数量为 ${selectedOption.minWithdraw} ${selectedCoin}`);
      return;
    }

    setSubmitting(true);
    try {
      const result = await createWithdrawDraft({
        symbol: selectedCoin,
        network: selectedNetwork,
        toAddress: address,
        amount,
      });
      setDraft(result);
      if (result.needManualReview || result.status.toUpperCase() === 'REVIEWING') {
        setStep('done');
        setMessage('提现申请已提交审核，请在资金流水或提现记录中查看进度。');
      } else {
        setStep('verify');
        setMessage('提现申请已创建，请点击发送邮箱验证码后完成确认。');
      }
    } catch (requestError) {
      setError(toChineseError(requestError, '提现提交失败，请稍后重试'));
    } finally {
      setSubmitting(false);
    }
  }, [
    address,
    amount,
    amountNumber,
    amountValid,
    fundingBalance,
    selectedCoin,
    selectedNetwork,
    selectedOption?.minWithdraw,
  ]);

  const sendCode = useCallback(async () => {
    if (!draft?.withdrawId || cooldown > 0) return;
    setCodeSending(true);
    setError('');
    try {
      await sendWithdrawCode(draft.withdrawId);
      setCooldown(60);
      setMessage('验证码已发送，请查看注册邮箱。');
    } catch (requestError) {
      setError(toChineseError(requestError, '验证码发送失败，请稍后重试'));
    } finally {
      setCodeSending(false);
    }
  }, [cooldown, draft?.withdrawId]);

  const confirm = useCallback(async () => {
    if (!draft?.withdrawId) return;
    if (!code.trim()) {
      setError('请输入邮箱验证码');
      return;
    }
    setConfirming(true);
    setError('');
    try {
      const result = await confirmWithdraw({withdrawId: draft.withdrawId, code});
      setStep('done');
      setDraft(current =>
        current
          ? {
              ...current,
              status: result.status,
              feeEstimate: result.feeFinal || current.feeEstimate,
              feeCoin: result.feeCoin || current.feeCoin,
              receiveAmount: result.receiveAmount || current.receiveAmount,
            }
          : current,
      );
      setMessage(`提现已提交，当前状态：${mapWithdrawStatus(result.status)}`);
      await loadData();
    } catch (requestError) {
      setError(toChineseError(requestError, '提现确认失败，请稍后重试'));
    } finally {
      setConfirming(false);
    }
  }, [code, draft?.withdrawId, loadData]);

  return (
    <AppScreen>
      <ActionHeader
        title="提现"
        subtitle="复用后端审核与邮箱验证码流程"
        onBack={() => navigation.goBack()}
        right={<RefreshButton disabled={loading} onPress={loadData} />}
      />

      {!isLoggedIn ? (
        <AuthRequiredCard onLoginPress={() => navigation.navigate('Auth', {screen: 'Login'})} />
      ) : loading ? (
        <StateCard title="正在加载提现配置" description="请稍候" />
      ) : error && options.length === 0 ? (
        <StateCard title="加载失败" description={error} actionTitle="重试" onActionPress={loadData} />
      ) : coinOptions.length === 0 ? (
        <StateCard title="暂无可提现网络" description="后台当前没有开启可提现的币种或网络。" />
      ) : (
        <>
          <ActionCard>
            <SelectChips label="币种" value={selectedCoin} options={coinOptions} onChange={changeCoin} />
            <SelectChips
              label="网络"
              value={selectedNetwork}
              options={networkOptions.map(item => ({
                value: item.chainKey,
                label: item.chainName || item.chainKey.toUpperCase(),
                meta: item.chainId ? String(item.chainId) : undefined,
              }))}
              onChange={changeNetwork}
            />
            <ActionTextField
              label="提现地址"
              value={address}
              onChangeText={value => {
                setAddress(value);
                resetFlow();
              }}
              placeholder="请输入外部收款地址"
            />
            {memoVisible ? (
              <ActionTextField
                label={selectedOption?.memoLabel || 'Memo/Tag'}
                value={memo}
                onChangeText={setMemo}
                placeholder="请输入 Memo/Tag"
              />
            ) : null}
            <ActionTextField
              label="数量"
              value={amount}
              keyboardType="decimal-pad"
              onChangeText={value => {
                setAmount(value.replace(/[^0-9.]/g, ''));
                resetFlow();
              }}
              placeholder="请输入提现数量"
              right={
                <SmallTextButton
                  title="全部"
                  onPress={() => {
                    setAmount(fundingBalance > 0 ? String(fundingBalance) : '');
                    resetFlow();
                  }}
                />
              }
            />
            <View style={styles.infoBlock}>
              <InfoRow label="资金账户可用" value={`${formatAmount(fundingBalance)} ${selectedCoin}`} />
              <InfoRow
                label="手续费"
                value={
                  feeLoading
                    ? '计算中...'
                    : fee?.fee
                      ? `${formatAmount(fee.fee)} ${fee.feeCoin || 'USDT'}`
                      : selectedOption?.withdrawFee
                        ? `${selectedOption.withdrawFee} USDT`
                        : '--'
                }
              />
              <InfoRow
                label="最小提现"
                value={
                  selectedOption?.minWithdraw
                    ? `${selectedOption.minWithdraw} ${selectedCoin}`
                    : '--'
                }
              />
              <InfoRow label="最大提现" value={`${formatAmount(fundingBalance)} ${selectedCoin}`} />
            </View>
            {selectedOption?.riskTip ? <InlineNotice>{selectedOption.riskTip}</InlineNotice> : null}
            {amountNumber > fundingBalance ? (
              <InlineNotice tone="red">资金账户可用余额不足</InlineNotice>
            ) : null}
            {error ? <InlineNotice tone="red">{error}</InlineNotice> : null}
            {message ? <InlineNotice tone="green">{message}</InlineNotice> : null}
            {step === 'form' ? (
              <View style={styles.buttonWrap}>
                <PrimaryButton
                  title={submitting ? '提交中...' : '提交提现申请'}
                  disabled={submitDisabled}
                  onPress={submitDraft}
                />
              </View>
            ) : null}
          </ActionCard>

          {draft ? (
            <ActionCard>
              <Text style={styles.cardTitle}>提现申请</Text>
              <InfoRow label="单号" value={String(draft.withdrawId)} />
              <InfoRow label="状态" value={mapWithdrawStatus(draft.status)} tone="gold" />
              <InfoRow label="币种" value={draft.symbol || selectedCoin} />
              <InfoRow label="网络" value={draft.chainKey || selectedNetwork} />
              <InfoRow label="地址" value={maskMiddle(draft.toAddress || address)} mono />
              <InfoRow label="数量" value={`${draft.amount || amount} ${draft.symbol || selectedCoin}`} />
              <InfoRow
                label="手续费"
                value={
                  draft.feeEstimate
                    ? `${draft.feeEstimate} ${draft.feeCoin || 'USDT'}`
                    : '--'
                }
              />
              {draft.riskReason ? <InlineNotice>{draft.riskReason}</InlineNotice> : null}
            </ActionCard>
          ) : null}

          {step === 'verify' && draft ? (
            <ActionCard>
              <Text style={styles.cardTitle}>邮箱验证</Text>
              <Text style={styles.desc}>
                获取验证码必须由你手动点击触发，验证码通过后后端会冻结余额并进入后续处理。
              </Text>
              <View style={styles.codeRow}>
                <PrimaryButton
                  title={
                    cooldown > 0
                      ? `${cooldown}s 后重发`
                      : codeSending
                        ? '发送中...'
                        : '发送验证码'
                  }
                  disabled={codeSending || cooldown > 0}
                  onPress={sendCode}
                />
              </View>
              <ActionTextField
                label="邮箱验证码"
                value={code}
                onChangeText={value => setCode(value.replace(/\D/g, '').slice(0, 6))}
                keyboardType="number-pad"
                placeholder="请输入验证码"
              />
              <View style={styles.buttonWrap}>
                <PrimaryButton
                  title={confirming ? '确认中...' : '确认提交'}
                  disabled={confirming || !code.trim()}
                  onPress={confirm}
                />
              </View>
            </ActionCard>
          ) : null}

          {step === 'done' && draft ? (
            <ActionCard>
              <Text style={styles.cardTitle}>当前结果</Text>
              <Text style={styles.resultText}>
                {message || `当前状态：${mapWithdrawStatus(draft.status)}`}
              </Text>
              <View style={styles.buttonWrap}>
                <PrimaryButton
                  title="继续提现"
                  variant="secondary"
                  onPress={() => {
                    setAmount('');
                    setAddress('');
                    setMemo('');
                    resetFlow();
                  }}
                />
              </View>
            </ActionCard>
          ) : null}
        </>
      )}
    </AppScreen>
  );
}

function isWithdrawOptionEnabled(item: AssetChainOption) {
  return (
    item.enabled !== false &&
    item.assetEnabled !== false &&
    item.chainEnabled !== false &&
    item.assetChainEnabled !== false &&
    item.withdrawEnabled !== false
  );
}

function mapWithdrawStatus(status: string) {
  const normalized = status.toUpperCase();
  if (normalized === 'REVIEWING') return '已提交审核';
  if (normalized === 'VERIFYING') return '待邮箱验证';
  if (normalized === 'FROZEN') return '已提交，待处理';
  if (normalized === 'PROCESSING' || normalized === 'SENDING') return '处理中';
  if (normalized === 'SENT' || normalized === 'SUCCESS') return '已完成';
  if (normalized === 'FAILED') return '失败';
  if (normalized === 'CANCELED' || normalized === 'CANCELLED') return '已取消';
  return status || '--';
}

const styles = StyleSheet.create({
  infoBlock: {
    marginTop: 12,
  },
  buttonWrap: {
    marginTop: 14,
  },
  cardTitle: {
    ...typography.bold,
    color: colors.text,
    fontSize: 15,
    marginBottom: 10,
  },
  desc: {
    color: colors.textMuted,
    fontSize: 12,
    lineHeight: 18,
  },
  codeRow: {
    marginTop: 12,
  },
  resultText: {
    color: colors.textMuted,
    fontSize: 13,
    lineHeight: 19,
  },
});
