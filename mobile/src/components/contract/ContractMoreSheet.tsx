import React from 'react';
import {Modal, Pressable, StyleSheet, Text, View} from 'react-native';
import {
  ArrowRightLeft,
  BookOpen,
  FileText,
  HelpCircle,
  ReceiptText,
  ShieldCheck,
  type LucideIcon,
} from 'lucide-react-native';
import {colors, typography} from '../../theme';

type Action = {
  label: string;
  Icon: LucideIcon;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  onActionPress: (label: string) => void;
};

const actions: Action[] = [
  {label: '资金划转', Icon: ArrowRightLeft},
  {label: '合约账户', Icon: ShieldCheck},
  {label: '订单', Icon: FileText},
  {label: '资金流水', Icon: ReceiptText},
  {label: '风险说明', Icon: BookOpen},
  {label: '帮助', Icon: HelpCircle},
];

function ContractMoreSheet({visible, onClose, onActionPress}: Props) {
  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}>
      <Pressable style={styles.overlay} onPress={onClose}>
        <Pressable style={styles.sheet}>
          <View style={styles.handle} />
          <Text style={styles.title}>合约更多</Text>
          <View style={styles.grid}>
            {actions.map(({label, Icon}) => (
              <Pressable
                key={label}
                style={styles.item}
                onPress={() => onActionPress(label)}>
                <View style={styles.iconWrap}>
                  <Icon color={colors.gold} size={18} strokeWidth={2.2} />
                </View>
                <Text style={styles.label}>{label}</Text>
              </Pressable>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

export default React.memo(ContractMoreSheet);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.58)',
  },
  sheet: {
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.card,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 26,
  },
  handle: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.line,
    marginBottom: 12,
  },
  title: {
    ...typography.bold,
    color: colors.text,
    fontSize: 16,
  },
  grid: {
    marginTop: 16,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  item: {
    width: '30.8%',
    minHeight: 76,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    backgroundColor: colors.cardAlt,
  },
  iconWrap: {
    width: 34,
    height: 34,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 17,
    backgroundColor: colors.primarySoft,
  },
  label: {
    marginTop: 8,
    color: colors.textMuted,
    fontSize: 11,
  },
});
